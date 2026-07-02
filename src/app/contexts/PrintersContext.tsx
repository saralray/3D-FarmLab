import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { Printer } from '../types';
import { fetchPrintersIfChanged } from '../lib/printersApi';
import { normalizePrinter } from '../lib/printerProfiles';
import { useAutoRefresh } from '../lib/useAutoRefresh';

// Single shared printer-list poll for the whole app. Previously the Dashboard,
// Analytics, Queue, and the global PrinterStatusNotifier each ran their own
// interval against /api/printers, so an open dashboard hit the endpoint twice
// every 5s. Centralizing it here means one request per cycle, fanned out to all
// consumers via context.
const POLL_INTERVAL_MS = 8000;

interface PrintersContextValue {
  printers: Printer[];
  // True once the first successful load has completed (lets consumers avoid
  // acting on the empty initial value, e.g. spurious notifications).
  loaded: boolean;
  error: boolean;
  refresh: () => Promise<void>;
}

const PrintersContext = createContext<PrintersContextValue | undefined>(undefined);

export function PrintersProvider({ children }: { children: ReactNode }) {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const isMountedRef = useRef(false);
  const etagRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { printers: next, etag } = await fetchPrintersIfChanged(etagRef.current);
      etagRef.current = etag;
      if (isMountedRef.current) {
        // A 304 (next === null) means the fleet is unchanged since the last
        // poll — skip the state update (and every consumer's re-render) rather
        // than replacing the array with an equivalent copy.
        if (next) {
          setPrinters(next.map(normalizePrinter));
        }
        setLoaded(true);
        setError(false);
      }
    } catch {
      if (isMountedRef.current) {
        setError(true);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useAutoRefresh(refresh, POLL_INTERVAL_MS);

  return (
    <PrintersContext.Provider value={{ printers, loaded, error, refresh }}>
      {children}
    </PrintersContext.Provider>
  );
}

export function usePrinters() {
  const context = useContext(PrintersContext);
  if (context === undefined) {
    throw new Error('usePrinters must be used within a PrintersProvider');
  }
  return context;
}
