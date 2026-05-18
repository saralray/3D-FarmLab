import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Printer } from '../types';
import { fetchPrinters } from '../lib/printersApi';
import { normalizePrinter } from '../lib/printerProfiles';
import { fetchQueueJobs } from '../lib/queueApi';

type PrinterSnapshot = Pick<Printer, 'id' | 'name' | 'status' | 'currentJob' | 'progress'>;

const PRINTER_POLL_INTERVAL_MS = 5000;
const QUEUE_POLL_INTERVAL_MS = 10000;
const SEEN_QUEUE_JOB_IDS_KEY = 'printfarm_seen_queue_job_ids';

function getJobName(printer: PrinterSnapshot) {
  return printer.currentJob?.filename || 'Print job';
}

function notifyPrinterTransition(previous: PrinterSnapshot, next: PrinterSnapshot) {
  const previousJob = previous.currentJob;
  const nextJob = next.currentJob;
  const previousFilename = previousJob?.filename;
  const nextFilename = nextJob?.filename;

  if (!previousFilename && nextFilename) {
    toast.success(`${next.name} started`, {
      description: nextFilename,
    });
    return;
  }

  if (previousFilename && !nextFilename) {
    if (next.status === 'error') {
      toast.error(`${next.name} error`, {
        description: previousFilename,
      });
      return;
    }

    if (next.status === 'offline') {
      toast.error(`${next.name} stopped`, {
        description: `${previousFilename} stopped because the printer went offline.`,
      });
      return;
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
    return;
  }

  if (previousFilename && nextFilename && previousFilename !== nextFilename) {
    toast.success(`${next.name} started`, {
      description: nextFilename,
    });
    return;
  }

  if (previousJob?.status !== 'paused' && nextJob?.status === 'paused') {
    toast.warning(`${next.name} paused`, {
      description: getJobName(next),
    });
    return;
  }

  if (previous.status !== 'error' && next.status === 'error') {
    toast.error(`${next.name} error`, {
      description: getJobName(next),
    });
    return;
  }

  if (previous.status !== 'offline' && next.status === 'offline') {
    toast.error(`${next.name} stopped`, {
      description: getJobName(previous),
    });
  }
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
  const previousPrintersRef = useRef<Map<string, PrinterSnapshot> | null>(null);
  const previousQueueJobIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    let isCancelled = false;

    const refreshPrinters = async () => {
      try {
        const printers = (await fetchPrinters()).map(normalizePrinter);
        if (isCancelled) {
          return;
        }

        const nextPrinters = toPrinterMap(printers);
        const previousPrinters = previousPrintersRef.current;

        if (previousPrinters) {
          for (const [printerId, nextPrinter] of nextPrinters) {
            const previousPrinter = previousPrinters.get(printerId);
            if (previousPrinter) {
              notifyPrinterTransition(previousPrinter, nextPrinter);
            }
          }
        }

        previousPrintersRef.current = nextPrinters;
      } catch {
        // Keep notifications quiet when the printer API is temporarily unavailable.
      }
    };

    refreshPrinters();
    const interval = window.setInterval(refreshPrinters, PRINTER_POLL_INTERVAL_MS);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, []);

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
