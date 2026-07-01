import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Download, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { fetchUpdateStatus, applyUpdate, type UpdateStatus } from '../lib/updateApi';

const short = (sha: string | null | undefined) =>
  typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 7) : '—';

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Admin-only "update available" card. Compares the running image's commit SHA
// (baked at build time) against the latest published commit, and — when a
// Watchtower sidecar is configured — applies the update in place.
export function SoftwareUpdateSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const next = await fetchUpdateStatus();
    setStatus(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleApply = async () => {
    setApplying(true);
    const result = await applyUpdate();
    if (result.ok) {
      toast('Update started', {
        description:
          'Pulling the new version and restarting. The site will briefly go offline, then reload once it is back.',
        duration: Infinity,
      });
    } else {
      toast.error(result.error || 'Could not start the update.');
      setApplying(false);
    }
  };

  // Feature turned off on the server → nothing to show.
  if (!loading && status && !status.enabled) {
    return null;
  }

  const updateAvailable = Boolean(status?.updateAvailable);
  const canApply = Boolean(status?.canApply);

  return (
    <Card className="p-6 dark:bg-gray-900 dark:border-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-base font-medium">Software updates</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Check whether a newer published version of the print-farm app is
            available for this site.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading || applying}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          Check again
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        {loading && !status ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Checking…</p>
        ) : status?.error ? (
          <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" />
            Could not reach the update server. Showing the running version only.
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span className="text-gray-600 dark:text-gray-400">
            Running: <code className="font-mono">{short(status?.current)}</code>
          </span>
          {status?.latest ? (
            <span className="text-gray-600 dark:text-gray-400">
              Latest: <code className="font-mono">{short(status?.latest)}</code>
              {relativeTime(status?.latestCommittedAt) ? (
                <span className="text-gray-400"> · {relativeTime(status?.latestCommittedAt)}</span>
              ) : null}
            </span>
          ) : null}
        </div>

        {updateAvailable ? (
          <div className="space-y-3">
            <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30">
              Update available
            </Badge>
            {canApply ? (
              <div>
                <Button onClick={() => void handleApply()} disabled={applying}>
                  {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {applying ? 'Updating…' : 'Update now'}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                One-click apply is not configured on this host. Update from the
                server with:
                <code className="mt-1 block rounded bg-gray-100 px-2 py-1 font-mono text-xs dark:bg-gray-800">
                  docker compose -f docker-compose.yml -f docker-compose.deploy.yml pull &amp;&amp; docker compose -f docker-compose.yml -f docker-compose.deploy.yml up -d
                </code>
              </p>
            )}
          </div>
        ) : status && !status.error && status.latest ? (
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" />
            You are on the latest version.
          </div>
        ) : null}
      </div>
    </Card>
  );
}
