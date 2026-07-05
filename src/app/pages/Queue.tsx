import { useCallback, useState } from 'react';
import { PrintJob } from '../types';
import { QueueItem } from '../components/QueueItem';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { List, ClipboardList, ChevronLeft, ChevronRight, FileSpreadsheet } from 'lucide-react';
import { toast } from 'sonner';
import { PrintRequestDialog } from '../components/PrintRequestDialog';
import { deleteQueueJob, fetchQueueJobs, markQueueJobAsPrinted, resetQueueJobStatuses } from '../lib/queueApi';
import { useAuth } from '../contexts/AuthContext';
import { usePrinters } from '../contexts/PrintersContext';
import { isReadOnlyRole } from '../lib/usersApi';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { exportQueueToXlsx } from '../lib/xlsxExport';

export function Queue() {
  const { user } = useAuth();
  const { printers } = usePrinters();
  const [queue, setQueue] = useState<PrintJob[]>([]);
  const [history, setHistory] = useState<PrintJob[]>([]);
  const [historyPage, setHistoryPage] = useState(0);
  const [resetInFlight, setResetInFlight] = useState(false);

  const HISTORY_PAGE_SIZE = 5;

  // Submissions come from the in-app /request form and are stored directly in
  // the database, so the queue is just a cheap DB read polled on an interval.
  const loadQueue = useCallback(async () => {
    try {
      const jobs = await fetchQueueJobs();
      setQueue(jobs.queue);
      setHistory(jobs.history);
      setHistoryPage(0);
    } catch (error) {
      console.error('Failed to load queue', error);
    }
  }, []);

  useAutoRefresh(loadQueue, 30_000);

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

  const handleOpenInSlicer = (job: PrintJob) => {
    if (!job.stlFileUrl) {
      toast.error('No file available for this submission');
      return;
    }

    try {
      const parsedUrl = new URL(job.stlFileUrl, window.location.origin);
      const isSameOrigin = parsedUrl.origin === window.location.origin;
      if (isSameOrigin) {
        // Serve as Content-Disposition: inline so the OS dispatches to the
        // registered slicer (OrcaSlicer, PrusaSlicer, Bambu Studio, etc.)
        parsedUrl.searchParams.set('open', '1');
        window.open(parsedUrl.toString(), '_blank', 'noopener,noreferrer');
        toast.success('File opened – your slicer should launch automatically');
        return;
      }
    } catch {
      // Fall through for unparseable URLs.
    }

    window.open(job.stlFileUrl, '_blank', 'noopener,noreferrer');
    toast.success('File opened – your slicer should launch automatically');
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

  const historyTotalPages = Math.ceil(history.length / HISTORY_PAGE_SIZE);
  const historyPageItems = history.slice(
    historyPage * HISTORY_PAGE_SIZE,
    (historyPage + 1) * HISTORY_PAGE_SIZE,
  );

  const availablePrinters = printers.filter((printer) => printer.status === 'idle').length;
  const totalFiles = queue.reduce((acc, job) => acc + (job.fileCount ?? 1), 0);
  const canManageQueue = user?.role === 'admin' || user?.role === 'operator';
  const canDeleteQueueJobs = user?.role === 'admin';
  const canDownloadQueueFiles = !isReadOnlyRole(user?.role);
  const canExport = !isReadOnlyRole(user?.role);

  const handleExportExcel = () => {
    const date = new Date().toISOString().slice(0, 10);
    exportQueueToXlsx(queue, history, `print-queue-${date}.xlsx`);
    toast.success('Excel file downloaded');
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2 text-foreground">Print Queue</h1>
          <p className="text-muted-foreground">Only 3D Print submissions are shown</p>
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
          {canExport && (
            <Button variant="outline" onClick={handleExportExcel}>
              <FileSpreadsheet className="size-4 mr-2" />
              Export Excel
            </Button>
          )}
          <PrintRequestDialog>
            <Button variant="outline">
              <ClipboardList className="size-4 mr-2" />
              New Print Request
            </Button>
          </PrintRequestDialog>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">Jobs in Queue</div>
          <div className="text-3xl font-bold mt-1 text-foreground">{queue.length}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">Available Printers</div>
          <div className="text-3xl font-bold mt-1 text-foreground">{availablePrinters}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">Total Pieces</div>
          <div className="text-3xl font-bold mt-1 text-foreground">{totalFiles}</div>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <List className="size-5 text-foreground" />
          <h2 className="text-xl font-semibold text-foreground">Submission Queue ({queue.length})</h2>
        </div>

        {queue.length > 0 ? (
          <div className="space-y-3">
            {queue.map((job, index) => (
              <div key={job.id} className="flex items-start gap-3">
                <div className="text-sm font-medium text-muted-foreground w-6 text-center mt-4">
                  {index + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <QueueItem
                    job={job}
                    onRemove={canManageQueue ? handleRemove : undefined}
                    onDelete={canDeleteQueueJobs ? handleDeleteQueueJob : undefined}
                    onDownload={canDownloadQueueFiles ? handleDownload : undefined}
                    onOpenInSlicer={canDownloadQueueFiles ? handleOpenInSlicer : undefined}
                    canManage={canManageQueue}
                    canDelete={canDeleteQueueJobs}
                    canDownload={canDownloadQueueFiles}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            <List className="size-12 mx-auto mb-3 opacity-50" />
            <p>No jobs in queue</p>
            <p className="text-sm mt-1">New 3D Print submissions from Google Sheet will appear here</p>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <List className="size-5 text-foreground" />
          <h2 className="text-xl font-semibold text-foreground">History ({history.length})</h2>
        </div>

        {history.length > 0 ? (
          <>
            <div className="space-y-3">
              {historyPageItems.map((job, index) => (
                <div key={job.id} className="flex items-start gap-3">
                  <div className="text-sm font-medium text-muted-foreground w-6 text-center mt-4">
                    {historyPage * HISTORY_PAGE_SIZE + index + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <QueueItem
                      job={job}
                      mode="history"
                      onDelete={canDeleteQueueJobs ? handleDeleteQueueJob : undefined}
                      onDownload={canDownloadQueueFiles ? handleDownload : undefined}
                      onOpenInSlicer={canDownloadQueueFiles ? handleOpenInSlicer : undefined}
                      canManage={false}
                      canDelete={canDeleteQueueJobs}
                      canDownload={canDownloadQueueFiles}
                    />
                  </div>
                </div>
              ))}
            </div>
            {historyTotalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-4 pt-4 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setHistoryPage((p) => p - 1)}
                  disabled={historyPage === 0}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="text-sm text-muted-foreground">
                  {historyPage + 1} / {historyTotalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setHistoryPage((p) => p + 1)}
                  disabled={historyPage >= historyTotalPages - 1}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            <List className="size-12 mx-auto mb-3 opacity-50" />
            <p>No printed jobs in history</p>
            <p className="text-sm mt-1">Marked printed jobs will appear here</p>
          </div>
        )}
      </Card>
    </div>
  );
}
