// Layout of the cards on the printer detail page. Admins rearrange the cards
// by drag-and-drop; the layout is persisted server-side (PostgreSQL
// app_settings) per printer profile, so every printer of a given type shares
// one arrangement.
import type { PrinterProfile } from '../types';

export type CardId =
  | 'currentJob'
  | 'temperature'
  | 'motion'
  | 'cooling'
  | 'filament'
  | 'information';

// A layout is three columns, each an ordered list of card ids.
export type CardLayout = CardId[][];

export const CARD_IDS: CardId[] = [
  'currentJob',
  'temperature',
  'motion',
  'cooling',
  'filament',
  'information',
];

export const CARD_LABELS: Record<CardId, string> = {
  currentJob: 'Current Job',
  temperature: 'Temperature',
  motion: 'Motion Control',
  cooling: 'Cooling',
  filament: 'Current Filament',
  information: 'Information',
};

export const DEFAULT_CARD_LAYOUT: CardLayout = [
  ['currentJob'],
  ['temperature', 'motion', 'cooling', 'filament'],
  ['information'],
];

// Reconcile an arbitrary (possibly stale) saved layout into a valid one:
// always three columns, no duplicates or unknown ids, and every known card
// present exactly once. Cards missing from the saved layout are appended to
// the column they live in by default, so newly added cards never disappear.
export function normalizeCardLayout(input: unknown): CardLayout {
  const columns: CardId[][] = [[], [], []];
  const seen = new Set<CardId>();

  if (Array.isArray(input)) {
    input.slice(0, 3).forEach((column, columnIndex) => {
      if (!Array.isArray(column)) {
        return;
      }
      for (const id of column) {
        if (CARD_IDS.includes(id as CardId) && !seen.has(id as CardId)) {
          seen.add(id as CardId);
          columns[columnIndex].push(id as CardId);
        }
      }
    });
  }

  for (const id of CARD_IDS) {
    if (!seen.has(id)) {
      const defaultColumn = DEFAULT_CARD_LAYOUT.findIndex((column) => column.includes(id));
      columns[defaultColumn >= 0 ? defaultColumn : 2].push(id);
    }
  }

  return columns;
}

function layoutUrl(profile: PrinterProfile): string {
  return `/api/settings/printer-card-layout/${encodeURIComponent(profile)}`;
}

export async function fetchCardLayout(profile: PrinterProfile): Promise<CardLayout> {
  const response = await fetch(layoutUrl(profile), { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  const payload = (await response.json()) as { layout?: unknown };
  return normalizeCardLayout(payload.layout);
}

export async function saveCardLayout(profile: PrinterProfile, layout: CardLayout): Promise<void> {
  const response = await fetch(layoutUrl(profile), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout }),
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }
}
