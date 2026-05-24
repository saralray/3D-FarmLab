import { PrintJob, Printer, PrinterProfile, PrinterStatus } from '../types';
import { normalizeMaxTwoDecimals } from './numberFormat';

export const PRINTER_STORAGE_KEY = 'printfarm_printers';

export const PRINTER_PROFILES: Record<
  PrinterProfile,
  {
    label: string;
    statusPath: string | null;
    defaultModel: string;
    buildBaseUrl: (ipAddress: string) => string;
    /** Human label for the secret field — not every profile uses an HTTP header. */
    credentialLabel: string;
    credentialPlaceholder: string;
    /** How the poller obtains live status, shown in the add-printer form. */
    pollingDescription: string;
  }
> = {
  generic: {
    label: 'Generic',
    statusPath: null,
    defaultModel: 'Custom Printer',
    buildBaseUrl: (ipAddress) => `http://${ipAddress}`,
    credentialLabel: 'API Key Header',
    credentialPlaceholder: 'X-API-Key: printer-secret',
    pollingDescription: 'Reachability check only (online / offline)',
  },
  snapmaker_u1: {
    label: 'Snapmaker U1',
    statusPath:
      '/printer/objects/query?print_stats&extruder=temperature,target&extruder1=temperature,target&extruder2=temperature,target&extruder3=temperature,target&heater_bed=temperature,target&virtual_sdcard=progress',
    defaultModel: 'Snapmaker U1',
    buildBaseUrl: (ipAddress) => `http://${ipAddress}`,
    credentialLabel: 'API Key Header',
    credentialPlaceholder: 'X-API-Key: printer-secret',
    pollingDescription: 'Live status via Moonraker HTTP API',
  },
  bambulab_a1_mini: {
    label: 'Bambu Lab A1 Mini',
    // Bambu printers report over MQTT, not HTTP — the poller handles it directly.
    statusPath: null,
    defaultModel: 'Bambu Lab A1 Mini',
    buildBaseUrl: (ipAddress) => `http://${ipAddress}`,
    credentialLabel: 'LAN Access Code',
    credentialPlaceholder: '8-digit access code from the printer screen',
    pollingDescription: 'Live status via MQTT over TLS (LAN mode)',
  },
};

function inferProfileFromDescriptor(descriptor: string): PrinterProfile | null {
  if (descriptor.includes('snapmaker u1')) {
    return 'snapmaker_u1';
  }
  if (descriptor.includes('bambu') || descriptor.includes('a1 mini')) {
    return 'bambulab_a1_mini';
  }
  return null;
}

function inferPrinterProfile(printer: Partial<Printer>): PrinterProfile {
  const profile = printer.profile;
  const descriptor = `${printer.name ?? ''} ${printer.model ?? ''}`.toLowerCase();

  if (profile === 'snapmaker_u1' || profile === 'generic' || profile === 'bambulab_a1_mini') {
    // Upgrade legacy entries saved as "generic" that name a known printer.
    if (profile === 'generic') {
      return inferProfileFromDescriptor(descriptor) ?? profile;
    }
    return profile;
  }

  return inferProfileFromDescriptor(descriptor) ?? 'generic';
}

