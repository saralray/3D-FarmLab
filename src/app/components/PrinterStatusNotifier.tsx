import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Printer } from '../types';
import { fetchQueueJobs } from '../lib/queueApi';
import { usePrinters } from '../contexts/PrintersContext';

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

function getJobName(printer: PrinterSnapshot) {
  return printer.currentJob?.filename || 'Print job';
}

function notifyPrinterTransition(previous: PrinterSnapshot, next: PrinterSnapshot): TransitionResult {
  const previousJob = previous.currentJob;
  const nextJob = next.currentJob;
  const previousFilename = previousJob?.filename;
  const nextFilename = nextJob?.filename;

  if (!previousFilename && nextFilename) {
    toast.success(`${next.name} started`, {
      description: nextFilename,
    });
    return null;
  }

  if (previousFilename && !nextFilename) {
    if (next.status === 'error') {
      toast.error(`${next.name} error`, {
        description: previousFilename,
      });
      return null;
    }

    if (next.status === 'offline') {
      // Defer until the offline state is confirmed (see OFFLINE_CONFIRM_MS).
      return { type: 'offline-stopped', jobName: previousFilename };
    }

    if (previous.progress >= 95) {
      toast.success(`${next.name} completed`, {
        description: previousFilename,
      });
    } else {
      toast.warning(`${next.name} stopped`, {
        description: previousFilename,
      });
    }
    return null;
  }

  if (previousFilename && nextFilename && previousFilename !== nextFilename) {
    toast.success(`${next.name} started`, {
      description: nextFilename,
    });
    return null;
  }

  if (previousJob?.status !== 'paused' && nextJob?.status === 'paused') {
    toast.warning(`${next.name} paused`, {
      description: getJobName(next),
    });
    return null;
  }

  if (previous.status !== 'error' && next.status === 'error') {
    toast.error(`${next.name} error`, {
      description: getJobName(next),
    });
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

function showNewQueueJobToast(job: { filename: string; fileCount?: number; submitterName?: string }) {
  const fileCount = job.fileCount ?? 1;
  toast.info('New queue submission', {
    description: `${job.submitterName || job.filename} - ${fileCount} file${fileCount === 1 ? '' : 's'}`,
  });
}

export function PrinterStatusNotifier() {
  const { printers, loaded } = usePrinters();
  const previousPrintersRef = useRef<Map<string, PrinterSnapshot> | null>(null);
  const previousQueueJobIdsRef = useRef<Set<string> | null>(null);
  // printerId -> the job + first time we saw it offline, awaiting confirmation.
  const pendingOfflineRef = useRef<Map<string, { jobName: string; since: number }>>(new Map());

  // Diff each shared-poll snapshot against the previous one to surface status/job
  // transition toasts. Driven by the central PrintersContext, so this no longer
  // runs its own /api/printers interval.
  useEffect(() => {
    if (!loaded) {
      return;
    }

    const nextPrinters = toPrinterMap(printers);
    const previousPrinters = previousPrintersRef.current;
    const pendingOffline = pendingOfflineRef.current;
    const now = Date.now();

    if (previousPrinters) {
      for (const [printerId, nextPrinter] of nextPrinters) {
        const previousPrinter = previousPrinters.get(printerId);
        if (previousPrinter) {
          const result = notifyPrinterTransition(previousPrinter, nextPrinter);
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
        toast.error(`${current.name} stopped`, {
          description: `${info.jobName} stopped because the printer went offline.`,
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
            showNewQueueJobToast(job);
          }
        }

        const seenJobIds = new Set([...(storedJobIds ?? []), ...nextJobIds]);
        previousQueueJobIdsRef.current = nextJobIds;
        writeSeenQueueJobIds(seenJobIds);
      } catch {
        // Keep notifications quiet when the queue sync is temporarily unavailable.
      }
    };

    refreshQueue();
    const interval = window.setInterval(refreshQueue, QUEUE_POLL_INTERVAL_MS);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
