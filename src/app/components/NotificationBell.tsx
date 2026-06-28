import { useState } from 'react';
import { Bell, CheckCheck, Trash2, CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { usePrinterEvents, PrinterEvent, PrinterEventLevel } from '../contexts/PrinterEventsContext';

const LEVEL_ICON: Record<PrinterEventLevel, typeof Info> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
};

const LEVEL_ICON_COLOR: Record<PrinterEventLevel, string> = {
  success: 'text-green-500 dark:text-green-400',
  warning: 'text-amber-500 dark:text-amber-400',
  error: 'text-red-500 dark:text-red-400',
  info: 'text-blue-500 dark:text-blue-400',
};

function formatRelativeTime(timestamp: number): string {
  const diffSeconds = Math.round((Date.now() - timestamp) / 1000);
  if (diffSeconds < 60) return 'just now';
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function EventRow({ event }: { event: PrinterEvent }) {
  const Icon = LEVEL_ICON[event.level];
  return (
    <div className={`flex gap-3 px-4 py-3 ${event.read ? '' : 'bg-blue-50/50 dark:bg-blue-950/30'}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${LEVEL_ICON_COLOR[event.level]}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-sm leading-snug ${event.read ? 'text-gray-600 dark:text-gray-300' : 'font-medium text-gray-900 dark:text-gray-100'}`}>
            {event.title}
          </p>
          <span className="mt-0.5 shrink-0 whitespace-nowrap text-[11px] text-gray-400 dark:text-gray-500">
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

export function NotificationBell() {
  const { events, unreadCount, markAllRead, clearAll } = usePrinterEvents();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) markAllRead();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
          className="relative inline-flex size-9 items-center justify-center rounded-md text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <Bell className="size-5" />
          {unreadCount > 0 && (
            <span className="absolute right-1.5 top-1.5 flex size-2 items-center justify-center">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-60" />
              <span className="relative size-2 rounded-full bg-red-500" />
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-80 p-0 shadow-lg"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</h3>
            {unreadCount > 0 && (
              <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-red-600 dark:bg-red-900/40 dark:text-red-400">
                {unreadCount}
              </span>
            )}
          </div>
          {events.length > 0 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={markAllRead}
                title="Mark all read"
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                <CheckCheck className="size-3.5" />
                Read all
              </button>
              <button
                type="button"
                onClick={clearAll}
                title="Clear all"
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20 dark:hover:text-red-400"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Body */}
        {events.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
              <Bell className="size-4 text-gray-400 dark:text-gray-500" />
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400">No printer activity yet.</p>
          </div>
        ) : (
          <div className="max-h-[320px] overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
