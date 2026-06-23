import { PrintJob, Printer, PrinterProfile, PrinterProvider, PrinterStatus } from '../types';
import { normalizeMaxTwoDecimals } from './numberFormat';
import { logAuditEvent } from './auditApi';

export const PRINTER_STORAGE_KEY = 'printfarm_printers';

export const PRINTER_PROFILES: Record<
  PrinterProfile,
  {
    label: string;
    /** Vendor the profile belongs to; profiles are grouped by it in the UI. */
    provider: PrinterProvider;
    /** Display name for the provider group (e.g. "Bambu Lab"). */
    providerLabel: string;
    /** Model/series name shown within the provider group (e.g. "A1 Mini"). */
    series: string;
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
    provider: 'generic',
    providerLabel: 'Generic',
    series: 'Generic',
    statusPath: null,
    defaultModel: 'Custom Printer',
    buildBaseUrl: (ipAddress) => `http://${ipAddress}`,
    credentialLabel: 'API Key Header',
    credentialPlaceholder: 'X-API-Key: printer-secret',
    pollingDescription: 'Reachability check only (online / offline)',
  },
  snapmaker_u1: {
    label: 'Snapmaker U1',
    provider: 'snapmaker',
    providerLabel: 'Snapmaker',
    series: 'U1',
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
    provider: 'bambulab',
    providerLabel: 'Bambu Lab',
    series: 'A1 Mini',
    // Bambu printers report over MQTT, not HTTP — the poller handles it directly.
    statusPath: null,
    defaultModel: 'Bambu Lab A1 Mini',
    buildBaseUrl: (ipAddress) => `http://${ipAddress}`,
    credentialLabel: 'LAN Access Code',
    credentialPlaceholder: '8-digit access code from the printer screen',
    pollingDescription: 'Live status via MQTT over TLS (LAN mode)',
  },
  bambulab_h2s: {
    label: 'Bambu Lab H2S',
    provider: 'bambulab',
    providerLabel: 'Bambu Lab',
    series: 'H2S',
    // Same Bambu LAN protocol as the A1 Mini — MQTT report, no HTTP status.
    statusPath: null,
    defaultModel: 'Bambu Lab H2S',
    buildBaseUrl: (ipAddress) => `http://${ipAddress}`,
    credentialLabel: 'LAN Access Code',
    credentialPlaceholder: '8-digit access code from the printer screen',
    pollingDescription: 'Live status via MQTT over TLS (LAN mode)',
  },
  bambulab_h2d: {
    label: 'Bambu Lab H2D',
    provider: 'bambulab',
    providerLabel: 'Bambu Lab',
    series: 'H2D',
    // Same Bambu LAN protocol as the rest of the H2 series — MQTT report, no
    // HTTP status; the camera is RTSP-over-TLS (port 322) like the H2S/X1.
    statusPath: null,
    defaultModel: 'Bambu Lab H2D',
    buildBaseUrl: (ipAddress) => `http://${ipAddress}`,
    credentialLabel: 'LAN Access Code',
    credentialPlaceholder: '8-digit access code from the printer screen',
    pollingDescription: 'Live status via MQTT over TLS (LAN mode)',
  },
  bambulab_h2c: {
    label: 'Bambu Lab H2C',
    provider: 'bambulab',
    providerLabel: 'Bambu Lab',
    series: 'H2C',
    // Same Bambu LAN protocol as the rest of the H2 series — MQTT report, no
    // HTTP status; the camera is RTSP-over-TLS (port 322) like the H2D/X1. Like
    // the H2D it's dual-nozzle, but the right toolhead is the Vortek
    // hotend-change system (interchangeable induction hotends).
    statusPath: null,
    defaultModel: 'Bambu Lab H2C',
    buildBaseUrl: (ipAddress) => `http://${ipAddress}`,
    credentialLabel: 'LAN Access Code',
    credentialPlaceholder: '8-digit access code from the printer screen',
    pollingDescription: 'Live status via MQTT over TLS (LAN mode)',
  },
};

// The add-printer form presents profiles grouped by provider rather than as one
// flat list. This is derived from PRINTER_PROFILES (preserving its key order) so
// adding a new profile above is enough to make it appear in the dropdown.
export interface PrinterProfileOption {
  profile: PrinterProfile;
  series: string;
}

export interface PrinterProviderGroup {
  provider: PrinterProvider;
  providerLabel: string;
  options: PrinterProfileOption[];
}

