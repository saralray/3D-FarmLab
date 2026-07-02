import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Printer } from '../types';
import { fetchQueueJobs } from '../lib/queueApi';
import { usePrinters } from '../contexts/PrintersContext';
import { usePrinterEvents, PrinterEventLevel } from '../contexts/PrinterEventsContext';

type PrinterSnapshot = Pick<Printer, 'id' | 'name' | 'status' | 'currentJob' | 'progress'>;

const QUEUE_POLL_INTERVAL_MS = 10000;
const SEEN_QUEUE_JOB_IDS_KEY = 'printfarm_seen_queue_job_ids';
// A printer can briefly read offline between polls (network flicker) without the
// print actually stopping. Hold the "stopped because offline" toast until the
// printer has stayed offline for this long, and cancel it silently if it recovers.
const OFFLINE_CONFIRM_MS = 20000;

// A detected transition into offline that still needs confirmation before we
// surface the "job stopped" toast.
type TransitionResult = { type: 'offline-stopped'; jobName: string } | null;

// Both surfaces an ephemeral toast and records the event in the notification
// center so it survives after the toast fades.
type EmitEvent = (event: {
  level: PrinterEventLevel;
  title: string;
  description?: string;
  printerId?: string;
  printerName?: string;
}) => void;

function getJobName(printer: PrinterSnapshot) {
  return printer.currentJob?.filename || 'Print job';
}

function notifyPrinterTransition(
  previous: PrinterSnapshot,
  next: PrinterSnapshot,
  emit: EmitEvent,
): TransitionResult {
  const previousJob = previous.currentJob;
  const nextJob = next.currentJob;
  const previousFilename = previousJob?.filename;
  const nextFilename = nextJob?.filename;

  if (!previousFilename && nextFilename) {
    emit({ level: 'success', title: `${next.name} started`, description: nextFilename, printerId: next.id, printerName: next.name });
    return null;
  }

  if (previousFilename && !nextFilename) {
    if (next.status === 'error') {
      emit({ level: 'error', title: `${next.name} error`, description: previousFilename, printerId: next.id, printerName: next.name });
      return null;
    }

    if (next.status === 'offline') {
      // Defer until the offline state is confirmed (see OFFLINE_CONFIRM_MS).
      return { type: 'offline-stopped', jobName: previousFilename };
    }

    if (previous.progress >= 95) {
      emit({ level: 'success', title: `${next.name} completed`, description: previousFilename, printerId: next.id, printerName: next.name });
    } else {
      emit({ level: 'warning', title: `${next.name} stopped`, description: previousFilename, printerId: next.id, printerName: next.name });
    }
    return null;
  }

  if (previousFilename && nextFilename && previousFilename !== nextFilename) {
    emit({ level: 'success', title: `${next.name} started`, description: nextFilename, printerId: next.id, printerName: next.name });
    return null;
  }

  if (previousJob?.status !== 'paused' && nextJob?.status === 'paused') {
    emit({ level: 'warning', title: `${next.name} paused`, description: getJobName(next), printerId: next.id, printerName: next.name });
    return null;
  }

  if (previous.status !== 'error' && next.status === 'error') {
    emit({ level: 'error', title: `${next.name} error`, description: getJobName(next), printerId: next.id, printerName: next.name });
    return null;
  }

  if (previous.status !== 'offline' && next.status === 'offline') {
    // Defer until the offline state is confirmed (see OFFLINE_CONFIRM_MS).
    return { type: 'offline-stopped', jobName: getJobName(previous) };
  }

  return null;
}

function toPrinterMap(printers: Printer[]) {
  return new Map(
    printers.map((printer) => [
      printer.id,
      {
        id: printer.id,
        name: printer.name,
        status: printer.status,
        currentJob: printer.currentJob,
        progress: printer.progress,
      },
    ]),
  );
}

function readSeenQueueJobIds() {
  try {
    const rawValue = localStorage.getItem(SEEN_QUEUE_JOB_IDS_KEY);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string'))
      : null;
  } catch {
    return null;
  }
}

function writeSeenQueueJobIds(jobIds: Set<string>) {
  try {
    localStorage.setItem(SEEN_QUEUE_JOB_IDS_KEY, JSON.stringify([...jobIds]));
  } catch {
    // Ignore storage failures; notifications can still work for the current page session.
  }
}

