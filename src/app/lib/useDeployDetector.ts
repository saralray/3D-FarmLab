import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

const POLL_INTERVAL_MS = 5 * 60 * 1000;

async function fetchBuildId(): Promise<string | null> {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { buildId?: unknown };
    return typeof data.buildId === 'string' ? data.buildId : null;
  } catch {
    return null;
  }
}

// Polls /api/version every 5 minutes. On the first response the build ID is
// stored as the baseline; if it ever changes (new deploy), shows a persistent
// toast prompting the user to reload. Skips the toast when the tab is hidden
// and re-checks immediately when it becomes visible again.
export function useDeployDetector() {
  const baselineId = useRef<string | null>(null);
  const notified = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      if (notified.current || cancelled) return;
      const current = await fetchBuildId();
      if (cancelled || current === null) return;

      if (baselineId.current === null) {
        baselineId.current = current;
        return;
      }

      if (current !== baselineId.current) {
        notified.current = true;
        toast('Update available', {
          description: 'A new version has been deployed. Reload to get the latest.',
          duration: Infinity,
          action: { label: 'Reload', onClick: () => window.location.reload() },
        });
      }
    };

    void check();
    const id = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
