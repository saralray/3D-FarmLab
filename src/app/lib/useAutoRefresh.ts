import { useEffect, useRef } from 'react';

// Calls `refresh` on mount, on a recurring interval, immediately when the tab
// becomes visible after being hidden, and when the browser reconnects. The
// interval itself is paused while the tab is hidden — a backgrounded tab has
// no reason to keep polling — and resumes (with an immediate refresh) when it
// becomes visible again.
export function useAutoRefresh(refresh: () => void, intervalMs: number) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const run = () => refreshRef.current();
    run();

    let id: number | undefined;
    const startInterval = () => {
      if (id !== undefined) {
        return;
      }
      id = window.setInterval(run, intervalMs);
    };
    const stopInterval = () => {
      if (id !== undefined) {
        window.clearInterval(id);
        id = undefined;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        run();
        startInterval();
      } else {
        stopInterval();
      }
    };

    if (document.visibilityState === 'visible') {
      startInterval();
    }
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopInterval();
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
}
