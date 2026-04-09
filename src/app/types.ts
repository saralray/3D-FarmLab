export type PrinterStatus = 'printing' | 'idle' | 'error' | 'offline' | 'paused';
export type PrinterProfile = 'generic' | 'snapmaker_u1';

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
  status: PrinterStatus;
  currentJob?: PrintJob;
  temperature: {
    nozzle: number;
    bed: number;
  };
  nozzleTemperatures?: number[];
  progress: number;
  lastMaintenance: string;
  totalPrintTime: number; // hours
  successRate: number; // percentage
  spools?: Spool[]; // Optional multi-spool support
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
  filamentUsed: number; // grams
  startTime?: string;
  endTime?: string;
  priority: 'low' | 'medium' | 'high';
  stlFileUrl?: string; // URL or path to STL file
  submitterName?: string; // From Google Form
  submitterEmail?: string; // From Google Form
  notes?: string; // From Google Form
  submittedAt?: string; // Timestamp from Google Form
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
