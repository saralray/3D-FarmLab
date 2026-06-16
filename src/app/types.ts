export type PrinterStatus = 'printing' | 'idle' | 'error' | 'offline' | 'paused';
export type PrinterProfile =
  | 'generic'
  | 'snapmaker_u1'
  | 'bambulab_a1_mini'
  | 'bambulab_h2s'
  | 'bambulab_h2d';

export interface Spool {
  id: string;
  color: string;
  material: string;
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
