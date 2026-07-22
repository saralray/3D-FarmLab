// Web Serial glue for the ESP32 status-light flash & provision flow. Flashing
// uses esptool-js (lazy-imported so its ~large chunk stays out of the main
// bundle — it is only pulled in when an admin actually opens the flash
// dialog); provisioning is a plain 115200-baud JSON line exchange with the
// firmware (see firmware/status-light/README.md for the serial protocol).
// Structurally mirrors the standalone 3D-FarmLab-Status-Light web flasher's
// proven connect → flash → provision flow (retry-on-busy connect, one-shot
// provisioning send) — the wire protocol differs (this firmware replies
// {"ok":...}, not the standalone's {"status":...}), so the JSON parsing below
// is specific to firmware/status-light/src/provisioning.cpp.
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

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Matches the standalone flasher's isPortBusy() check.
const isPortBusy = (err: unknown): boolean =>
  /failed to open|already open|access denied|busy/i.test(String(err instanceof Error ? err.message : err));

// esptool-js types come from w3c-web-serial; our minimal port shape is
// structurally the same object the browser returned.
type EsptoolTransport = InstanceType<Awaited<typeof import('esptool-js')>['Transport']>;
type EsptoolLoader = InstanceType<Awaited<typeof import('esptool-js')>['ESPLoader']>;

export interface DeviceConnection {
  transport: EsptoolTransport;
  loader: EsptoolLoader;
  chipName: string;
}

