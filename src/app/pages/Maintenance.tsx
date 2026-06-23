import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wrench,
  AlertTriangle,
  Activity,
  Clock,
  CheckCircle,
  History,
  Gauge,
} from 'lucide-react';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Textarea } from '../components/ui/textarea';
import { usePrinters } from '../contexts/PrintersContext';
import { useAuth } from '../contexts/AuthContext';
import { isReadOnlyRole } from '../lib/usersApi';
import { formatMaxTwoDecimals } from '../lib/numberFormat';
import { toast } from 'sonner';
import {
  fetchMaintenanceSummary,
  fetchMaintenanceEvents,
  completeMaintenanceTask,
  isEventOverdue,
  healthStatusFromScore,
  type MaintenanceEvent,
  type MaintenanceSummary,
  type HealthStatus,
} from '../lib/maintenanceApi';
import { getPrinterNozzleCount } from '../lib/printerProfiles';

const REFRESH_INTERVAL_MS = 15000;

function healthBadgeClass(status: HealthStatus): string {
  switch (status) {
    case 'Excellent':
      return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
    case 'Good':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'Warning':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    default:
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
  }
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Wrench;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${tone}`}>
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs text-gray-500 dark:text-gray-400">{label}</p>
          <p className="text-xl font-semibold text-gray-900 dark:text-gray-100">{value}</p>
        </div>
      </div>
    </Card>
  );
}

export function Maintenance() {
  const { printers } = usePrinters();
  const { user } = useAuth();
  const readOnly = isReadOnlyRole(user?.role);

  const [summary, setSummary] = useState<MaintenanceSummary | null>(null);
  const [pending, setPending] = useState<MaintenanceEvent[]>([]);
  const [history, setHistory] = useState<MaintenanceEvent[]>([]);
  const [completeTarget, setCompleteTarget] = useState<MaintenanceEvent | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const printerById = useMemo(() => {
    const map = new Map<string, (typeof printers)[number]>();
    for (const printer of printers) map.set(printer.id, printer);
    return map;
  }, [printers]);

  const refresh = useCallback(async () => {
    try {
      const [summaryData, pendingData, historyData] = await Promise.all([
        fetchMaintenanceSummary(),
        fetchMaintenanceEvents({ status: 'pending' }),
        fetchMaintenanceEvents({ status: 'completed' }),
      ]);
      setSummary(summaryData);
      setPending(pendingData);
      setHistory(historyData);
    } catch {
      // Keep the last good snapshot on a transient failure.
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const printerName = (id: string) => printerById.get(id)?.name ?? id;
  const printerHours = (id: string) => Number(printerById.get(id)?.totalPrintTime ?? 0);

  // Pending tasks split into overdue (red) and due (yellow), overdue first.
  const classified = useMemo(() => {
    return pending
      .map((event) => ({ event, overdue: isEventOverdue(event, printerHours(event.printerId)) }))
      .sort((a, b) => Number(b.overdue) - Number(a.overdue));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, printerById]);

  const handleComplete = async () => {
    if (!completeTarget) return;
    setSubmitting(true);
    try {
      await completeMaintenanceTask(completeTarget.id, notes.trim());
      toast.success('Maintenance task completed');
      setCompleteTarget(null);
      setNotes('');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to complete task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div className="flex items-center gap-3">
        <Wrench className="size-6 text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Maintenance</h1>
      </div>

      {/* Fleet summary widgets */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          icon={Wrench}
          label="Printers Requiring Maintenance"
          value={`${summary?.printersRequiringMaintenance ?? 0}`}
          tone="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
        />
        <SummaryCard
          icon={AlertTriangle}
          label="Overdue Maintenance Tasks"
          value={`${summary?.overdueTasks ?? 0}`}
          tone="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
        />
        <SummaryCard
          icon={Activity}
          label="Average Farm Health"
          value={`${summary?.averageHealth ?? 0}`}
          tone="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
        />
        <SummaryCard
          icon={Clock}
          label="Total Fleet Print Hours"
          value={formatMaxTwoDecimals(summary?.totalFleetHours ?? 0)}
          tone="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
        />
      </div>

      {/* Pending / overdue tasks */}
      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
          <h2 className="font-medium text-gray-900 dark:text-gray-100">Pending &amp; Overdue Tasks</h2>
          <span className="ml-auto text-sm text-gray-500 dark:text-gray-400">{classified.length}</span>
        </div>
        {classified.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400">No pending maintenance tasks.</p>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {classified.map(({ event, overdue }) => (
              <div key={event.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{event.maintenanceType}</span>
                    {overdue ? (
                      <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                        Maintenance Overdue
                      </Badge>
                    ) : (
                      <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                        Maintenance Due Soon
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {printerName(event.printerId)} · every {formatMaxTwoDecimals(event.intervalHours ?? 0)}h · triggered at{' '}
                    {formatMaxTwoDecimals(event.triggeredAtHours ?? 0)}h
                  </p>
                </div>
                {!readOnly && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setCompleteTarget(event);
                      setNotes('');
                    }}
                  >
                    <CheckCircle className="size-4" />
                    Complete
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Per-printer health */}
      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <Gauge className="size-4 text-gray-600 dark:text-gray-400" />
          <h2 className="font-medium text-gray-900 dark:text-gray-100">Printer Health</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400">
                <th className="px-4 py-2 font-medium">Printer</th>
                <th className="px-4 py-2 font-medium">Health</th>
                <th className="px-4 py-2 font-medium">Total Hours</th>
                <th className="px-4 py-2 font-medium">Nozzle Hours</th>
                <th className="px-4 py-2 font-medium">Last Maintenance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {printers.map((printer) => {
                const score = Number(printer.healthScore ?? 100);
                const status = healthStatusFromScore(score);
                return (
                  <tr key={printer.id}>
                    <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">{printer.name}</td>
                    <td className="px-4 py-2">
                      <Badge className={healthBadgeClass(status)}>
                        {score} · {status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-gray-600 dark:text-gray-300">
                      {formatMaxTwoDecimals(Number(printer.totalPrintTime ?? 0))}h
                    </td>
                    <td className="px-4 py-2 text-gray-600 dark:text-gray-300">
                      <span>{formatMaxTwoDecimals(Number(printer.currentNozzleHours ?? 0))}h</span>
                      {(() => {
                        const n = getPrinterNozzleCount(printer);
                        return n > 1 ? (
                          <span className="ml-1 text-xs text-gray-400 dark:text-gray-500">({n} nozzles)</span>
                        ) : null;
                      })()}
                    </td>
                    <td className="px-4 py-2 text-gray-600 dark:text-gray-300">
                      {printer.lastMaintenanceAt
                        ? formatDate(printer.lastMaintenanceAt)
                        : printer.lastMaintenance || '—'}
                    </td>
                  </tr>
                );
              })}
              {printers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-gray-500 dark:text-gray-400">
                    No printers configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Maintenance history */}
      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <History className="size-4 text-gray-600 dark:text-gray-400" />
          <h2 className="font-medium text-gray-900 dark:text-gray-100">Maintenance History</h2>
        </div>
        {history.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400">No completed maintenance yet.</p>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {history.map((event) => (
              <div key={event.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <CheckCircle className="size-4 text-green-600 dark:text-green-400" />
                  <span className="font-medium text-gray-900 dark:text-gray-100">{event.maintenanceType}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{printerName(event.printerId)}</span>
                  <span className="ml-auto text-xs text-gray-400">{formatDate(event.completedAt)}</span>
                </div>
                {event.notes && (
                  <p className="mt-1 pl-6 text-xs text-gray-500 dark:text-gray-400">{event.notes}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Complete-task dialog */}
      <Dialog open={completeTarget !== null} onOpenChange={(open) => !open && setCompleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete maintenance task</DialogTitle>
            <DialogDescription>
              {completeTarget
                ? `${completeTarget.maintenanceType} on ${printerName(completeTarget.printerId)}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Notes (e.g. Lubricated X/Y rails)"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleteTarget(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleComplete} disabled={submitting}>
              {submitting ? 'Saving…' : 'Mark Completed'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
