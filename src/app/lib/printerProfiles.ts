import { PrintJob, Printer, PrinterProfile, PrinterStatus } from '../types';

export const PRINTER_STORAGE_KEY = 'printfarm_printers';

export const PRINTER_PROFILES: Record<
  PrinterProfile,
  {
    label: string;
    statusPath: string | null;
    defaultModel: string;
    buildBaseUrl: (ipAddress: string) => string;
  }
> = {
  generic: {
    label: 'Generic',
    statusPath: null,
    defaultModel: 'Custom Printer',
    buildBaseUrl: (ipAddress) => `http://${ipAddress}`,
  },
  snapmaker_u1: {
    label: 'Snapmaker U1',
    statusPath:
      '/printer/objects/query?print_stats&extruder=temperature,target&extruder1=temperature,target&extruder2=temperature,target&extruder3=temperature,target&heater_bed=temperature,target',
    defaultModel: 'Snapmaker U1',
    buildBaseUrl: (ipAddress) => `http://${ipAddress}`,
  },
};

function inferPrinterProfile(printer: Partial<Printer>): PrinterProfile {
  const profile = printer.profile;
  if (profile === 'snapmaker_u1' || profile === 'generic') {
    const descriptor = `${printer.name ?? ''} ${printer.model ?? ''}`.toLowerCase();
    if (profile === 'generic' && descriptor.includes('snapmaker u1')) {
      return 'snapmaker_u1';
    }
    return profile;
  }

  const descriptor = `${printer.name ?? ''} ${printer.model ?? ''}`.toLowerCase();
  if (descriptor.includes('snapmaker u1')) {
    return 'snapmaker_u1';
  }

  return 'generic';
}

export function normalizePrinter(printer: Partial<Printer>, index: number): Printer {
  const profile = inferPrinterProfile(printer);
  const url =
    printer.url ??
    (printer.ipAddress && printer.ipAddress !== '0.0.0.0' ? `http://${printer.ipAddress}` : '');

  return {
    id: printer.id ?? `printer-${index + 1}`,
    name: printer.name ?? `Printer ${index + 1}`,
    model: printer.model ?? PRINTER_PROFILES[profile].defaultModel,
    profile,
    url,
    ipAddress: printer.ipAddress ?? '0.0.0.0',
    apiKeyHeader: printer.apiKeyHeader ?? '',
    status: printer.status ?? 'offline',
    currentJob: printer.currentJob,
    temperature: printer.temperature ?? { nozzle: 0, bed: 0 },
    nozzleTemperatures: printer.nozzleTemperatures ?? [printer.temperature?.nozzle ?? 0],
    progress: printer.progress ?? 0,
    lastMaintenance: printer.lastMaintenance ?? new Date().toISOString().slice(0, 10),
    totalPrintTime: printer.totalPrintTime ?? 0,
    successRate: printer.successRate ?? 0,
    spools: printer.spools,
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

function buildCurrentJob(printStats: Record<string, unknown> | undefined): PrintJob | undefined {
  if (!printStats) {
    return undefined;
  }

  const state = typeof printStats.state === 'string' ? printStats.state : undefined;
  const filename = typeof printStats.filename === 'string' ? printStats.filename : undefined;
  if (!filename || !state || state === 'standby' || state === 'complete' || state === 'cancelled') {
    return undefined;
  }

  return {
    id: `job-${filename}`,
    filename,
    status: state === 'paused' ? 'paused' : state === 'error' ? 'failed' : 'printing',
    progress: 0,
    estimatedTime: 0,
    timeRemaining: 0,
    filamentUsed:
      typeof printStats.filament_used === 'number' ? Math.round(printStats.filament_used) : 0,
    priority: 'medium',
  };
}

export async function fetchPrinterLiveStatus(printer: Printer): Promise<Partial<Printer>> {
  const profileConfig = PRINTER_PROFILES[printer.profile];
  if (!profileConfig.statusPath) {
    return {};
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
  const state = typeof printStats?.state === 'string' ? printStats.state : undefined;
  const nozzleTemperatures = extruders.map((extruder, index) =>
    typeof extruder?.temperature === 'number'
      ? Math.round(extruder.temperature)
      : printer.nozzleTemperatures?.[index] ?? printer.temperature.nozzle
  );
  const bedTemperature =
    typeof heaterBed?.temperature === 'number'
      ? Math.round(heaterBed.temperature)
      : printer.temperature.bed;

  return {
    status: mapPrintStateToStatus(state),
    currentJob: buildCurrentJob(printStats),
    progress: 0,
    temperature: {
      nozzle: nozzleTemperatures[0] ?? printer.temperature.nozzle,
      bed: bedTemperature,
    },
    nozzleTemperatures,
  };
}

export function buildPrinterWebcamUrl(printer: Printer) {
  return `/__printer_proxy/${printer.id}/webcam/player`;
}
