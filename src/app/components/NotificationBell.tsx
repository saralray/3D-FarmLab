import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Check, CheckCheck, MonitorCheck, Trash2, CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { usePrinterEvents, PrinterEvent, PrinterEventLevel } from '../contexts/PrinterEventsContext';
import { useAuth } from '../contexts/AuthContext';
import {
  approveManagerRequest,
  denyManagerRequest,
  fetchManagerRequests,
} from '../lib/managerRequestsApi';
import type { ManagerRequest } from '../lib/managerRequestsApi';

const LEVEL_ICON: Record<PrinterEventLevel, typeof Info> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
};

const LEVEL_COLOR: Record<PrinterEventLevel, string> = {
  success: 'text-green-600 dark:text-green-400',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
  info: 'text-blue-600 dark:text-blue-400',
};

function formatRelativeTime(timestamp: number): string {
  const diffSeconds = Math.round((Date.now() - timestamp) / 1000);
  if (diffSeconds < 60) {
    return 'just now';
  }
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

function EventRow({ event }: { event: PrinterEvent }) {
  const Icon = LEVEL_ICON[event.level];
  return (
    <div
      className={`flex gap-3 px-4 py-3 ${
        event.read ? '' : 'bg-blue-50/60 dark:bg-blue-900/20'
      }`}
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${LEVEL_COLOR[event.level]}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
            {event.title}
          </p>
          <span className="shrink-0 whitespace-nowrap text-xs text-gray-400 dark:text-gray-500">
            {formatRelativeTime(event.timestamp)}
          </span>
        </div>
        {event.description && (
          <p className="mt-0.5 break-words text-xs text-gray-500 dark:text-gray-400">
            {event.description}
          </p>
        )}
      </div>
    </div>
  );
}

function ManagerRequestRow({
  request,
  onAction,
}: {
  request: ManagerRequest;
  onAction: () => void;
}) {
  const [actioning, setActioning] = useState<'approve' | 'deny' | null>(null);

  const handleApprove = async () => {
    setActioning('approve');
    try {
      await approveManagerRequest(request.id);
      toast.success('Manager access approved', { description: request.name });
      onAction();
    } catch (err) {
      toast.error('Failed to approve', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setActioning(null);
    }
  };

  const handleDeny = async () => {
    setActioning('deny');
    try {
      await denyManagerRequest(request.id);
      toast.success('Manager access denied', { description: request.name });
      onAction();
    } catch (err) {
      toast.error('Failed to deny', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setActioning(null);
    }
  };

  return (
    <div className="flex gap-3 bg-amber-50/60 px-4 py-3 dark:bg-amber-900/10">
      <MonitorCheck className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
          Manager access request
        </p>
        <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
          <span className="font-medium">{request.name}</span>
          {request.description && ` — ${request.description}`}
        </p>
        <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
          {new Date(request.createdAt).toLocaleString()}
        </p>
        <div className="mt-2 flex gap-1.5">
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={actioning !== null}
            onClick={handleApprove}
          >
            {actioning === 'approve' ? (
              '…'
            ) : (
              <>
                <Check className="mr-1 size-3" />
                Approve
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={actioning !== null}
            onClick={handleDeny}
          >
            {actioning === 'deny' ? (
              '…'
            ) : (
              <>
                <X className="mr-1 size-3" />
                Deny
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

const MANAGER_POLL_INTERVAL_MS = 30_000;

/**
 * Notification center. Shows printer status events and (for admins) pending
 * manager access requests with inline approve/deny.
 */
export function NotificationBell() {
  const { events, unreadCount, markAllRead, clearAll } = usePrinterEvents();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [pendingRequests, setPendingRequests] = useState<ManagerRequest[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadPendingRequests = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const all = await fetchManagerRequests();
      setPendingRequests(all.filter((r) => r.status === 'pending'));
    } catch {
      // Silent — this is best-effort background polling
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) {
      setPendingRequests([]);
      return;
    }

    loadPendingRequests();

    pollTimerRef.current = setInterval(loadPendingRequests, MANAGER_POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [isAdmin, loadPendingRequests]);

  const totalUnread = unreadCount + pendingRequests.length;

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) {
          markAllRead();
          if (isAdmin) {
            loadPendingRequests();
          }
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Printer notifications${totalUnread > 0 ? ` (${totalUnread} unread)` : ''}`}
          className="relative inline-flex size-9 items-center justify-center rounded-md text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <Bell className="size-5" />
          {totalUnread > 0 && (
            <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-red-500 ring-2 ring-white dark:ring-gray-900" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</h3>
          {events.length > 0 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={markAllRead}
                title="Mark all as read"
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                <CheckCheck className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={clearAll}
                title="Clear all"
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )}
        </div>

        {pendingRequests.length === 0 && events.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
            No printer activity yet.
          </div>
        ) : (
          <ScrollArea className="max-h-96">
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {pendingRequests.map((req) => (
                <ManagerRequestRow
                  key={req.id}
                  request={req}
                  onAction={loadPendingRequests}
                />
              ))}
              {events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
