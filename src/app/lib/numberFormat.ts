export function roundToMaxTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

export function normalizeMaxTwoDecimals(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? roundToMaxTwoDecimals(value)
    : fallback;
}

export function formatMaxTwoDecimals(value: number) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(roundToMaxTwoDecimals(value));
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

// Binary (1024-based) byte formatting, ≤ 2 decimal places, matching how
// hosting providers typically report data usage (e.g. "1.7 TiB").
export function formatBytes(bytes: number) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  let unitIndex = 0;
  let scaled = value;
  while (scaled >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${formatMaxTwoDecimals(scaled)} ${BYTE_UNITS[unitIndex]}`;
}
