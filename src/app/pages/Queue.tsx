import { useEffect, useState } from 'react';
import { PrintJob } from '../types';
import { QueueItem } from '../components/QueueItem';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { List, ClipboardList } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { deleteQueueJob, fetchQueueJobs, markQueueJobAsPrinted, resetQueueJobStatuses } from '../lib/queueApi';
import { useAuth } from '../contexts/AuthContext';
import { usePrinters } from '../contexts/PrintersContext';
import { isReadOnlyRole } from '../lib/usersApi';

export function Queue() {
  const { user } = useAuth();
  const { printers } = usePrinters();
  const [queue, setQueue] = useState<PrintJob[]>([]);
  const [history, setHistory] = useState<PrintJob[]>([]);
  const [resetInFlight, setResetInFlight] = useState(false);

  useEffect(() => {
    let active = true;

    // Submissions come from the in-app /request form and are stored directly in
    // the database, so the queue is just a cheap DB read polled on an interval.
    const loadQueue = async () => {
      try {
        const jobs = await fetchQueueJobs();
        if (active) {
          setQueue(jobs.queue);
          setHistory(jobs.history);
        }
      } catch (error) {
        console.error('Failed to load queue', error);
      }
    };

    loadQueue();
    const queueInterval = window.setInterval(loadQueue, 30000);

    return () => {
      active = false;
      window.clearInterval(queueInterval);
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

  const handleDeleteQueueJob = async (jobId: string) => {
    if (user?.role !== 'admin') {
      return;
    }

    try {
      await deleteQueueJob(jobId);
      const refreshed = await fetchQueueJobs();
      setQueue(refreshed.queue);
      setHistory(refreshed.history);
      toast.success('Queue job deleted');
    } catch (error) {
      console.error('Failed to delete queue job', error);
      toast.error('Unable to delete queue job');
    }
  };

  const handleDownload = (job: PrintJob) => {
    if (!job.stlFileUrl) {
      toast.error('No file link available for this submission');
      return;
    }

    let downloadUrl = job.stlFileUrl;
    // Same-origin files (our own `/api/queue/:id/file` endpoint, which sends
    // `Content-Disposition: attachment`) can download in place via the `download`
    // attribute. External links (e.g. Google Drive) are cross-origin and must
    // open in a new tab instead.
    let isSameOrigin = false;

    try {
      const parsedUrl = new URL(job.stlFileUrl, window.location.origin);
      isSameOrigin = parsedUrl.origin === window.location.origin;
      const directFileId =
        parsedUrl.searchParams.get('id') ||
        parsedUrl.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ||
        parsedUrl.pathname.match(/\/d\/([^/]+)/)?.[1];

      if (directFileId && !isSameOrigin) {
        downloadUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(directFileId)}`;
      }
    } catch {
      // Keep the original URL when the link cannot be parsed.
    }

    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    if (isSameOrigin) {
      // `download` keeps the navigation in-document so an installed PWA triggers
      // a real download instead of spawning a new standalone app window.
      anchor.download = '';
    } else {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    toast.success('Started file download');
  };

  const availablePrinters = printers.filter((printer) => printer.status === 'idle').length;
  const totalFiles = queue.reduce((acc, job) => acc + (job.fileCount ?? 1), 0);
  const canManageQueue = user?.role === 'admin' || user?.role === 'operator';
  const canDeleteQueueJobs = user?.role === 'admin';
  const canDownloadQueueFiles = !isReadOnlyRole(user?.role);

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2 dark:text-white">Print Queue</h1>
          <p className="text-gray-600 dark:text-gray-400">Only 3D Print submissions are shown</p>
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
          <Button asChild variant="outline">
            <Link to="/request">
              <ClipboardList className="size-4 mr-2" />
              New Print Request
            </Link>
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

        {queue.length > 0 ? (
          <div className="space-y-3">
            {queue.map((job, index) => (
              <div key={job.id} className="flex items-start gap-3">
                <div className="text-sm font-medium text-gray-400 w-6 text-center mt-4">
                  {index + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <QueueItem
                    job={job}
                    onRemove={canManageQueue ? handleRemove : undefined}
                    onDelete={canDeleteQueueJobs ? handleDeleteQueueJob : undefined}
                    onDownload={canDownloadQueueFiles ? handleDownload : undefined}
                    canManage={canManageQueue}
                    canDelete={canDeleteQueueJobs}
                    canDownload={canDownloadQueueFiles}
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
                <div className="min-w-0 flex-1">
                  <QueueItem
                    job={job}
                    mode="history"
                    onDelete={canDeleteQueueJobs ? handleDeleteQueueJob : undefined}
                    onDownload={canDownloadQueueFiles ? handleDownload : undefined}
                    canManage={false}
                    canDelete={canDeleteQueueJobs}
                    canDownload={canDownloadQueueFiles}
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
