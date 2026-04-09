import { useEffect, useState } from 'react';
import { PrintJob } from '../types';
import { QueueItem } from '../components/QueueItem';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { List, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { fetchPrinters } from '../lib/printersApi';
import { fetchQueueJobs, markQueueJobAsPrinted, resetQueueJobStatuses } from '../lib/queueApi';
import { useAuth } from '../contexts/AuthContext';

const GOOGLE_SHEET_QUEUE_URL =
  'https://docs.google.com/spreadsheets/d/13CZxAD8lctUtJEcVHH-qUHKNIJY0ENxcxPP-DwNgelE/edit?usp=sharing';

export function Queue() {
  const { user } = useAuth();
  const [queue, setQueue] = useState<PrintJob[]>([]);
  const [history, setHistory] = useState<PrintJob[]>([]);
  const [availablePrinters, setAvailablePrinters] = useState(0);
  const [resetInFlight, setResetInFlight] = useState(false);

  useEffect(() => {
    let active = true;

    const refreshQueue = async () => {
      try {
        const jobs = await fetchQueueJobs();
        if (active) {
          setQueue(jobs.queue);
          setHistory(jobs.history);
        }
      } catch (error) {
        console.error('Failed to load queue from Google Sheet / Postgres sync', error);
      }
    };

    const refreshPrinters = async () => {
      try {
        const printers = await fetchPrinters();
        if (active) {
          setAvailablePrinters(
            printers.filter((printer) => printer.status === 'idle' || printer.status === 'offline')
              .length,
          );
        }
      } catch (error) {
        console.error('Failed to load printer availability for queue page', error);
      }
    };

    refreshQueue();
    refreshPrinters();

    const queueInterval = window.setInterval(refreshQueue, 30000);
    const printerInterval = window.setInterval(refreshPrinters, 10000);

    return () => {
      active = false;
      window.clearInterval(queueInterval);
      window.clearInterval(printerInterval);
    };
  }, []);

  const handleRemove = async (jobId: string) => {
    try {
      await markQueueJobAsPrinted(jobId);
      const refreshed = await fetchQueueJobs();
      setQueue(refreshed.queue);
      setHistory(refreshed.history);
      toast.success('Job marked as printed');
    } catch (error) {
      console.error('Failed to mark queue job as printed', error);
      toast.error('Unable to update printed status');
    }
  };

  const handleResetQueue = async () => {
    if (user?.role !== 'admin' || resetInFlight) {
      return;
    }

    setResetInFlight(true);

    try {
      await resetQueueJobStatuses();
      const refreshed = await fetchQueueJobs();
      setQueue(refreshed.queue);
      setHistory(refreshed.history);
      toast.success('Queue reset for development');
    } catch (error) {
      console.error('Failed to reset queue jobs', error);
      toast.error('Unable to reset queue');
    } finally {
      setResetInFlight(false);
    }
  };

  const handleDownload = (job: PrintJob) => {
    if (!job.stlFileUrl) {
      toast.error('No file link available for this submission');
      return;
    }

    let downloadUrl = job.stlFileUrl;

    try {
      const parsedUrl = new URL(job.stlFileUrl);
      const directFileId =
        parsedUrl.searchParams.get('id') ||
        parsedUrl.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ||
        parsedUrl.pathname.match(/\/d\/([^/]+)/)?.[1];

      if (directFileId) {
        downloadUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(directFileId)}`;
      }
    } catch {
      // Keep the original URL when the link cannot be parsed.
    }

    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    toast.success('Started file download');
  };

  const totalFiles = queue.reduce((acc, job) => acc + (job.fileCount ?? 1), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2 dark:text-white">Print Queue</h1>
          <p className="text-gray-600 dark:text-gray-400">Only สั่งพิมพ์งาน 3D Print submissions are shown</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {user?.role === 'admin' && (
            <Button
              type="button"
              variant="destructive"
              onClick={handleResetQueue}
              disabled={resetInFlight}
            >
              {resetInFlight ? 'Resetting...' : 'Reset Queue'}
            </Button>
          )}
          <Button
            onClick={() =>
              window.open(
                GOOGLE_SHEET_QUEUE_URL,
                '_blank',
                'noopener,noreferrer',
              )
            }
            variant="outline"
          >
            <ExternalLink className="size-4 mr-2" />
            Open Google Sheet
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4 dark:bg-gray-800 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-400">Jobs in Queue</div>
          <div className="text-3xl font-bold mt-1 dark:text-white">{queue.length}</div>
        </Card>
        <Card className="p-4 dark:bg-gray-800 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-400">Available Printers</div>
          <div className="text-3xl font-bold mt-1 dark:text-white">{availablePrinters}</div>
        </Card>
        <Card className="p-4 dark:bg-gray-800 dark:border-gray-700">
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Files</div>
          <div className="text-3xl font-bold mt-1 dark:text-white">{totalFiles}</div>
        </Card>
      </div>

      <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
        <div className="flex items-center gap-2 mb-4">
          <List className="size-5 dark:text-white" />
          <h2 className="text-xl font-semibold dark:text-white">Submission Queue ({queue.length})</h2>
        </div>

        <div className="text-sm text-gray-600 dark:text-gray-400 mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
          <strong>Note:</strong> New 3D Print jobs sync from the Google Sheet into Postgres.
          Marking a job as printed moves it into the history list below.
        </div>

        {queue.length > 0 ? (
          <div className="space-y-3">
            {queue.map((job, index) => (
              <div key={job.id} className="flex items-start gap-3">
                <div className="text-sm font-medium text-gray-400 w-6 text-center mt-4">
                  {index + 1}
                </div>
                <div className="flex-1">
                  <QueueItem
                    job={job}
                    onRemove={handleRemove}
                    onDownload={handleDownload}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <List className="size-12 mx-auto mb-3 opacity-50" />
            <p>No jobs in queue</p>
            <p className="text-sm mt-1">New 3D Print submissions from Google Sheet will appear here</p>
          </div>
        )}
      </Card>

      <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
        <div className="flex items-center gap-2 mb-4">
          <List className="size-5 dark:text-white" />
          <h2 className="text-xl font-semibold dark:text-white">History ({history.length})</h2>
        </div>

        {history.length > 0 ? (
          <div className="space-y-3">
            {history.map((job, index) => (
              <div key={job.id} className="flex items-start gap-3">
                <div className="text-sm font-medium text-gray-400 w-6 text-center mt-4">
                  {index + 1}
                </div>
                <div className="flex-1">
                  <QueueItem
                    job={job}
                    mode="history"
                    onDownload={handleDownload}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <List className="size-12 mx-auto mb-3 opacity-50" />
            <p>No printed jobs in history</p>
            <p className="text-sm mt-1">Marked printed jobs will appear here</p>
          </div>
        )}
      </Card>
    </div>
  );
}
