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
  // Optional in the spec surface we model; real Web Serial ports have it.
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
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
  // Fired with every raw text chunk received over serial during provisioning
  // (boot banner, debug lines, JSON replies). Diagnostic hook — lets the UI
  // or console surface exactly what the device emitted when something fails.
  onRaw?: (text: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Sends the provisioning JSON line, waits for the firmware's ack, then polls
// {"cmd":"status"} until the device reports it's connected or the health-check
// window runs out. The firmware accepts `provision` at any time (fresh flash
// or re-provision).
//
// A single background read pump feeds a shared line queue — never two
// concurrent reader.read() calls (that throws), and it captures every byte for
// diagnostics. The provision command is re-sent on an interval rather than
// once: right after a flash the C3's USB CDC is still settling and its app may
// boot a beat late, so the first write can land before anything is listening.
export async function provisionDevice(
  port: SerialPortLike,
  config: ProvisioningConfig,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const { timeoutMs = 20000, healthCheckMs = 15000, onStatus, onRaw } = options;
  await port.open({ baudRate: 115200 });
  // The ESP32-C3 has no USB-UART bridge — Serial is the SoC's native
  // USB-Serial/JTAG (HWCDC), which stays mute until the host asserts DTR to
  // mark the terminal "connected". Web Serial's open() leaves DTR deasserted,
  // so without this the device never transmits and provisioning sees zero
  // bytes. A steady DTR (RTS held low) signals "connected" without pulsing EN,
  // so it does not reset the running app. Best-effort: some adapters reject it.
  await port.setSignals?.({ dataTerminalReady: true, requestToSend: false }).catch(() => {});
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();
  if (!writer || !reader) {
    await port.close().catch(() => {});
    throw new Error('Serial port is not readable/writable.');
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const write = (obj: unknown) => writer.write(encoder.encode(`${JSON.stringify(obj)}\n`));

  // Background reader: pumps the serial stream into a line queue and records
  // everything seen, so nothing else ever touches reader.read() directly.
  const lineQueue: string[] = [];
  let rawBuffer = '';
  let rawCharCount = 0;
  let pumpDone = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const text = decoder.decode(value, { stream: true });
        rawCharCount += text.length;
        onRaw?.(text);
        rawBuffer += text;
        let newline = rawBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = rawBuffer.slice(0, newline).trim();
          rawBuffer = rawBuffer.slice(newline + 1);
          newline = rawBuffer.indexOf('\n');
          if (line) lineQueue.push(line);
        }
      }
    } catch {
      // reader.cancel() during teardown, or the device dropped — either way the
      // pump is done and the outer logic already has (or will hit) its deadline.
    } finally {
      pumpDone = true;
    }
  })();

  // Drains queued lines for the next JSON ack (an object with a boolean `ok`),
  // waiting up to `deadline`. Non-JSON boot/debug lines are ignored.
  const nextAck = async (deadline: number): Promise<Record<string, unknown> | null> => {
    for (;;) {
      while (lineQueue.length > 0) {
        const line = lineQueue.shift() as string;
        if (!line.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (typeof parsed.ok === 'boolean') return parsed;
        } catch {
          // Partial/non-ack JSON — keep draining.
        }
      }
      if (Date.now() >= deadline || pumpDone) return null;
      await sleep(50);
    }
  };

  try {
    // Give the C3's native USB CDC a moment after (re)open — writes issued in
    // the same tick as open() are dropped by some adapters, and right after a
    // flash the CDC interface is still finishing its re-enumeration.
    await sleep(1000);

    // Re-send provision until the device acks or the overall timeout passes.
    let ack: Record<string, unknown> | null = null;
    const ackDeadline = Date.now() + timeoutMs;
    while (Date.now() < ackDeadline && !ack) {
      await write({ cmd: 'provision', ...config });
      ack = await nextAck(Math.min(Date.now() + 3000, ackDeadline));
    }

    if (!ack) {
      // Distinguish a silent device (nothing at all came back — usually still
      // in the bootloader because the post-flash reboot didn't take, or the
      // wrong USB port) from one that's talking but never acked (likely
      // different firmware on the chip).
      const error =
        rawCharCount === 0
          ? 'No response from the device over USB. If you just flashed it, the board may still be in the ' +
            'bootloader — unplug and replug the ESP32, then use "Re-provision only". Otherwise check the ' +
            'USB cable and that you picked the right serial port.'
          : "The device is sending data but never confirmed the settings — it may be running different " +
            'firmware than the status light. Reflash it, then try again.';
      return { ok: false, error };
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
      await write({ cmd: 'status' });
      const status = await nextAck(Math.min(Date.now() + 2000, healthDeadline));
      if (status && typeof status.net === 'string') {
        net = status.net as NetConnectionState;
        onStatus?.(net);
        if (net === 'connected') break;
      }
      if (Date.now() >= healthDeadline) break;
      await sleep(1500);
    }

    return { ok: true, printerId, net };
  } finally {
    await reader.cancel().catch(() => {});
    await pump;
    reader.releaseLock();
    writer.releaseLock();
    await port.close().catch(() => {});
  }
}
