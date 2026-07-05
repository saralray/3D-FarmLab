import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Download, Loader2, Upload } from 'lucide-react';
import { Card } from './ui/card';
import { Button } from './ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { restoreBackup } from '../lib/backupApi';

// Admin-only "Backup & Restore" card (Settings → System, alongside
// SoftwareUpdateSettings). Backup is a full data dump — everything the app
// considers data (printers, filament inventory, queue history + stored model
// files, app_settings incl. branding/automation/SSO/staff users, API keys,
// audit logs, maintenance, network usage) — so restoring is correspondingly
// destructive; that's why it's gated behind an explicit confirmation dialog
// rather than firing on file selection.
export function BackupSettings() {
  const [restoring, setRestoring] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDownload = () => {
    const anchor = document.createElement('a');
    anchor.href = '/api/admin/backup/download';
    anchor.download = '';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    toast.success('Started backup download');
  };

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (file) {
      setPendingFile(file);
    }
  };

  const handleConfirmRestore = async () => {
    const file = pendingFile;
    if (!file) return;
    setRestoring(true);
    const result = await restoreBackup(file);
    if (result.ok) {
      toast.success('Backup restored — reloading…', { duration: Infinity });
      window.setTimeout(() => window.location.reload(), 1500);
      return;
    }
    toast.error(result.error || 'Restore failed; no changes were made.');
    setRestoring(false);
  };

  return (
    <Card className="p-6">
      <div className="space-y-1">
        <h3 className="text-base font-medium">Backup &amp; Restore</h3>
        <p className="text-sm text-muted-foreground">
          Download a complete backup of the print farm's data — printers,
          filament inventory, queue history and uploaded model files,
          settings, API keys, and more — as a single .zip file, or restore
          from one.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <Button onClick={handleDownload} disabled={restoring}>
          <Download className="h-4 w-4" />
          Create &amp; Download Backup
        </Button>
        <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={restoring}>
          {restoring ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {restoring ? 'Restoring…' : 'Restore from Backup'}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={handleFileSelected}
        />
      </div>

      <AlertDialog open={pendingFile !== null} onOpenChange={(open) => !open && setPendingFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Restore from backup?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left">
                <p>
                  This replaces <strong>all current data</strong> — printers, filament
                  inventory, queue history, settings, and API keys — with the
                  contents of <strong>{pendingFile?.name}</strong>. This cannot be undone.
                </p>
                <p>
                  Printer polling may show transient errors while the restore runs, and
                  you may need to log back in afterward.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmRestore()}>
              Restore &amp; overwrite
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
