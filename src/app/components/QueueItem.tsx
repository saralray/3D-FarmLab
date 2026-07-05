import { useState } from 'react';
import { PrintJob } from '../types';
import { FileText, Check, Download, Layers, User, Mail, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

interface QueueItemProps {
  job: PrintJob;
  mode?: 'queue' | 'history';
  onRemove?: (jobId: string) => void;
  onDelete?: (jobId: string) => void;
  onDownload?: (job: PrintJob) => void;
  onOpenInSlicer?: (job: PrintJob) => void;
  canManage?: boolean;
  canDelete?: boolean;
  canDownload?: boolean;
}

export function QueueItem({
  job,
  mode = 'queue',
  onRemove,
  onDelete,
  onDownload,
  onOpenInSlicer,
  canManage = true,
  canDelete = false,
  canDownload = true,
}: QueueItemProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
    <div className="flex flex-col gap-3 p-4 bg-card border border-border rounded-lg hover:shadow-sm transition-shadow">
      <div className="flex items-start gap-3">
        <FileText className="size-8 text-muted-foreground flex-shrink-0 mt-1" />
        
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate text-foreground">
                {job.submitterName || job.filename}
              </div>
              <div className="text-sm text-muted-foreground mt-1">
                {job.fileCount ?? 1} piece{(job.fileCount ?? 1) === 1 ? '' : 's'}
              </div>
            </div>
            
            <div className="flex items-center gap-1">
              {canDownload && job.stlFileUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload?.(job);
                  }}
                  title="Download file"
                >
                  <Download className="size-4 text-blue-500" />
                </Button>
              )}
              {canDownload && job.stlFileUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenInSlicer?.(job);
                  }}
                  title="Open in slicer"
                >
                  <Layers className="size-4 text-purple-500" />
                </Button>
              )}
              {canManage && mode === 'queue' && (
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
              {canManage && job.submitterEmail && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    const subject = `Your 3D Print Request — ${job.filename}`;
                    const body = [
                      `Hi ${job.submitterName || 'there'},`,
                      '',
                      `We have received your 3D print request for "${job.filename}" (${job.fileCount ?? 1} piece${(job.fileCount ?? 1) === 1 ? '' : 's'}).`,
                      '',
                      'Our staff will review and queue your job.',
                      '',
                      '— STEM Lab Print Farm',
                    ].join('\n');
                    window.open(
                      `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(job.submitterEmail!)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
                      '_blank',
                      'noopener,noreferrer',
                    );
                  }}
                  title={`Send email to ${job.submitterEmail}`}
                >
                  <Mail className="size-4 text-sky-500" />
                </Button>
              )}
              {canDelete && (
                <Popover open={confirmingDelete} onOpenChange={setConfirmingDelete}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Delete job"
                      title="Delete job"
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent dark:hover:bg-accent/50"
                    >
                      <Trash2 className="size-4 text-red-600" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    onClick={(e) => e.stopPropagation()}
                    className="w-auto p-3"
                  >
                    <p className="text-sm font-medium text-foreground">Delete this queue job?</p>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingDelete(false);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingDelete(false);
                          onDelete?.(job.id);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>

          {/* Submitter Info */}
          {job.submitterName && (
            <div className="space-y-1 text-sm bg-muted rounded p-2 mt-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <User className="size-3 flex-shrink-0" />
                <span className="font-medium truncate min-w-0">{job.filename}</span>
              </div>
              {job.submitterEmail && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Mail className="size-3 flex-shrink-0" />
                  <span className="text-xs truncate min-w-0">{job.submitterEmail}</span>
                </div>
              )}
              {job.notes && (
                <div className="text-xs text-muted-foreground mt-2 italic">
                  "{job.notes}"
                </div>
              )}
              {job.submittedAt && (
                <div className="text-xs text-muted-foreground mt-1">
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