// Opens the ROM bootloader connection and syncs the chip (baud change to
// 460800 happens inside loader.main()). Mirrors the standalone flasher's
// connect(): the port can be momentarily held by the OS right after the
// browser grants it (on Linux, ModemManager probes new USB-serial devices for
// ~15s), so retry a few times on a "busy" error before giving up.
export async function connectToDevice(port: SerialPortLike): Promise<DeviceConnection> {
  const { ESPLoader, Transport } = await import('esptool-js');
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const transport = new Transport(port as unknown as ConstructorParameters<typeof Transport>[0]);
    const loader = new ESPLoader({
      transport,
      baudrate: 460800,
      terminal: { clean: () => {}, writeLine: () => {}, write: () => {} },
    });
    try {
      const chipName = await loader.main();
      return { transport, loader, chipName };
    } catch (err) {
      await transport.disconnect().catch(() => {});
      lastErr = err;
      if (isPortBusy(err) && attempt < MAX_ATTEMPTS) {
        await sleep(4000);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface FlashProgress {
  written: number;
  total: number;
}

// Writes the merged firmware image at offset 0x0 on an already-connected
// device (see connectToDevice) and resets it into the freshly flashed app.
// On success the transport is disconnected (clean handoff to the plain
// provisioning link); on failure it is left open so the caller can retry the
// same connection with one click, matching the standalone flasher's
// leniency — esptool protocol hiccups are often a retry away from working,
// and re-picking the device from the OS/browser dialog each time is friction
// the standalone doesn't impose either.
export async function flashOnDevice(
  { transport, loader }: DeviceConnection,
  firmware: ArrayBuffer,
  onProgress: (progress: FlashProgress) => void,
): Promise<void> {
  // esptool-js's writeFlash wants each file's `data` as a binary (Latin-1)
  // *string* — one char per byte — not a Uint8Array. Passing a typed array
  // silently flashes garbage / fails, so build the binary string in chunks
  // (a single String.fromCharCode(...bigArray) overflows the call stack).
  const bytes = new Uint8Array(firmware);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  await loader.writeFlash({
    fileArray: [{ data: binary, address: 0 }],
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
  const { UsbJtagSerialReset } = await import('esptool-js');
  if (transport.getPid() === loader.USB_JTAG_SERIAL_PID) {
    await new UsbJtagSerialReset(transport).reset();
  } else {
    await loader.after('hard_reset');
  }
  await transport.disconnect().catch(() => {});
}

// Force-closes then reopens the port for a fresh, unlocked read/write stream,
// retrying while the USB stack settles after a flash/reset. Mirrors the
// standalone flasher's reopenSerialPort(): esptool-js's transport can leave
// the port open with locked streams, and right after a reset the C3's native
// USB CDC is still re-enumerating, so a single open() attempt is unreliable.
export async function openWithRetry(
  port: SerialPortLike,
  baudRate: number,
  attempts = 10,
  delayMs = 400,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await port.close().catch(() => {}); // wasn't open — ignore
    try {
      await port.open({ baudRate });
      return true;
    } catch {
      // not ready yet — wait and retry
    }
    await sleep(delayMs);
  }
  return false;
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

export interface ProvisionOptions {
  // How long to wait for the device's JSON reply after sending the
  // provisioning command.
  timeoutMs?: number;
  // Fired with every raw text chunk received over serial (boot banner, debug
  // lines, JSON replies). Diagnostic hook — lets the UI or console surface
  // exactly what the device emitted when something fails.
  onRaw?: (text: string) => void;
}

// Opens the plain provisioning link, sends the provisioning JSON line once,
// and waits for the firmware's single JSON reply — mirrors the standalone
// flasher's sendCommand(): one write, one wait, no re-send loop and no
// post-ack polling. This firmware's reply carries a boolean `ok` field (see
// firmware/status-light/src/provisioning.cpp), unlike the standalone repo's
// firmware which replies with a `status` string — the two are not
// interchangeable.
export async function provisionDevice(
  port: SerialPortLike,
  config: ProvisioningConfig,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const { timeoutMs = 15000, onRaw } = options;

  const opened = await openWithRetry(port, 115200);
  if (!opened) {
    return { ok: false, error: 'Could not open the serial port after flashing. Unplug and replug the ESP32, then use "Re-provision only".' };
  }
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
    return { ok: false, error: 'Serial port is not readable/writable.' };
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let rawCharCount = 0;
  let awaitingResolve: ((line: Record<string, unknown>) => void) | null = null;

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const text = decoder.decode(value, { stream: true });
        rawCharCount += text.length;
        onRaw?.(text);
        lineBuffer += text;
        let newline = lineBuffer.search(/[\r\n]/);
        while (newline >= 0) {
          const line = lineBuffer.slice(0, newline).trim();
          lineBuffer = lineBuffer.slice(newline + 1);
          newline = lineBuffer.search(/[\r\n]/);
          if (line.startsWith('{') && awaitingResolve) {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (typeof parsed.ok === 'boolean') {
                const resolve = awaitingResolve;
                awaitingResolve = null;
                resolve(parsed);
              }
            } catch {
              // not the reply we're waiting for
            }
          }
        }
      }
    } catch {
      // reader.cancel() during teardown, or the device dropped.
    }
  })();

  try {
    // Give the C3's native USB CDC a moment after (re)open before writing —
    // writes issued in the same tick as open() are dropped by some adapters.
    await sleep(300);
    await writer.write(encoder.encode(`${JSON.stringify({ cmd: 'provision', ...config })}\n`));

    const ack = await new Promise<Record<string, unknown> | null>((resolve) => {
      awaitingResolve = resolve;
      setTimeout(() => {
        if (awaitingResolve === resolve) {
          awaitingResolve = null;
          resolve(null);
        }
      }, timeoutMs);
    });

    if (!ack) {
      return {
        ok: false,
        error:
          rawCharCount === 0
            ? 'No response from the device over USB. If you just flashed it, the board may still be in the ' +
              'bootloader — unplug and replug the ESP32, then use "Re-provision only". Otherwise check the ' +
              'USB cable and that you picked the right serial port.'
            : 'The device is sending data but never confirmed the settings — it may be running different ' +
              'firmware than the status light. Reflash it, then try again.',
      };
    }
    if (ack.ok !== true) {
      return {
        ok: false,
        error: typeof ack.error === 'string' ? ack.error : 'The device rejected the configuration.',
      };
    }
    return { ok: true, printerId: typeof ack.printerId === 'string' ? ack.printerId : undefined };
  } finally {
    await reader.cancel().catch(() => {});
    await pump;
    reader.releaseLock();
    writer.releaseLock();
    await port.close().catch(() => {});
  }
}

export interface SerialMonitorHandle {
  // Cancels the read loop and releases + closes the port.
  stop(): Promise<void>;
}

// Read-only serial monitor: opens the port at 115200, asserts DTR (the C3's
// native USB-CDC stays mute until the host marks the terminal "connected" — the
// same reason provisionDevice does it), and streams the device's newline-
// delimited output to `onLine`. No writes — this never sends anything to the
// device. Kept separate from provisionDevice so the (fragile) flash/provision
// path is untouched.
export async function startSerialMonitor(
  port: SerialPortLike,
  onLine: (line: string) => void,
): Promise<SerialMonitorHandle> {
  const opened = await openWithRetry(port, 115200);
  if (!opened) {
    throw new Error('Could not open the serial port.');
  }
  await port.setSignals?.({ dataTerminalReady: true, requestToSend: false }).catch(() => {});
  const reader = port.readable?.getReader();
  if (!reader) {
    await port.close().catch(() => {});
    throw new Error('Serial port is not readable.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let stopped = false;

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          onLine(line);
        }
      }
    } catch {
      // reader.cancel() during stop(), or the device was unplugged — either way
      // the loop is done and stop() (if pending) resolves.
    }
  })();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
      await port.close().catch(() => {});
    },
  };
}
