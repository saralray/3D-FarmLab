import { PrintJob } from '../types';
import { FileText, Check, Download, User, Mail } from 'lucide-react';
import { Button } from './ui/button';

interface QueueItemProps {
  job: PrintJob;
  mode?: 'queue' | 'history';
  onRemove?: (jobId: string) => void;
  onDownload?: (job: PrintJob) => void;
}

export function QueueItem({ job, mode = 'queue', onRemove, onDownload }: QueueItemProps) {
  const formatDate = (dateString?: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  return (
    <div className="flex flex-col gap-3 p-4 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg hover:shadow-sm transition-shadow">
      <div className="flex items-start gap-3">
        <FileText className="size-8 text-gray-400 flex-shrink-0 mt-1" />
        
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate dark:text-white">
                {job.submitterName || job.filename}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {job.fileCount ?? 1} file{(job.fileCount ?? 1) === 1 ? '' : 's'}
              </div>
            </div>
            
            <div className="flex items-center gap-1">
              {job.stlFileUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload?.(job);
                  }}
                  title="Download STL file"
                >
                  <Download className="size-4 text-blue-500" />
                </Button>
              )}
              {mode === 'queue' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove?.(job.id);
                  }}
                  title="Mark as printed"
                >
                  <Check className="size-4 text-green-600" />
                </Button>
              )}
            </div>
          </div>

          {/* Submitter Info */}
          {job.submitterName && (
            <div className="space-y-1 text-sm bg-gray-50 dark:bg-gray-700/50 rounded p-2 mt-2">
              <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <User className="size-3" />
                <span className="font-medium">{job.filename}</span>
              </div>
              {job.submitterEmail && (
                <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                  <Mail className="size-3" />
                  <span className="text-xs">{job.submitterEmail}</span>
                </div>
              )}
              {job.notes && (
                <div className="text-xs text-gray-600 dark:text-gray-400 mt-2 italic">
                  "{job.notes}"
                </div>
              )}
              {job.submittedAt && (
                <div className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                  Submitted: {formatDate(job.submittedAt)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