export function PrinterStatusNotifier() {
  const { printers, loaded } = usePrinters();
  const { addEvent } = usePrinterEvents();
  const previousPrintersRef = useRef<Map<string, PrinterSnapshot> | null>(null);
  const previousQueueJobIdsRef = useRef<Set<string> | null>(null);
  // printerId -> the job + first time we saw it offline, awaiting confirmation.
  const pendingOfflineRef = useRef<Map<string, { jobName: string; since: number }>>(new Map());
  // Keep a stable reference to addEvent so the effects don't re-run on each render.
  const addEventRef = useRef(addEvent);
  addEventRef.current = addEvent;

  // Diff each shared-poll snapshot against the previous one to surface status/job
  // transition toasts. Driven by the central PrintersContext, so this no longer
  // runs its own /api/printers interval.
  useEffect(() => {
    if (!loaded) {
      return;
    }

    // Show the toast and persist the event in the notification center together.
    const emit: EmitEvent = (event) => {
      toast[event.level](event.title, { description: event.description });
      addEventRef.current({
        level: event.level,
        title: event.title,
        description: event.description,
        printerId: event.printerId,
        printerName: event.printerName,
      });
    };

    const nextPrinters = toPrinterMap(printers);
    const previousPrinters = previousPrintersRef.current;
    const pendingOffline = pendingOfflineRef.current;
    const now = Date.now();

    if (previousPrinters) {
      for (const [printerId, nextPrinter] of nextPrinters) {
        const previousPrinter = previousPrinters.get(printerId);
        if (previousPrinter) {
          const result = notifyPrinterTransition(previousPrinter, nextPrinter, emit);
          if (result?.type === 'offline-stopped' && !pendingOffline.has(printerId)) {
            // Record the offline transition; don't toast yet (avoids flicker alarms).
            pendingOffline.set(printerId, { jobName: result.jobName, since: now });
          }
        }
      }
    }

    // Confirm or cancel pending offline notifications against the latest snapshot.
    for (const [printerId, info] of [...pendingOffline]) {
      const current = nextPrinters.get(printerId);
      if (!current || current.status !== 'offline') {
        // Recovered (or removed) before confirmation — false alarm, stay quiet.
        pendingOffline.delete(printerId);
        continue;
      }
      if (now - info.since >= OFFLINE_CONFIRM_MS) {
        emit({
          level: 'error',
          title: `${current.name} stopped`,
          description: `${info.jobName} stopped because the printer went offline.`,
          printerId: current.id,
          printerName: current.name,
        });
        pendingOffline.delete(printerId);
      }
    }

    previousPrintersRef.current = nextPrinters;
  }, [printers, loaded]);

  useEffect(() => {
    let isCancelled = false;

    const refreshQueue = async () => {
      try {
        const { queue } = await fetchQueueJobs();
        if (isCancelled) {
          return;
        }

        const storedJobIds = readSeenQueueJobIds();
        const baselineJobIds = storedJobIds ?? previousQueueJobIdsRef.current;
        const nextJobIds = new Set(queue.map((job) => job.id));

        if (baselineJobIds) {
          const newJobs = queue.filter((job) => !baselineJobIds.has(job.id));
          for (const job of newJobs) {
            const fileCount = job.fileCount ?? 1;
            const who = job.submitterName?.trim() || job.filename || 'Someone';
            const description = `${who} added a print request (${fileCount} file${fileCount === 1 ? '' : 's'}).`;
            toast.info('New job added to queue', { description });
            addEventRef.current({
              level: 'info',
              title: 'New job added to queue',
              description,
            });
          }
        }

        const seenJobIds = new Set([...(storedJobIds ?? []), ...nextJobIds]);
        previousQueueJobIdsRef.current = nextJobIds;
        writeSeenQueueJobIds(seenJobIds);
      } catch {
        // Keep notifications quiet when the queue sync is temporarily unavailable.
      }
    };

    // Pause while the tab is hidden — this notifier is mounted globally on
    // every page, so a backgrounded tab was otherwise polling forever.
    let interval: number | undefined;
    const startInterval = () => {
      if (interval !== undefined) {
        return;
      }
      interval = window.setInterval(refreshQueue, QUEUE_POLL_INTERVAL_MS);
    };
    const stopInterval = () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshQueue();
        startInterval();
      } else {
        stopInterval();
      }
    };

    refreshQueue();
    if (document.visibilityState === 'visible') {
      startInterval();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopInterval();
    };
  }, []);

  return null;
}