export const PRINTER_PROVIDER_GROUPS: PrinterProviderGroup[] = (
  Object.entries(PRINTER_PROFILES) as [PrinterProfile, (typeof PRINTER_PROFILES)[PrinterProfile]][]
).reduce<PrinterProviderGroup[]>((groups, [profile, config]) => {
  let group = groups.find((entry) => entry.provider === config.provider);
  if (!group) {
    group = { provider: config.provider, providerLabel: config.providerLabel, options: [] };
    groups.push(group);
  }
  group.options.push({ profile, series: config.series });
  return groups;
}, []);

// Bambu Lab printers share one LAN integration (MQTT-over-TLS status/commands,
// FTPS upload, port-6000 camera), so feature checks key off this rather than a
// single model id.
export function isBambuProfile(profile: PrinterProfile): boolean {
  return (
    profile === 'bambulab_a1_mini' ||
    profile === 'bambulab_h2s' ||
    profile === 'bambulab_h2d' ||
    profile === 'bambulab_h2c'
  );
}

// A controllable cooling fan. `id` keys the poller's reported speed; `bambuPort`
// is the M106 P-index used over MQTT (Bambu only — Snapmaker has one part fan).
export interface FanDescriptor {
  id: string;
  label: string;
  bambuPort?: number;
}

// Which fans each profile exposes, in display order. Generic printers have no
// controllable fans, so they're absent and the cooling card is hidden for them.
export const PRINTER_FANS: Partial<Record<PrinterProfile, FanDescriptor[]>> = {
  snapmaker_u1: [{ id: 'part', label: 'Part Cooling' }],
  bambulab_a1_mini: [
    { id: 'part', label: 'Part Cooling', bambuPort: 1 },
    { id: 'aux', label: 'Auxiliary', bambuPort: 2 },
  ],
  bambulab_h2s: [
    { id: 'part', label: 'Part Cooling', bambuPort: 1 },
    { id: 'aux', label: 'Auxiliary', bambuPort: 2 },
    { id: 'chamber', label: 'Chamber', bambuPort: 3 },
  ],
  bambulab_h2d: [
    { id: 'part', label: 'Part Cooling', bambuPort: 1 },
    { id: 'aux', label: 'Auxiliary', bambuPort: 2 },
    { id: 'chamber', label: 'Chamber', bambuPort: 3 },
  ],
  bambulab_h2c: [
    { id: 'part', label: 'Part Cooling', bambuPort: 1 },
    { id: 'aux', label: 'Auxiliary', bambuPort: 2 },
    { id: 'chamber', label: 'Chamber', bambuPort: 3 },
  ],
};

// Profiles that report a chamber temperature sensor. Only the Bambu H2 series
// exposes one; other printers leave the chamber reading at 0, so the Temperature
// card hides the row for them.
export const PROFILES_WITH_CHAMBER_TEMP: PrinterProfile[] = [
  'bambulab_h2s',
  'bambulab_h2d',
  'bambulab_h2c',
];

export function profileHasChamberTemp(profile: PrinterProfile): boolean {
  return PROFILES_WITH_CHAMBER_TEMP.includes(profile);
}

// Per-nozzle display labels for multi-nozzle profiles, in tool-index order (the
// same order the poller reports nozzleTemperatures and the index sent as the
// temperature command's T-number). On the H2D tool 0 (T0) is the right nozzle and
// tool 1 (T1) the left — verified live; every other profile is single-nozzle and
// uses "Nozzle".
const PROFILE_NOZZLE_LABELS: Partial<Record<PrinterProfile, string[]>> = {
  bambulab_h2d: ['Right Nozzle', 'Left Nozzle'],
  // H2C: like the H2D, tool 0 (T0) is the right nozzle and tool 1 (T1) the left.
  // On the H2C the right toolhead is the Vortek hotend-change system.
  bambulab_h2c: ['Right Nozzle', 'Left Nozzle'],
};

export function getNozzleLabel(
  profile: PrinterProfile,
  index: number,
  count: number
): string {
  const labels = PROFILE_NOZZLE_LABELS[profile];
  if (labels && labels[index]) {
    return labels[index];
  }
  return count > 1 ? `Nozzle ${index + 1}` : 'Nozzle';
}

// Visual column order for multi-nozzle profiles, as tool indices. Tool index order
// drives the data and the temperature command's T-number, but the UI can present
// the nozzles in a different order. The H2D reports [right (T0), left (T1)]; we show
// the left nozzle first so the layout reads left-to-right like the physical printer.
const PROFILE_NOZZLE_DISPLAY_ORDER: Partial<Record<PrinterProfile, number[]>> = {
  bambulab_h2d: [1, 0],
  bambulab_h2c: [1, 0],
};