export function normalizePrinter(printer: Partial<Printer>, index: number): Printer {
  const profile = inferPrinterProfile(printer);
  const url =
    printer.url ??
    (printer.ipAddress && printer.ipAddress !== '0.0.0.0' ? `http://${printer.ipAddress}` : '');
  const supportsLiveStatus = PRINTER_PROFILES[profile].statusPath !== null;
  const fallbackNozzleTemperature = normalizeMaxTwoDecimals(printer.temperature?.nozzle);
  const fallbackBedTemperature = normalizeMaxTwoDecimals(printer.temperature?.bed);

  const currentJob = printer.currentJob
    ? {
        ...printer.currentJob,
        progress: normalizeMaxTwoDecimals(printer.currentJob.progress),
        estimatedTime: normalizeMaxTwoDecimals(printer.currentJob.estimatedTime),
        timeRemaining: normalizeMaxTwoDecimals(printer.currentJob.timeRemaining),
        printingTime: normalizeMaxTwoDecimals(printer.currentJob.printingTime),
        filamentUsed: normalizeMaxTwoDecimals(printer.currentJob.filamentUsed),
      }
    : undefined;
  const spools = printer.spools?.map((spool) => ({
    ...spool,
    remaining: normalizeMaxTwoDecimals(spool.remaining),
    weight: normalizeMaxTwoDecimals(spool.weight),
  }));

  return {
    id: printer.id ?? `printer-${index + 1}`,
    name: printer.name ?? `Printer ${index + 1}`,
    model: printer.model ?? PRINTER_PROFILES[profile].defaultModel,
    profile,
    url,
    ipAddress: printer.ipAddress ?? '0.0.0.0',
    apiKeyHeader: printer.apiKeyHeader ?? '',
    serial: printer.serial ?? '',
    status: printer.status ?? 'offline',
    currentJob,
    temperature: {
      nozzle: fallbackNozzleTemperature,
      bed: fallbackBedTemperature,
    },
    nozzleTemperatures:
      printer.nozzleTemperatures?.map((temperature) => normalizeMaxTwoDecimals(temperature)) ??
      (supportsLiveStatus ? [0, 0, 0, 0] : [fallbackNozzleTemperature]),
    nozzleTargets: printer.nozzleTargets?.map((target) => normalizeMaxTwoDecimals(target)),
    bedTarget:
      typeof printer.bedTarget === 'number' ? normalizeMaxTwoDecimals(printer.bedTarget) : undefined,
    progress: normalizeMaxTwoDecimals(printer.progress),
    lastMaintenance: printer.lastMaintenance ?? new Date().toISOString().slice(0, 10),
    totalPrintTime: normalizeMaxTwoDecimals(printer.totalPrintTime),
    successRate: normalizeMaxTwoDecimals(printer.successRate),
    spools,
    lightOn: printer.lightOn,
  };
}

export function readStoredPrinters(fallbackPrinters: Printer[]): Printer[] {
  const rawValue = localStorage.getItem(PRINTER_STORAGE_KEY);
  if (!rawValue) {
    localStorage.setItem(PRINTER_STORAGE_KEY, JSON.stringify(fallbackPrinters));
    return fallbackPrinters;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<Printer>[];
    if (!Array.isArray(parsed)) {
      throw new Error('Invalid printers');
    }
    return parsed.map(normalizePrinter);
  } catch {
    localStorage.setItem(PRINTER_STORAGE_KEY, JSON.stringify(fallbackPrinters));
    return fallbackPrinters;
  }
}

function parseApiKeyHeader(apiKeyHeader: string, profile: PrinterProfile) {
  const separatorIndex = apiKeyHeader.indexOf(':');
  if (separatorIndex === -1) {
    const trimmedValue = apiKeyHeader.trim();
    if (!trimmedValue) {
      return null;
    }

    if (profile === 'snapmaker_u1') {
      return { 'X-API-Key': trimmedValue };
    }

    return null;
  }

  const name = apiKeyHeader.slice(0, separatorIndex).trim();
  const value = apiKeyHeader.slice(separatorIndex + 1).trim();

  if (!name || !value) {
    return null;
  }

  return { [name]: value };
}

function mapPrintStateToStatus(state: string | undefined): PrinterStatus {
  switch (state) {
    case 'printing':
      return 'printing';
    case 'paused':
      return 'paused';
    case 'error':
      return 'error';
    case 'standby':
    case 'complete':
    case 'cancelled':
      return 'idle';
    default:
      return 'idle';
  }
}

function getReachableGenericStatus(printer: Printer): PrinterStatus {
  if (printer.currentJob?.status === 'paused' || printer.status === 'paused') {
    return 'paused';
  }

  if (printer.currentJob?.status === 'printing' || printer.status === 'printing') {
    return 'printing';
  }

  if (printer.status === 'error') {
    return 'error';
  }

  return 'idle';
}

function buildCurrentJob(
  printStats: Record<string, unknown> | undefined,
  progress: number,
): PrintJob | undefined {
  if (!printStats) {
    return undefined;
  }

  const state = typeof printStats.state === 'string' ? printStats.state : undefined;
  const filename = typeof printStats.filename === 'string' ? printStats.filename : undefined;
  if (!filename || !state || state === 'standby' || state === 'complete' || state === 'cancelled') {
    return undefined;
  }
  const printDuration =
    typeof printStats.print_duration === 'number' ? printStats.print_duration : 0;
  const printingTime = printDuration > 0 ? Math.max(0, Math.round(printDuration / 60)) : 0;
  const estimatedTime =
    printDuration > 0 && progress > 0
      ? Math.max(1, Math.round((printDuration / Math.max(progress / 100, 0.01)) / 60))
      : 0;
  const timeRemaining =
    printDuration > 0 && progress > 0
      ? Math.max(0, Math.round(((printDuration / Math.max(progress / 100, 0.01)) - printDuration) / 60))
      : 0;

  return {
    id: `job-${filename}`,
    filename,
    status: state === 'paused' ? 'paused' : state === 'error' ? 'failed' : 'printing',
    progress,
    estimatedTime,
    timeRemaining,
    printingTime,
    filamentUsed:
      typeof printStats.filament_used === 'number'
        ? Math.round(((printStats.filament_used / 1000) * 3) * 10) / 10
        : 0,
    priority: 'medium',
  };
}

