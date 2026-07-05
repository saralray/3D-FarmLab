import { useCallback, useMemo, useRef, useState } from 'react';
import { RefreshCw, ScrollText, Search } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { AuditLogEntry, fetchAuditLogs } from '../lib/auditApi';
import { useAutoRefresh } from '../lib/useAutoRefresh';

// Human-friendly label for each machine action key. Unknown keys fall back to
// the raw key so a newly added action still renders something sensible.
const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'user.create': 'Created user',
  'user.delete': 'Removed user',
  'user.password_change': 'Changed password',
  'printer.save': 'Saved printer',
  'printer.delete': 'Deleted printer',
  'printer.reorder': 'Reordered printers',
  'printer.command': 'Printer control',
  'printer.temperature': 'Set temperature',
  'printer.light': 'Toggled chamber light',
  'printer.filament': 'Filament change',
  'printer.motion': 'Manual motion',
  'queue.mark_printed': 'Marked job printed',
  'queue.reset': 'Reset queue',
  'queue.delete': 'Deleted queue job',
  'webhook.save': 'Saved Discord webhook',
  'webhook.delete': 'Deleted Discord webhook',
  'slicer_key.create': 'Created slicer key',
  'slicer_key.delete': 'Revoked slicer key',
  'settings.integrations': 'Updated integrations',
  'slicer.upload': 'Slicer upload',
  'slicer.upload_rejected': 'Slicer upload rejected',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDetails(details: Record<string, unknown> | null): string {
  if (!details || typeof details !== 'object') {
    return '';
  }
  return Object.entries(details)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(', ');
}

type SourceFilter = 'all' | 'web' | 'slicer';

export function Logs() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const hasData = useRef(false);

  const loadLogs = useCallback(async () => {
    try {
      const entries = await fetchAuditLogs(500);
      setLogs(entries);
      hasData.current = true;
    } catch {
      if (!hasData.current) {
        toast.error('Unable to load the activity log. Check the server and database connection.');
      }
    } finally {
      setIsLoading(false); // only meaningful on first load; isLoading starts true
    }
  }, []);

  useAutoRefresh(loadLogs, 60_000);

  const filteredLogs = useMemo(() => {
    const term = search.trim().toLowerCase();
    return logs.filter((entry) => {
      if (sourceFilter !== 'all' && entry.source !== sourceFilter) {
        return false;
      }
      if (!term) {
        return true;
      }
      const haystack = [
        entry.actorName,
        entry.actorUsername,
        entry.actorRole,
        actionLabel(entry.action),
        entry.action,
        entry.target,
        formatDetails(entry.details),
        entry.ip,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [logs, search, sourceFilter]);

  const sourceFilters: { value: SourceFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'web', label: 'Dashboard' },
    { value: 'slicer', label: 'Slicer keys' },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-2 flex items-center gap-2 text-3xl font-bold text-foreground">
            <ScrollText className="size-7" />
            Activity Log
          </h1>
          <p className="text-muted-foreground">
            Admin-only record of who did what and when — every action except page
            navigation, including slicer API key usage.
          </p>
        </div>
        <Button variant="outline" onClick={loadLogs} disabled={isLoading}>
          <RefreshCw className={`size-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <Card className="p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search user, action, target, IP…"
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-1">
            {sourceFilters.map((filter) => (
              <Button
                key={filter.value}
                size="sm"
                variant={sourceFilter === filter.value ? 'default' : 'outline'}
                onClick={() => setSourceFilter(filter.value)}
              >
                {filter.label}
              </Button>
            ))}
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredLogs.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {formatTimestamp(entry.createdAt)}
                </TableCell>
                <TableCell>
                  <div className="font-medium text-foreground">{entry.actorName ?? 'Unknown'}</div>
                  {entry.actorRole && (
                    <div className="text-xs capitalize text-muted-foreground">
                      {entry.actorRole}
                    </div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-foreground">
                  {actionLabel(entry.action)}
                </TableCell>
                <TableCell className="max-w-[16rem] truncate text-foreground" title={entry.target ?? ''}>
                  {entry.target ?? '—'}
                </TableCell>
                <TableCell
                  className="max-w-[20rem] truncate text-muted-foreground"
                  title={formatDetails(entry.details)}
                >
                  {formatDetails(entry.details) || '—'}
                </TableCell>
                <TableCell>
                  <Badge variant={entry.source === 'slicer' ? 'secondary' : 'outline'}>
                    {entry.source === 'slicer' ? 'Slicer key' : 'Dashboard'}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {entry.ip ?? '—'}
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && filteredLogs.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {logs.length === 0 ? 'No activity recorded yet.' : 'No entries match your filter.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
