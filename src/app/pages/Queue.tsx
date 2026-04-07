import { useState } from 'react';
import { mockQueue, mockPrinters } from '../data/mockData';
import { PrintJob } from '../types';
import { QueueItem } from '../components/QueueItem';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Plus, List, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';

export function Queue() {
  const [queue, setQueue] = useState<PrintJob[]>(mockQueue);

  const handlePriorityChange = (jobId: string, direction: 'up' | 'down') => {
    setQueue((prev) => {
      const index = prev.findIndex((job) => job.id === jobId);
      if (index === -1) return prev;

      const newQueue = [...prev];
      if (direction === 'up' && index > 0) {
        [newQueue[index - 1], newQueue[index]] = [newQueue[index], newQueue[index - 1]];
      } else if (direction === 'down' && index < newQueue.length - 1) {
        [newQueue[index], newQueue[index + 1]] = [newQueue[index + 1], newQueue[index]];
      }
      return newQueue;
    });
  };

  const handleRemove = (jobId: string) => {
    setQueue((prev) => prev.filter((job) => job.id !== jobId));
    toast.success('Job removed from queue');
  };

  const handleDownload = (job: PrintJob) => {
    // Simulate STL file download
    // In a real app, this would download the actual file from a server
    const blob = new Blob(['STL file content'], { type: 'application/octet-stream' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = job.stlFileUrl || 'file.stl';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    toast.success(`Downloading ${job.stlFileUrl}`);
  };

  const availablePrinters = mockPrinters.filter(
    (p) => p.status === 'idle' || p.status === 'offline'
  ).length;

  const totalEstimatedTime = queue.reduce((acc, job) => acc + job.estimatedTime, 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2 dark:text-white">Print Queue</h1>
          <p className="text-gray-600 dark:text-gray-400">Jobs submitted via Google Form</p>
        </div>
        <Button
          onClick={() => window.open('https://forms.google.com', '_blank')}
          variant="outline"
        >
          <ExternalLink className="size-4 mr-2" />
          Open Google Form
        </Button>
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
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Est. Time</div>
          <div className="text-3xl font-bold mt-1 dark:text-white">
            {Math.floor(totalEstimatedTime / 60)}h {totalEstimatedTime % 60}m
          </div>
        </Card>
      </div>

      <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
        <div className="flex items-center gap-2 mb-4">
          <List className="size-5 dark:text-white" />
          <h2 className="text-xl font-semibold dark:text-white">Submission Queue ({queue.length})</h2>
        </div>

        <div className="text-sm text-gray-600 dark:text-gray-400 mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
          <strong>Note:</strong> These print jobs are automatically imported from the Google Form. 
          Each submission includes the STL file, submitter details, and special instructions.
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
                    onPriorityChange={handlePriorityChange}
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
            <p className="text-sm mt-1">New submissions from Google Form will appear here</p>
          </div>
        )}
      </Card>
    </div>
  );
}