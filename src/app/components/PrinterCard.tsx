import { Printer } from '../types';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Activity, AlertCircle, CheckCircle, Pause, WifiOff } from 'lucide-react';
import { Card } from './ui/card';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { buildPrinterWebcamSnapshotUrl } from '../lib/printerProfiles';
import { formatMaxTwoDecimals } from '../lib/numberFormat';
import { useIsMobile } from './ui/use-mobile';

// How often each dashboard card re-fetches its webcam snapshot for a near-live
// preview. The printer control/detail page shows the fully live feed instead.
// Kept coarse (rather than truly live) because this fetch runs per-card,
// per-printer, per-open-dashboard — the dominant source of egress traffic on
// a farm with many printers/viewers.
const SNAPSHOT_REFRESH_MS = 5000;
// An idle printer's webcam view isn't changing frame to frame — there's
// nothing moving to watch — so it doesn't need the same near-live cadence as
// one that's actively printing. Idle printers are also typically the
// majority of a farm at any given moment, so this materially cuts traffic.
const SNAPSHOT_REFRESH_IDLE_MS = 30000;

interface PrinterCardProps {
  printer: Printer;
  canManage?: boolean;
  canViewSensitiveInfo?: boolean;
  onDragStart?: (printerId: string) => void;
  onDragOver?: (printerId: string) => void;
  onDragEnd?: () => void;
}

