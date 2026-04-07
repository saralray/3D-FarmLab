import { PrintJob } from '../types';
import { Clock, FileText, ArrowUp, ArrowDown, Minus, Download, User, Mail } from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface QueueItemProps {
  job: PrintJob;
  onPriorityChange?: (jobId: string, direction: 'up' | 'down') => void;
  onRemove?: (jobId: string) => void;
  onDownload?: (job: PrintJob) => void;
}

export function QueueItem({ job, onPriorityChange, onRemove, onDownload }: QueueItemProps) {
  const getPriorityColor = () => {
    switch (job.priority) {
      case 'high':
        return 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 border-red-300 dark:border-red-700';
      case 'medium':
        return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300 border-yellow-300 dark:border-yellow-700';
      case 'low':
        return 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 border-green-300 dark:border-green-700';
    }
  };

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
              <div className="font-medium truncate dark:text-white">{job.filename}</div>
              <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400 mt-1">
                <div className="flex items-center gap-1">
                  <Clock className="size-3" />
                  {job.estimatedTime} min
                </div>
                <Badge className={getPriorityColor()} variant="outline">
                  {job.priority}
                </Badge>
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
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onPriorityChange?.(job.id, 'up');
                }}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onPriorityChange?.(job.id, 'down');
                }}
              >
                <ArrowDown className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove?.(job.id);
                }}
              >
                <Minus className="size-4 text-red-500" />
              </Button>
            </div>
          </div>

          {/* Submitter Info */}
          {job.submitterName && (
            <div className="space-y-1 text-sm bg-gray-50 dark:bg-gray-700/50 rounded p-2 mt-2">
              <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <User className="size-3" />
                <span className="font-medium">{job.submitterName}</span>
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