export async function fetchPrinterLiveStatus(printer: Printer): Promise<Partial<Printer>> {
  const profileConfig = PRINTER_PROFILES[printer.profile];
  if (!profileConfig.statusPath) {
    const response = await fetch(`/__printer_proxy/${printer.id}/`);

    if (!response.ok) {
      throw new Error(`Reachability request failed with ${response.status}`);
    }

    return {
      status: getReachableGenericStatus(printer),
    };
  }

  const response = await fetch(`/__printer_proxy/${printer.id}${profileConfig.statusPath}`);

  if (!response.ok) {
    throw new Error(`Status request failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    result?: {
      status?: {
        print_stats?: Record<string, unknown>;
        extruder?: Record<string, unknown>;
        extruder1?: Record<string, unknown>;
        extruder2?: Record<string, unknown>;
        extruder3?: Record<string, unknown>;
        heater_bed?: Record<string, unknown>;
        virtual_sdcard?: Record<string, unknown>;
      };
    };
  };

  const status = data.result?.status;
  const printStats = status?.print_stats;
  const extruders = [
    status?.extruder,
    status?.extruder1,
    status?.extruder2,
    status?.extruder3,
  ];
  const heaterBed = status?.heater_bed;
  const virtualSdCard = status?.virtual_sdcard;
  const state = typeof printStats?.state === 'string' ? printStats.state : undefined;

  if (!status || !printStats) {
    throw new Error('Printer did not return the expected status JSON');
  }

  const nozzleTemperatures = extruders.map((extruder, index) =>
    typeof extruder?.temperature === 'number'
      ? Math.round(extruder.temperature)
      : printer.nozzleTemperatures?.[index] ?? printer.temperature.nozzle
  );
  const bedTemperature =
    typeof heaterBed?.temperature === 'number'
      ? Math.round(heaterBed.temperature)
      : printer.temperature.bed;
  const progress =
    typeof virtualSdCard?.progress === 'number'
      ? Math.max(0, Math.min(100, Math.round(virtualSdCard.progress * 100)))
      : 0;

  return {
    status: mapPrintStateToStatus(state),
    currentJob: buildCurrentJob(printStats, progress),
    progress,
    temperature: {
      nozzle: nozzleTemperatures[0] ?? printer.temperature.nozzle,
      bed: bedTemperature,
    },
    nozzleTemperatures,
  };
}

export async function sendPrinterCommand(
  printer: Printer,
  command: 'pause' | 'resume' | 'cancel'
) {
  // Bambu printers have no HTTP control API — the server publishes the command
  // over MQTT instead. Other profiles use the Moonraker HTTP proxy.
  const response =
    printer.profile === 'bambulab_a1_mini'
      ? await fetch(`/api/printers/${encodeURIComponent(printer.id)}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command }),
        })
      : await fetch(`/__printer_proxy/${printer.id}/printer/print/${command}`, {
          method: 'POST',
        });

  if (!response.ok) {
    let message = `Printer command failed with ${response.status}`;

    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // Ignore non-JSON proxy responses.
    }

    throw new Error(message);
  }
}

export function printerSupportsLight(printer: Printer) {
  return printer.profile === 'snapmaker_u1' || printer.profile === 'bambulab_a1_mini';
}

export function printerSupportsTemperatureControl(printer: Printer) {
  return printer.profile === 'snapmaker_u1' || printer.profile === 'bambulab_a1_mini';
}