export function getNozzleDisplayOrder(
  profile: PrinterProfile,
  count: number
): number[] {
  const order = PROFILE_NOZZLE_DISPLAY_ORDER[profile];
  if (order) {
    return order.filter((index) => index < count);
  }
  return Array.from({ length: count }, (_, index) => index);
}

function inferProfileFromDescriptor(descriptor: string): PrinterProfile | null {
  if (descriptor.includes('snapmaker u1')) {
    return 'snapmaker_u1';
  }
  if (descriptor.includes('h2s')) {
    return 'bambulab_h2s';
  }
  if (descriptor.includes('h2d')) {
    return 'bambulab_h2d';
  }
  if (descriptor.includes('h2c')) {
    return 'bambulab_h2c';
  }
  if (descriptor.includes('bambu') || descriptor.includes('a1 mini')) {
    return 'bambulab_a1_mini';
  }
  return null;
}

function inferPrinterProfile(printer: Partial<Printer>): PrinterProfile {
  const profile = printer.profile;
  const descriptor = `${printer.name ?? ''} ${printer.model ?? ''}`.toLowerCase();

  if (profile === 'snapmaker_u1' || profile === 'generic' || isBambuProfile(profile)) {
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
  const fallbackChamberTemperature =
    typeof printer.temperature?.chamber === 'number'
      ? normalizeMaxTwoDecimals(printer.temperature.chamber)
      : undefined;

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
      ...(fallbackChamberTemperature !== undefined
        ? { chamber: fallbackChamberTemperature }
        : {}),
    },
    nozzleTemperatures:
      printer.nozzleTemperatures?.map((temperature) => normalizeMaxTwoDecimals(temperature)) ??
      (supportsLiveStatus ? [0, 0, 0, 0] : [fallbackNozzleTemperature]),
    nozzleTargets: printer.nozzleTargets?.map((target) => normalizeMaxTwoDecimals(target)),
    bedTarget:
      typeof printer.bedTarget === 'number' ? normalizeMaxTwoDecimals(printer.bedTarget) : undefined,
    chamberTarget:
      typeof printer.chamberTarget === 'number'
        ? normalizeMaxTwoDecimals(printer.chamberTarget)
        : undefined,
    fanSpeeds: printer.fanSpeeds?.map((fan) => ({
      id: fan.id,
      speed: Math.max(0, Math.min(100, normalizeMaxTwoDecimals(fan.speed))),
    })),
    progress: normalizeMaxTwoDecimals(printer.progress),
    lastMaintenance: printer.lastMaintenance ?? new Date().toISOString().slice(0, 10),
    totalPrintTime: normalizeMaxTwoDecimals(printer.totalPrintTime),
    successRate: normalizeMaxTwoDecimals(printer.successRate),
    spools,
    lightOn: printer.lightOn,
    airFilterOn: printer.airFilterOn,
    errorMessage: printer.errorMessage,
    totalPrintHours: printer.totalPrintHours,
    currentNozzleHours: printer.currentNozzleHours,
    healthScore: printer.healthScore,
    lastMaintenanceAt: printer.lastMaintenanceAt,
  };
}

// How many nozzles a printer has, derived from the actual nozzleTemperatures
// array when available (poller fills it per profile), or a profile-based
// fallback for printers not yet polled.
const PROFILE_DEFAULT_NOZZLE_COUNT: Partial<Record<PrinterProfile, number>> = {
  snapmaker_u1: 4,
  bambulab_h2d: 2,
  bambulab_h2c: 2,
};

export function getPrinterNozzleCount(printer: Partial<Printer>): number {
  if (printer.nozzleTemperatures && printer.nozzleTemperatures.length > 0) {
    return printer.nozzleTemperatures.length;
  }
  return PROFILE_DEFAULT_NOZZLE_COUNT[printer.profile as PrinterProfile] ?? 1;
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
    isBambuProfile(printer.profile)
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

  logAuditEvent('printer.command', printer.name, { command });
}

export function printerSupportsLight(printer: Printer) {
  return printer.profile === 'snapmaker_u1' || isBambuProfile(printer.profile);
}

export function printerSupportsTemperatureControl(printer: Printer) {
  return printer.profile === 'snapmaker_u1' || isBambuProfile(printer.profile);
}

