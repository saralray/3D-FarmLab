// Grid layout for the Analytics page cards. Admins drag and resize the cards
// on a 10-column react-grid-layout grid; the arrangement is persisted
// server-side (PostgreSQL app_settings) and shared by everyone, mirroring the
// printer-detail card layout in cardLayoutApi.ts.

export type AnalyticsCardId =
  | 'totalJobs'
  | 'successRate'
  | 'printTime'
  | 'avgPrintTime'
  | 'filamentUsed'
  | 'dailyPerformance'
  | 'currentStatus'
  | 'printerUtilization'
  | 'filamentUsage';

// One grid item: which card (`i`) and its position/size in grid units.
export interface AnalyticsLayoutItem {
  i: AnalyticsCardId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnalyticsLayout = AnalyticsLayoutItem[];

export const ANALYTICS_GRID_COLS = 10;

export const ANALYTICS_CARD_IDS: AnalyticsCardId[] = [
  'totalJobs',
  'successRate',
  'printTime',
  'avgPrintTime',
  'filamentUsed',
  'dailyPerformance',
  'currentStatus',
  'printerUtilization',
  'filamentUsage',
];

export const ANALYTICS_CARD_LABELS: Record<AnalyticsCardId, string> = {
  totalJobs: 'Total Jobs',
  successRate: 'Success Rate',
  printTime: 'Print Time',
  avgPrintTime: 'Avg Print Time',
  filamentUsed: 'Filament Used',
  dailyPerformance: 'Daily Performance',
  currentStatus: 'Current Status',
  printerUtilization: 'Printer Utilization',
  filamentUsage: 'Filament Usage',
};

// Smallest size each card can be resized to, so charts stay legible.
export const ANALYTICS_CARD_MIN_SIZE: Record<AnalyticsCardId, { w: number; h: number }> = {
  totalJobs: { w: 2, h: 3 },
  successRate: { w: 2, h: 3 },
  printTime: { w: 2, h: 3 },
  avgPrintTime: { w: 2, h: 3 },
  filamentUsed: { w: 2, h: 3 },
  dailyPerformance: { w: 4, h: 5 },
  currentStatus: { w: 3, h: 5 },
  printerUtilization: { w: 4, h: 5 },
  filamentUsage: { w: 4, h: 5 },
};

// Default arrangement: the five stat cards across the top, then the charts.
export const DEFAULT_ANALYTICS_LAYOUT: AnalyticsLayout = [
  { i: 'totalJobs', x: 0, y: 0, w: 2, h: 3 },
  { i: 'successRate', x: 2, y: 0, w: 2, h: 3 },
  { i: 'printTime', x: 4, y: 0, w: 2, h: 3 },
  { i: 'avgPrintTime', x: 6, y: 0, w: 2, h: 3 },
  { i: 'filamentUsed', x: 8, y: 0, w: 2, h: 3 },
  { i: 'dailyPerformance', x: 0, y: 3, w: 6, h: 8 },
  { i: 'currentStatus', x: 6, y: 3, w: 4, h: 8 },
  { i: 'printerUtilization', x: 0, y: 11, w: 5, h: 8 },
  { i: 'filamentUsage', x: 5, y: 11, w: 5, h: 8 },
];

function defaultItem(id: AnalyticsCardId): AnalyticsLayoutItem {
  return (
    DEFAULT_ANALYTICS_LAYOUT.find((item) => item.i === id) ?? { i: id, x: 0, y: 0, w: 2, h: 3 }
  );
}

// Reconcile an arbitrary (possibly stale) saved layout into a valid one: keep
// only known cards, no duplicates, and ensure every card is present exactly
// once so a newly added card never disappears. Non-numeric fields fall back to
// the card's default position/size.
export function normalizeAnalyticsLayout(input: unknown): AnalyticsLayout {
  const result: AnalyticsLayout = [];
  const seen = new Set<AnalyticsCardId>();

  if (Array.isArray(input)) {
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const id = (raw as { i?: unknown }).i as AnalyticsCardId;
      if (!ANALYTICS_CARD_IDS.includes(id) || seen.has(id)) {
        continue;
      }
      const fallback = defaultItem(id);
      const num = (value: unknown, fallbackValue: number) =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallbackValue;
      const min = ANALYTICS_CARD_MIN_SIZE[id];
      seen.add(id);
      result.push({
        i: id,
        x: num((raw as AnalyticsLayoutItem).x, fallback.x),
        y: num((raw as AnalyticsLayoutItem).y, fallback.y),
        w: Math.max(num((raw as AnalyticsLayoutItem).w, fallback.w), min.w),
        h: Math.max(num((raw as AnalyticsLayoutItem).h, fallback.h), min.h),
      });
    }
  }

  for (const id of ANALYTICS_CARD_IDS) {
    if (!seen.has(id)) {
      result.push(defaultItem(id));
    }
  }

  return result;
}

const LAYOUT_URL = '/api/settings/analytics-layout';

export async function fetchAnalyticsLayout(): Promise<AnalyticsLayout> {
  const response = await fetch(LAYOUT_URL, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  const payload = (await response.json()) as { layout?: unknown };
  return normalizeAnalyticsLayout(payload.layout);
}

export async function saveAnalyticsLayout(layout: AnalyticsLayout): Promise<void> {
  const response = await fetch(LAYOUT_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout }),
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }
}
