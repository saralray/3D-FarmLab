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
  const { ESPLoader, Transport, UsbJtagSerialReset } = await import('esptool-js');
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
    // Reboot out of the bootloader into the freshly flashed app. The C3
    // Super Mini has no external UART bridge — it uses the SoC's native
    // USB-Serial/JTAG controller — so esptool-js's default 'hard_reset' (an
    // RTS-pin toggle meant for boards with a CP2102/CH340 auto-reset
    // circuit) has no effect: the chip stays parked in the ROM bootloader,
    // never boots the just-flashed app, and provisioning then times out
    // forever waiting for a device that's still sitting in the bootloader.
    // Detect that PID (same check esptool-js's own connect logic uses) and
    // send its matching reset sequence instead.
    if (transport.getPid() === loader.USB_JTAG_SERIAL_PID) {
      await new UsbJtagSerialReset(transport).reset();
    } else {
      await loader.after('hard_reset');
    }
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

// Mirrors the firmware's `net` field in its `{"cmd":"status"}` reply
// (firmware/status-light/src/provisioning.cpp).
export type NetConnectionState = 'idle' | 'wifi-connecting' | 'mqtt-connecting' | 'connected';

export interface ProvisionResult {
  ok: boolean;
  error?: string;
  printerId?: string;
  // Last-known connection state from the post-provision health check; absent
  // if provisioning itself failed.
  net?: NetConnectionState;
}

export interface ProvisionOptions {
  // How long to wait for the provisioning ack itself.
  timeoutMs?: number;
  // How long, after a successful ack, to keep polling {"cmd":"status"} for
  // the device to actually reach the broker — a saved config only proves the
  // firmware accepted the JSON, not that the WiFi password or broker
  // credentials are correct.
  healthCheckMs?: number;
  // Fired with each status poll's net state (including intermediate ones)
  // while the health check runs.
  onStatus?: (net: NetConnectionState) => void;
}

// Sends one provisioning JSON line, waits for the firmware's ack line, then
// polls {"cmd":"status"} until the device reports it's connected or the
// health-check window runs out. The firmware accepts `provision` at any time
// (fresh flash or re-provision).
export async function provisionDevice(
  port: SerialPortLike,
  config: ProvisioningConfig,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const { timeoutMs = 20000, healthCheckMs = 15000, onStatus } = options;
  await port.open({ baudRate: 115200 });
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();
  if (!writer || !reader) {
    await port.close().catch(() => {});
    throw new Error('Serial port is not readable/writable.');
  }

  const decoder = new TextDecoder();
  let buffered = '';

  // Reads lines until one parses as a JSON object with a boolean `ok` field
  // (any of provision/status/clear acks), or `deadline` passes.
  const readReply = async (deadline: number): Promise<Record<string, unknown> | null> => {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
          setTimeout(() => resolve({ done: true }), remaining),
        ),
      ]);
      if (chunk.done && !chunk.value) {
        return null;
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
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (typeof parsed.ok === 'boolean') {
            return parsed;
          }
        } catch {
          // Partial or non-ack JSON — keep reading.
        }
      }
    }
    return null;
  };

  try {
    // Give the C3's native USB CDC a moment after (re)open — writes issued in
    // the same tick as open() are dropped by some adapters, and right after a
    // flash the CDC interface is still finishing its re-enumeration.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await writer.write(new TextEncoder().encode(`${JSON.stringify({ cmd: 'provision', ...config })}\n`));

    const ack = await readReply(Date.now() + timeoutMs);
    if (!ack) {
      return { ok: false, error: 'Timed out waiting for the device to confirm. Check the wiring and retry.' };
    }
    if (ack.ok !== true) {
      return {
        ok: false,
        error: typeof ack.error === 'string' ? ack.error : 'The device rejected the configuration.',
      };
    }
    const printerId = typeof ack.printerId === 'string' ? ack.printerId : undefined;

    let net: NetConnectionState = 'idle';
    const healthDeadline = Date.now() + healthCheckMs;
    while (Date.now() < healthDeadline) {
      await writer.write(new TextEncoder().encode(`${JSON.stringify({ cmd: 'status' })}\n`));
      const status = await readReply(Math.min(Date.now() + 2000, healthDeadline));
      if (status && typeof status.net === 'string') {
        net = status.net as NetConnectionState;
        onStatus?.(net);
        if (net === 'connected') {
          break;
        }
      }
      if (Date.now() >= healthDeadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    return { ok: true, printerId, net };
  } finally {
    reader.releaseLock();
    writer.releaseLock();
    await port.close().catch(() => {});
  }
}