// Set a heater's target temperature. Snapmaker U1 (Klipper/Moonraker) uses a
// gcode script; Bambu has no HTTP API, so the server publishes an MQTT
// gcode_line command. A target of 0 turns the heater off.
export async function setPrinterTemperature(
  printer: Printer,
  heater: 'nozzle' | 'bed' | 'chamber',
  target: number,
  nozzleIndex = 0,
) {
  const value = Math.round(target);
  // The chamber heater tops out far lower than the hotend/bed.
  const maxValue = heater === 'chamber' ? 60 : 350;
  if (!Number.isFinite(value) || value < 0 || value > maxValue) {
    throw new Error('Temperature target is out of range');
  }

  let response: Response;
  if (heater === 'chamber' && !isBambuProfile(printer.profile)) {
    throw new Error('Chamber temperature control is not available for this printer.');
  }
  if (isBambuProfile(printer.profile)) {
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

  logAuditEvent('printer.temperature', printer.name, { heater, target: value, nozzleIndex });
}

export function printerSupportsCoolingControl(printer: Printer) {
  return (PRINTER_FANS[printer.profile]?.length ?? 0) > 0;
}

// Set a cooling fan's speed (0–100%). Snapmaker U1 (Klipper/Moonraker) runs an
// M106/M107 gcode script over the proxy; Bambu has no HTTP API, so the server
// publishes the M106 as an MQTT gcode_line. A percent of 0 turns the fan off.
export async function setPrinterFanSpeed(
  printer: Printer,
  fan: FanDescriptor,
  percent: number,
) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (!Number.isFinite(clamped)) {
    throw new Error('Fan speed is out of range');
  }
  // Firmware fans take an 8-bit PWM value (0–255).
  const pwm = Math.round((clamped / 100) * 255);

  let response: Response;
  if (isBambuProfile(printer.profile)) {
    response = await fetch(`/api/printers/${encodeURIComponent(printer.id)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'set_fan', fanPort: fan.bambuPort, speed: pwm }),
    });
  } else if (printer.profile === 'snapmaker_u1') {
    const script = pwm === 0 ? 'M107' : `M106 S${pwm}`;
    response = await fetch(
      `/__printer_proxy/${encodeURIComponent(printer.id)}/printer/gcode/script?script=${encodeURIComponent(script)}`,
      { method: 'POST' },
    );
  } else {
    throw new Error('Cooling control is not available for this printer.');
  }

  if (!response.ok) {
    let message = `Fan command failed with ${response.status}`;

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

  logAuditEvent('printer.fan', printer.name, { fan: fan.id, percent: clamped });
}

// The H2 series doesn't expose the activated-carbon filter as a plain M106 fan.
// It routes chamber air through a mode-based "air duct" system controlled by the
// `set_airduct` MQTT command. Per BambuStudio (the "Filter" switch) and the
// Bambuddy project, the filter is a *submode* of cooling mode — not a separate
// mode: stay in cooling mode (modeId 0) and flip the submode (1 = filtration on,
// which redirects the right fan to filter chamber gas; 0 = off). modeId 1 is
// heating, 2 exhaust, 3 full cooling — not used here.
const H2_AIRDUCT_COOLING_MODE = 0;

export function printerSupportsAirFilter(printer: Printer) {
  return (
    printer.profile === 'bambulab_h2s' ||
    printer.profile === 'bambulab_h2d' ||
    printer.profile === 'bambulab_h2c'
  );
}

// Toggle the H2 air filter via the cooling-mode filtration submode.
export async function setPrinterAirFilter(printer: Printer, on: boolean) {
  if (!printerSupportsAirFilter(printer)) {
    throw new Error('Air filter control is not available for this printer.');
  }

  const response = await fetch(`/api/printers/${encodeURIComponent(printer.id)}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'set_airduct',
      modeId: H2_AIRDUCT_COOLING_MODE,
      submode: on ? 1 : 0,
    }),
  });

  if (!response.ok) {
    let message = `Air filter command failed with ${response.status}`;

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

  logAuditEvent('printer.airFilter', printer.name, { on });
}

