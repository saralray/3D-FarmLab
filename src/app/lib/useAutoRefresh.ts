import { useEffect, useRef } from 'react';

// Calls `refresh` on mount, on a recurring interval, immediately when the tab
// becomes visible after being hidden, and when the browser reconnects.
export function useAutoRefresh(refresh: () => void, intervalMs: number) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const run = () => refreshRef.current();
    run();
    const id = window.setInterval(run, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
}