// Set a heater's target temperature. Snapmaker U1 (Klipper/Moonraker) uses a
// gcode script; Bambu has no HTTP API, so the server publishes an MQTT
// gcode_line command. A target of 0 turns the heater off.
export async function setPrinterTemperature(
  printer: Printer,
  heater: 'nozzle' | 'bed',
  target: number,
  nozzleIndex = 0,
) {
  const value = Math.round(target);
  if (!Number.isFinite(value) || value < 0 || value > 350) {
    throw new Error('Temperature target is out of range');
  }

  let response: Response;
  if (printer.profile === 'bambulab_a1_mini') {
    response = await fetch(`/api/printers/${encodeURIComponent(printer.id)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'set_temperature', heater, target: value, nozzleIndex }),
    });
  } else if (printer.profile === 'snapmaker_u1') {
    // Klipper names extra extruders extruder1, extruder2, … (the first is just "extruder").
    const klipperHeater =
      heater === 'nozzle'
        ? nozzleIndex > 0
          ? `extruder${nozzleIndex}`
          : 'extruder'
        : 'heater_bed';
    const script = `SET_HEATER_TEMPERATURE HEATER=${klipperHeater} TARGET=${value}`;
    response = await fetch(
      `/__printer_proxy/${encodeURIComponent(printer.id)}/printer/gcode/script?script=${encodeURIComponent(script)}`,
      { method: 'POST' },
    );
  } else {
    throw new Error('Temperature control is not available for this printer.');
  }

  if (!response.ok) {
    let message = `Temperature command failed with ${response.status}`;

    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // Ignore non-JSON proxy responses.
    }

    throw new Error(message);
  }
}

export async function setPrinterLight(printer: Printer, on: boolean) {
  // Snapmaker U1 (Klipper/Moonraker) toggles its cavity LED via a gcode script;
  // Bambu has no HTTP API, so the server publishes an MQTT ledctrl command.
  let response: Response;
  if (printer.profile === 'bambulab_a1_mini') {
    response = await fetch(`/api/printers/${encodeURIComponent(printer.id)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: on ? 'light_on' : 'light_off' }),
    });
  } else if (printer.profile === 'snapmaker_u1') {
    const script = `SET_LED LED=cavity_led WHITE=${on ? 1 : 0}`;
    response = await fetch(
      `/__printer_proxy/${encodeURIComponent(printer.id)}/printer/gcode/script?script=${encodeURIComponent(script)}`,
      { method: 'POST' },
    );
  } else {
    throw new Error('Light control is not available for this printer.');
  }

  if (!response.ok) {
    let message = `Light command failed with ${response.status}`;

    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // Ignore non-JSON proxy responses.
    }

    throw new Error(message);
  }
}

export function printerSupportsFilamentControl(printer: Printer) {
  return printer.profile === 'snapmaker_u1' || printer.profile === 'bambulab_a1_mini';
}

