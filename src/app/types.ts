export type PrinterStatus = 'printing' | 'idle' | 'error' | 'offline' | 'paused';
export type PrinterProfile =
  | 'generic'
  | 'snapmaker_u1'
  | 'bambulab_a1_mini'
  | 'bambulab_h2s'
  | 'bambulab_h2d'
  | 'bambulab_h2c';
// The brand/vendor a profile belongs to. Profiles are grouped by provider in the
// add-printer form so a long flat list reads as "pick a brand, then a model".
export type PrinterProvider = 'generic' | 'snapmaker' | 'bambulab';

export interface Spool {
  id: string;
  color: string;
  material: string;
  vendor?: string; // Brand/vendor label (Bambu tray_id_name); absent when unknown
  remaining: number; // percentage
  weight: number; // grams
}

export interface Printer {
  id: string;
  name: string;
  model: string;
  sortOrder?: number;
  profile: PrinterProfile;
  url: string;
  ipAddress: string;
  apiKeyHeader: string;
  serial?: string; // Bambu Lab printers: device serial for the MQTT report topic
  // H2-series Bambu printers only: LAN address (e.g. "http://192.168.1.50:8080")
  // this specific printer uses to fetch a staged print file back from
  // slicer-proxy over HTTP (their firmware refuses FTP writes). Overrides the
  // site-wide default set in Settings -> Slicer Upload -- needed when printers
  // sit on different subnets, since one global URL can't reach all of them.
  callbackUrl?: string;
  status: PrinterStatus;
  currentJob?: PrintJob;
  temperature: {
    nozzle: number;
    bed: number;
    // Chamber temperature, reported only by printers with a chamber sensor
    // (Bambu H2 series); 0 / absent for everything else.
    chamber?: number;
  };
  nozzleTemperatures?: number[];
  // Target temps reported by the printer, used to keep the set-temp inputs in
  // sync even when the target is changed from the printer screen or slicer.
  nozzleTargets?: number[];
  bedTarget?: number;
  // Chamber heater target (Bambu H2 series). 0 / absent means heating off.
  chamberTarget?: number;
  // Current cooling-fan speeds reported by the poller, keyed by fan id
  // ("part" / "aux" / "chamber"); speed is a 0–100 percentage. The set of fans
  // a printer has is static per profile (see PRINTER_FANS in printerProfiles).
  fanSpeeds?: { id: string; speed: number }[];
  progress: number;
  lastMaintenance: string;
  totalPrintTime: number; // hours
  successRate: number; // percentage
  spools?: Spool[]; // Optional multi-spool support
  lightOn?: boolean; // Last-known chamber/cavity light state (Bambu reports it over MQTT)
  airFilterOn?: boolean; // Last-known H2 air-filter state (from the airduct filtration submode)
  // Human-readable description of the printer's current fault, set by the poller
  // per profile (Bambu HMS faults, Moonraker print error, or an unreachable
  // connection). Absent/empty when the printer is healthy.
  errorMessage?: string;
  // Preventive-maintenance accounting (see lib/maintenanceApi). totalPrintHours is
  // lifetime accrued print time; currentNozzleHours resets on a nozzle service;
  // healthScore (0-100) is recomputed by the web worker.
  totalPrintHours?: number;
  currentNozzleHours?: number;
  healthScore?: number;
  lastMaintenanceAt?: string | null;
}

export interface PrintJob {
  id: string;
  filename: string;
  fileCount?: number;
  printedStatus?: 0 | 1;
  printerId?: string;
  status: 'queued' | 'printing' | 'completed' | 'failed' | 'paused';
  progress: number;
  estimatedTime: number; // minutes
  timeRemaining: number; // minutes
  printingTime: number; // minutes
  filamentUsed: number; // grams
  // Slicer's total filament estimate for the job (grams), when a print was
  // started through the slicer-proxy. Used to show "used / total".
  estimatedFilament?: number;
  startTime?: string;
  endTime?: string;
  priority: 'low' | 'medium' | 'high';
  stlFileUrl?: string; // Download URL for the stored model file (or external link)
  hasFile?: boolean; // True when the model file is stored in the database
  submitterName?: string; // From the print-request form
  submitterEmail?: string; // From the print-request form
  notes?: string; // From the print-request form
  submittedAt?: string; // Submission timestamp
}

export interface AnalyticsData {
  date: string;
  completedJobs: number;
  failedJobs: number;
  printTime: number;
  filamentUsed: number;
}

export interface QueueData {
  queue: PrintJob[];
  history: PrintJob[];
}
