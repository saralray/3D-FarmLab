import { useEffect, useState } from 'react';

// Personal viewing-density preference for the Dashboard's printer-card grid —
// stored per-browser (like a theme choice), not synced through app_settings,
// so it works the same for every viewer including public-viewer mode.
export type CardSize = 'sm' | 'md' | 'lg';

const STORAGE_KEY = 'dashboard-card-size';
const DEFAULT_SIZE: CardSize = 'md';

function isCardSize(value: unknown): value is CardSize {
  return value === 'sm' || value === 'md' || value === 'lg';
}

function readStoredSize(): CardSize {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isCardSize(stored) ? stored : DEFAULT_SIZE;
  } catch {
    return DEFAULT_SIZE;
  }
}

export function useDashboardCardSize(): [CardSize, (size: CardSize) => void] {
  const [size, setSize] = useState<CardSize>(readStoredSize);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, size);
    } catch {
      // Ignore write failures (e.g. private browsing) — falls back to
      // in-memory state for the rest of the session.
    }
  }, [size]);

  return [size, setSize];
}