// Load or unload filament for one tool/tray. Snapmaker U1 (Klipper/Moonraker)
// runs LOAD_FILAMENT/UNLOAD_FILAMENT macros over the gcode proxy; Bambu A1 Mini
// has no HTTP API, so the server publishes an MQTT ams_change_filament. `slot`
// is the 1-based card index; `trayId` is the Bambu global tray id (AMS unit * 4
// + tray, or 254 for the external spool).
async function sendFilamentCommand(
  printer: Printer,
  action: 'load' | 'unload',
  slot: number,
  trayId?: number,
) {
  let response: Response;
  if (printer.profile === 'bambulab_a1_mini') {
    response = await fetch(`/api/printers/${encodeURIComponent(printer.id)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: action === 'load' ? 'load_filament' : 'unload_filament',
        trayId,
      }),
    });
  } else if (printer.profile === 'snapmaker_u1') {
    // The U1 drives its 4-lane AFC (Automated Filament Changer) through Klipper
    // macros keyed by lane name E0–E3; the card slot is 1-based, so lane = E(slot-1).
    // CHANGE_TOOL feeds/loads a lane (AUTO_FEEDING … LOAD=1); LANE_UNLOAD retracts it.
    const lane = `E${Math.max(0, slot - 1)}`;
    const script =
      action === 'load' ? `CHANGE_TOOL LANE=${lane}` : `LANE_UNLOAD LANE=${lane}`;
    response = await fetch(
      `/__printer_proxy/${encodeURIComponent(printer.id)}/printer/gcode/script?script=${encodeURIComponent(script)}`,
      { method: 'POST' },
    );
  } else {
    throw new Error('Filament control is not available for this printer.');
  }

  if (!response.ok) {
    let message = `Filament command failed with ${response.status}`;

    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // Ignore non-JSON proxy responses.
    }

    throw new Error(message);
  }
}

export async function loadPrinterFilament(printer: Printer, slot: number, trayId?: number) {
  await sendFilamentCommand(printer, 'load', slot, trayId);
}

export async function unloadPrinterFilament(printer: Printer, slot: number, trayId?: number) {
  await sendFilamentCommand(printer, 'unload', slot, trayId);
}

export type MotionAxis = 'x' | 'y' | 'z';

// Step sizes (mm) offered by the manual jog controls.
export const MOTION_STEP_OPTIONS = [0.1, 1, 10, 100] as const;

// Conservative manual-jog feedrates (mm/min); Z moves slower to protect the
// lead screw and gantry.
const MOTION_FEEDRATE_MM_PER_MIN: Record<MotionAxis, number> = {
  x: 3000,
  y: 3000,
  z: 600,
};

export function printerSupportsMotionControl(printer: Printer) {
  return printer.profile === 'snapmaker_u1' || printer.profile === 'bambulab_a1_mini';
}

// Klipper (Snapmaker) and Bambu firmware both accept the same standard G-code,
// so the jog program is built once here and routed per profile below. The move
// is wrapped in relative mode (G91) and restored to absolute (G90) so a later
// print or home isn't thrown off.
function buildJogGcode(axis: MotionAxis, distance: number) {
  return `G91\nG1 ${axis.toUpperCase()}${distance} F${MOTION_FEEDRATE_MM_PER_MIN[axis]}\nG90`;
}

// Route a motion G-code program to the printer: Snapmaker over the Moonraker
// HTTP proxy, Bambu as an MQTT gcode_line published by the web server (which
// only accepts a safe motion subset for the `gcode` command).
async function sendMotionGcode(printer: Printer, gcode: string) {
  let response: Response;
  if (printer.profile === 'bambulab_a1_mini') {
    response = await fetch(`/api/printers/${encodeURIComponent(printer.id)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'gcode', gcode }),
    });
  } else if (printer.profile === 'snapmaker_u1') {
    response = await fetch(
      `/__printer_proxy/${encodeURIComponent(printer.id)}/printer/gcode/script?script=${encodeURIComponent(gcode)}`,
      { method: 'POST' },
    );
  } else {
    throw new Error('Motion control is not available for this printer.');
  }

  if (!response.ok) {
    let message = `Motion command failed with ${response.status}`;

    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // Ignore non-JSON proxy responses.
    }

    throw new Error(message);
  }
}

// Jog one axis by a signed distance (mm) relative to its current position.
export async function movePrinterAxis(printer: Printer, axis: MotionAxis, distance: number) {
  const normalized = Math.round(distance * 100) / 100;
  if (!Number.isFinite(normalized) || normalized === 0 || Math.abs(normalized) > 250) {
    throw new Error('Jog distance is out of range');
  }
  await sendMotionGcode(printer, buildJogGcode(axis, normalized));
}

// Home the printer (G28 homes every axis on both Klipper and Bambu firmware).
export async function homePrinterAxes(printer: Printer, axes: 'all' | MotionAxis = 'all') {
  await sendMotionGcode(printer, axes === 'all' ? 'G28' : `G28 ${axes.toUpperCase()}`);
}

// Release the steppers so the axes can be moved by hand (M84).
export async function disablePrinterMotors(printer: Printer) {
  await sendMotionGcode(printer, 'M84');
}

export function buildPrinterWebcamUrl(printer: Printer) {
  return `/__printer_webcam/${printer.id}/player`;
}

export function buildPrinterWebcamSnapshotUrl(printer: Printer) {
  return `/__printer_webcam/${printer.id}/snapshot.jpg`;
}

// Snapmaker U1 serves a real-time webcam player at /webcam/player — an H264
// stream muxed into a <video> via jmuxer, with its own snapshot fallback. It's
// far lighter and lower-latency than MJPEG, so we embed it directly. Bambu has
// no HTTP stream (snapshot-only TLS socket) and generic printers have no
// webcam, so only Snapmaker gets the live player.
export function printerSupportsWebcamStream(printer: Printer) {
  return printer.profile === 'snapmaker_u1';
}

export function buildPrinterWebcamPlayerUrl(printer: Printer) {
  return `/__printer_webcam/${printer.id}/player`;
}

export function buildOfflinePrinterState(printer: Printer): Partial<Printer> {
  return {
    status: 'offline',
    currentJob: undefined,
    progress: 0,
    temperature: { nozzle: 0, bed: 0 },
    nozzleTemperatures:
      printer.nozzleTemperatures && printer.nozzleTemperatures.length > 0
        ? printer.nozzleTemperatures.map(() => 0)
        : [0],
  };
}