export function PrinterCard({
  printer,
  canManage = false,
  canViewSensitiveInfo = false,
  onDragStart,
  onDragOver,
  onDragEnd,
}: PrinterCardProps) {
  const navigate = useNavigate();
  const draggedRef = useRef(false);
  // On phones the webcam preview is hidden to save space — the live view lives
  // on the printer control page.
  // On phones the webcam preview is hidden to save space — the live view lives
  // on the printer control page — so we also skip the snapshot polling here.
  const isMobile = useIsMobile();
  // The dashboard card refreshes a still snapshot on a timer (near-live preview);
  // the fully live feed lives on the printer control/detail page.
  const [snapshotNonce, setSnapshotNonce] = useState(() => Date.now());
  const webcamSnapshotUrl = `${buildPrinterWebcamSnapshotUrl(printer)}?t=${snapshotNonce}`;
  const isOnline = printer.status !== 'offline';
  const activityLabel = isOnline ? printer.status : 'unreachable';

  useEffect(() => {
    if (isMobile) {
      return;
    }

    setSnapshotNonce(Date.now());

    if (!isOnline) {
      return;
    }

    // Pause snapshot polling while the tab/window isn't visible (e.g. a
    // dashboard left open in a background tab) — refreshing an image no one
    // can see just burns bandwidth. Refresh immediately on return.
    let interval: number | undefined;
    const startInterval = () => {
      if (interval !== undefined) {
        return;
      }
      const refreshMs = printer.status === 'idle' ? SNAPSHOT_REFRESH_IDLE_MS : SNAPSHOT_REFRESH_MS;
      interval = window.setInterval(() => {
        setSnapshotNonce(Date.now());
      }, refreshMs);
    };
    const stopInterval = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setSnapshotNonce(Date.now());
        startInterval();
      } else {
        stopInterval();
      }
    };

    if (document.visibilityState === 'visible') {
      startInterval();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopInterval();
    };
  }, [isOnline, printer.id, printer.status, isMobile]);

  const getActivityIcon = () => {
    switch (printer.status) {
      case 'printing':
        return <Activity className="size-4" />;
      case 'idle':
        return <CheckCircle className="size-4" />;
      case 'error':
        return <AlertCircle className="size-4" />;
      case 'offline':
        return <WifiOff className="size-4" />;
      case 'paused':
        return <Pause className="size-4" />;
    }
  };

  const getStatusColor = () => {
    switch (printer.status) {
      case 'printing':
        return 'bg-blue-500';
      case 'idle':
        return 'bg-green-500';
      case 'error':
        return 'bg-red-500';
      case 'offline':
        return 'bg-gray-500';
      case 'paused':
        return 'bg-yellow-500';
    }
  };

  const getStatusBadgeVariant = (): "default" | "secondary" | "destructive" | "outline" => {
    switch (printer.status) {
      case 'error':
        return 'destructive';
      case 'idle':
        return 'outline';
      default:
        return 'secondary';
    }
  };

  return (
    <Card
      className={`printer-card p-2 sm:p-3 hover:shadow-lg transition-shadow dark:bg-gray-800 dark:border-gray-700 ${canManage && onDragStart ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
      draggable={canManage && Boolean(onDragStart)}
      onClick={() => {
        if (draggedRef.current) {
          draggedRef.current = false;
          return;
        }
        navigate(`/printer/${printer.id}`);
      }}
      onDragStart={(event) => {
        if (!canManage || !onDragStart) {
          return;
        }
        draggedRef.current = true;
        event.dataTransfer.effectAllowed = 'move';
        onDragStart(printer.id);
      }}
      onDragOver={(event) => {
        if (!canManage || !onDragOver) {
          return;
        }
        event.preventDefault();
        onDragOver(printer.id);
      }}
      onDrop={(event) => {
        if (!canManage || !onDragEnd) {
          return;
        }
        event.preventDefault();
        onDragEnd();
      }}
      onDragEnd={() => {
        onDragEnd?.();
        window.setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }}
    >
      {!isMobile && (
        <div className="printer-card-webcam mb-1.5 aspect-video overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-900">
          {isOnline ? (
            <img
              src={webcamSnapshotUrl}
              alt={`${printer.name} webcam`}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
              Webcam offline
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col sm:flex-row items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0 w-full">
          <div className="flex items-center gap-1.5">
            <h3 className="font-semibold mb-0 dark:text-white text-sm sm:text-base truncate">{printer.name}</h3>
            {printer.errorMessage && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    onClick={(event) => event.stopPropagation()}
                    aria-label="View printer error"
                    title="View printer error"
                    className="shrink-0 mb-0.5 sm:mb-1 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  >
                    <AlertCircle className="size-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  onClick={(event) => event.stopPropagation()}
                  className="w-72 border-red-200 dark:border-red-900/60"
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle className="size-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-red-700 dark:text-red-300">Printer error</p>
                      <p className="mt-1 text-xs text-gray-600 dark:text-gray-300 break-words">
                        {printer.errorMessage}
                      </p>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 truncate">{printer.model}</p>
        </div>
        <div className="flex w-full sm:w-auto sm:flex-1 items-start justify-start sm:justify-end gap-2">
          <div className="flex flex-col items-start sm:items-end gap-1.5 sm:ml-auto">
            <div className="flex items-center gap-2">
              <Badge variant={getStatusBadgeVariant()} className="flex items-center gap-1 capitalize">
                {getActivityIcon()}
                {activityLabel}
              </Badge>
              <span
                className={`size-3 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`}
                aria-label={isOnline ? 'online' : 'offline'}
                title={isOnline ? 'online' : 'offline'}
              />
            </div>
            {printer.spools && printer.spools.length > 0 && (
              <div className="mt-1 flex items-center gap-2" aria-label="filament colors">
                {printer.spools.map((spool, index) => (
                  <span
                    key={`${printer.id}-status-spool-${spool.id}-${index}`}
                    className="size-3.5 rounded-full border border-white/80 shadow-sm dark:border-gray-900"
                    style={{ backgroundColor: spool.color }}
                    title={`Tool ${index + 1}: ${spool.material}`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 text-xs sm:text-sm mb-0.5 leading-tight min-h-[1rem]">
          {(printer.status === 'printing' || printer.status === 'paused') && (
            <>
              <span className="text-gray-600 dark:text-gray-400 truncate min-w-0 flex-1">
                {printer.currentJob?.filename}
              </span>
              <span className="shrink-0 text-gray-500 dark:text-gray-400">
                ETA <span className="font-medium dark:text-white">{printer.currentJob?.timeRemaining}m</span>
              </span>
              <span className="shrink-0 font-medium dark:text-white">{formatMaxTwoDecimals(printer.progress)}%</span>
            </>
          )}
        </div>
        {printer.status === 'printing' || printer.status === 'paused' ? (
          <Progress value={printer.progress} className="h-2" />
        ) : (
          <div className={`w-full h-2 rounded-full ${getStatusColor()} opacity-20`} />
        )}
      </div>
    </Card>
  );
}
