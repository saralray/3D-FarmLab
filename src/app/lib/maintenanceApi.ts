// Client helpers for the preventive-maintenance API. Fetch logic lives here (not
// in pages), mirroring printersApi/queueApi. The backend accrues print hours as
// jobs finish, auto-creates pending events on interval crossings, and recomputes
// each printer's health score every 5 minutes.
import { logAuditEvent } from './auditApi';

export type MaintenanceStatus = 'pending' | 'completed';

export interface MaintenanceEvent {
  id: string;
  printerId: string;
  maintenanceType: string;
  intervalHours: number | null;
  triggeredAtHours: number | null;
  completedAtHours: number | null;
  status: MaintenanceStatus;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
  // Present on pending tasks returned by the per-printer summary.
  overdue?: boolean;
}

export interface MaintenanceNextService {
  type: string;
  intervalHours: number;
  remainingHours: number;
}

export interface PrinterMaintenance {
  printerId: string;
  printerName: string;
  totalHours: number;
  nozzleHours: number;
  healthScore: number;
  healthStatus: HealthStatus;
  lastMaintenanceAt: string | null;
  pendingTasks: MaintenanceEvent[];
  completedTasks: MaintenanceEvent[];
  nextService: MaintenanceNextService | null;
}

export interface MaintenanceSummary {
  printersRequiringMaintenance: number;
  overdueTasks: number;
  averageHealth: number;
  totalFleetHours: number;
  printerCount: number;
}

export interface MaintenanceNotification {
  id: string;
  printerId: string | null;
  kind: 'due' | 'overdue' | 'health';
  title: string;
  body: string | null;
  read: boolean;
  createdAt: string;
}

export interface MaintenanceInterval {
  type: string;
  intervalHours: number;
  description: string;
}

export type HealthStatus = 'Excellent' | 'Good' | 'Warning' | 'Service Required';

// Health band → presentation. Mirrors healthStatusFromScore on the server.
export function healthStatusFromScore(score: number): HealthStatus {
  if (score >= 90) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Warning';
  return 'Service Required';
}

export type MaintenanceBadge = 'healthy' | 'due-soon' | 'overdue';

// The Green / Yellow / Red badge for a printer, from its pending tasks.
export function maintenanceBadge(pending: MaintenanceEvent[]): MaintenanceBadge {
  if (pending.some((task) => task.overdue)) return 'overdue';
  if (pending.length > 0) return 'due-soon';
  return 'healthy';
}

// Same grace window the server uses (10% of the interval, min 10h) so a task's
// due/overdue state is identical whether it's computed here or server-side.
export function overdueGraceHours(intervalHours: number | null): number {
  return Math.max((intervalHours ?? 0) * 0.1, 10);
}

// The flat /api/maintenance list doesn't carry the `overdue` flag (only the
// per-printer summary does), so compute it from the owning printer's total hours.
export function isEventOverdue(event: MaintenanceEvent, totalPrintHours: number): boolean {
  return totalPrintHours >= (event.triggeredAtHours ?? 0) + overdueGraceHours(event.intervalHours);
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const noStore: RequestInit = {
  cache: 'no-store',
  headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
};

export async function fetchMaintenanceSummary(): Promise<MaintenanceSummary> {
  return readJson<MaintenanceSummary>(await fetch('/api/maintenance/summary', noStore));
}

export interface MaintenanceFilters {
  printer?: string;
  status?: MaintenanceStatus;
  type?: string;
}

export async function fetchMaintenanceEvents(filters: MaintenanceFilters = {}): Promise<MaintenanceEvent[]> {
  const params = new URLSearchParams();
  if (filters.printer) params.set('printer', filters.printer);
  if (filters.status) params.set('status', filters.status);
  if (filters.type) params.set('type', filters.type);
  const qs = params.toString();
  return readJson<MaintenanceEvent[]>(await fetch(`/api/maintenance${qs ? `?${qs}` : ''}`, noStore));
}

export async function fetchPrinterMaintenance(printerId: string): Promise<PrinterMaintenance | null> {
  const response = await fetch(`/api/printers/${encodeURIComponent(printerId)}/maintenance`, noStore);
  if (response.status === 404) return null;
  return readJson<PrinterMaintenance>(response);
}

export async function completeMaintenanceTask(id: string, notes: string): Promise<MaintenanceEvent> {
  const event = await readJson<MaintenanceEvent>(
    await fetch(`/api/maintenance/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    }),
  );
  logAuditEvent('maintenance.complete', `${event.maintenanceType} (${event.printerId})`, { notes });
  return event;
}

export async function fetchMaintenanceNotifications(unreadOnly = false): Promise<MaintenanceNotification[]> {
  const qs = unreadOnly ? '?unread=true' : '';
  return readJson<MaintenanceNotification[]>(await fetch(`/api/maintenance/notifications${qs}`, noStore));
}

export async function markMaintenanceNotificationsRead(ids?: string[]): Promise<void> {
  await fetch('/api/maintenance/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ids ? { ids } : {}),
  });
}

export async function fetchMaintenanceIntervals(): Promise<MaintenanceInterval[]> {
  return readJson<MaintenanceInterval[]>(await fetch('/api/settings/maintenance-intervals', noStore));
}

export async function saveMaintenanceIntervals(intervals: MaintenanceInterval[]): Promise<MaintenanceInterval[]> {
  const saved = await readJson<MaintenanceInterval[]>(
    await fetch('/api/settings/maintenance-intervals', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intervals),
    }),
  );
  logAuditEvent('maintenance.intervals.update', `${intervals.length} intervals`);
  return saved;
}
