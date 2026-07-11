// Web Serial glue for the ESP32 status-light flash & provision flow. Flashing
// uses esptool-js (lazy-imported so its ~large chunk stays out of the main
// bundle — it is only pulled in when an admin actually opens the flash
// dialog); provisioning is a plain 115200-baud JSON line exchange with the
// firmware (see firmware/status-light/README.md for the serial protocol).
//
// Web Serial is Chromium-only and requires a secure context (HTTPS or
// localhost) — callers must gate on isWebSerialSupported() and show a notice.

import type { LedPolarity, MqttTransport } from './statusLightApi';

// Minimal Web Serial surface (the DOM lib in this project doesn't ship the
// w3c-web-serial types); only what this module touches.
export interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

type NavigatorSerial = Navigator & {
  serial?: { requestPort(): Promise<SerialPortLike> };
};

export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean((navigator as NavigatorSerial).serial);
}

// Prompts the browser's serial-port picker. Throws if the user cancels.
export async function requestSerialPort(): Promise<SerialPortLike> {
  const serial = (navigator as NavigatorSerial).serial;
  if (!serial) {
    throw new Error('Web Serial is not supported in this browser (use Chrome or Edge over HTTPS).');
  }
  return serial.requestPort();
}

export interface FlashProgress {
  written: number;
  total: number;
}

// Writes the merged firmware image at offset 0x0. Owns the esptool transport
// for the duration and fully releases the port before resolving, so the same
// port can immediately be reopened at 115200 for provisioning.
export async function flashFirmware(
  port: SerialPortLike,
  firmware: ArrayBuffer,
  onProgress: (progress: FlashProgress) => void,
): Promise<void> {
  const { ESPLoader, Transport } = await import('esptool-js');
  // esptool-js's own types come from w3c-web-serial; our minimal port shape is
  // structurally the same object the browser returned.
  const transport = new Transport(port as unknown as ConstructorParameters<typeof Transport>[0]);
  try {
    const loader = new ESPLoader({
      transport,
      baudrate: 460800,
      terminal: {
        clean: () => {},
        writeLine: () => {},
        write: () => {},
      },
    });
    await loader.main();
    await loader.writeFlash({
      fileArray: [{ data: new Uint8Array(firmware), address: 0 }],
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex, written, total) => onProgress({ written, total }),
    });
    // Reboot out of the bootloader into the freshly flashed app.
    await loader.after('hard_reset');
  } finally {
    // Close streams + port no matter what, so a retry or the provisioning
    // step doesn't hit "port already open".
    await transport.disconnect().catch(() => {});
  }
}

export interface ProvisioningConfig {
  wifiSsid: string;
  wifiPassword: string;
  mqttTransport: MqttTransport;
  mqttHost: string;
  mqttPort: number;
  mqttPath: string;
  mqttUsername: string;
  mqttPassword: string;
  printerId: string;
  ledPolarity: LedPolarity;
}

export interface ProvisionResult {
  ok: boolean;
  error?: string;
  printerId?: string;
}

// Sends one provisioning JSON line and waits for the firmware's ack line.
// The firmware accepts this at any time (fresh flash or re-provision).
export async function provisionDevice(
  port: SerialPortLike,
  config: ProvisioningConfig,
  timeoutMs = 10000,
): Promise<ProvisionResult> {
  await port.open({ baudRate: 115200 });
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();
  if (!writer || !reader) {
    await port.close().catch(() => {});
    throw new Error('Serial port is not readable/writable.');
  }

  try {
    // Give the C3's USB CDC a moment after (re)open — writes issued in the
    // same tick as open() are dropped by some adapters.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writer.write(new TextEncoder().encode(`${JSON.stringify({ cmd: 'provision', ...config })}\n`));

    const decoder = new TextDecoder();
    let buffered = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
          setTimeout(() => resolve({ done: true }), remaining),
        ),
      ]);
      if (chunk.done && !chunk.value) {
        break;
      }
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (!line.startsWith('{')) {
          continue; // boot logs / debug output
        }
        try {
          const parsed = JSON.parse(line) as ProvisionResult;
          if (typeof parsed.ok === 'boolean') {
            return parsed;
          }
        } catch {
          // Partial or non-ack JSON — keep reading.
        }
      }
    }
    return { ok: false, error: 'Timed out waiting for the device to confirm. Check the wiring and retry.' };
  } finally {
    reader.releaseLock();
    writer.releaseLock();
    await port.close().catch(() => {});
  }
}