export async function setPrinterLight(printer: Printer, on: boolean) {
  // Snapmaker U1 (Klipper/Moonraker) toggles its cavity LED via a gcode script;
  // Bambu has no HTTP API, so the server publishes an MQTT ledctrl command.
  let response: Response;
  if (isBambuProfile(printer.profile)) {
    response = await fetch(`/api/printers/${encodeURIComponent(printer.id)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: on ? 'light_on' : 'light_off' }),
    });
  } else if (printer.profile === 'snapmaker_u1') {
    // SYNC=0 applies the LED change immediately instead of queuing it behind the
    // gcode movement queue (the default SYNC=1). The U1's own screen also drives
    // cavity_led, so a queued change gets deferred/re-ordered against the
    // firmware's writes and the LED visibly blinks; applying it atomically wins.
    const script = `SET_LED LED=cavity_led WHITE=${on ? 1 : 0} SYNC=0`;
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

  logAuditEvent('printer.light', printer.name, { on });
}

export function printerSupportsFilamentControl(printer: Printer) {
  return printer.profile === 'snapmaker_u1' || isBambuProfile(printer.profile);
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
  if (isBambuProfile(printer.profile)) {
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

  logAuditEvent('printer.filament', printer.name, { action, slot, trayId });
}

export async function loadPrinterFilament(printer: Printer, slot: number, trayId?: number) {
  await sendFilamentCommand(printer, 'load', slot, trayId);
}

export async function unloadPrinterFilament(printer: Printer, slot: number, trayId?: number) {
  await sendFilamentCommand(printer, 'unload', slot, trayId);
}

// Filament materials offered by the "Edit filament" dialog. The server maps each
// to a generic Bambu profile (tray_info_idx) and nozzle temperature window.
export const FILAMENT_MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PC', 'PA', 'PVA'] as const;
export type FilamentMaterial = (typeof FILAMENT_MATERIALS)[number];

export function printerSupportsFilamentEdit(printer: Printer) {
  // Editable on every profile that exposes filament slots: Bambu (MQTT
  // ams_filament_setting) and the Snapmaker U1 (Klipper/AFC SET_MATERIAL +
  // SET_COLOR macros). Generic printers report no filament, so the edit UI never
  // surfaces for them.
  return printerSupportsFilamentControl(printer);
}

// Set the material and color the printer associates with a tray/lane. `slot` is
// the 1-based card index; `trayId` is the Bambu global tray id (unused by the
// Snapmaker path). Bambu sends an MQTT ams_filament_setting via the command
// endpoint; the Snapmaker U1 runs AFC SET_MATERIAL/SET_COLOR macros over the
// gcode proxy (lane E0–E3 == slot-1, mirroring the load/unload macros).
export async function setPrinterFilament(
  printer: Printer,
  slot: number,
  trayId: number | undefined,
  settings: { type: string; color: string },
) {
  if (!printerSupportsFilamentEdit(printer)) {
    throw new Error('Editing filament is not available for this printer.');
  }

  let response: Response;
  if (isBambuProfile(printer.profile)) {
    response = await fetch(`/api/printers/${encodeURIComponent(printer.id)}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'set_filament',
        trayId,
        type: settings.type,
        color: settings.color,
      }),
    });
  } else if (printer.profile === 'snapmaker_u1') {
    const lane = `E${Math.max(0, slot - 1)}`;
    const material = settings.type.toUpperCase().replace(/[^A-Z0-9+-]/g, '');
    const color = settings.color.replace('#', '').slice(0, 6).toUpperCase();
    // AFC stores material/color per lane; set both, then the card reflects them
    // on the next poll. Combined into one gcode proxy call (newline-separated).
    const script = `SET_MATERIAL LANE=${lane} MATERIAL=${material}\nSET_COLOR LANE=${lane} COLOR=${color}`;
    response = await fetch(
      `/__printer_proxy/${encodeURIComponent(printer.id)}/printer/gcode/script?script=${encodeURIComponent(script)}`,
      { method: 'POST' },
    );
  } else {
    throw new Error('Editing filament is not available for this printer.');
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

  logAuditEvent('printer.filament', printer.name, { action: 'edit', slot, trayId, ...settings });
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
  return printer.profile === 'snapmaker_u1' || isBambuProfile(printer.profile);
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
  if (isBambuProfile(printer.profile)) {
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

  logAuditEvent('printer.motion', printer.name);
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

// The H2 series exposes an RTSP-over-TLS camera the web server transcodes to a
// live MJPEG stream (multipart/x-mixed-replace) renderable in an <img>. The A1
// Mini's slow port-6000 camera can only do still snapshots, so it's excluded.
export function printerSupportsLiveMjpeg(printer: Printer) {
  return (
    printer.profile === 'bambulab_h2s' ||
    printer.profile === 'bambulab_h2d' ||
    printer.profile === 'bambulab_h2c'
  );
}

export function buildPrinterWebcamMjpegUrl(printer: Printer) {
  return `/__printer_webcam/${printer.id}/stream.mjpg`;
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
