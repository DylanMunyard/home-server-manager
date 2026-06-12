// Shared display formatters (first lifted out of FileBrowser when the media
// view became a second consumer).

const KB = 1024;
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

export function humanSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(KB)));
  const v = bytes / KB ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${UNITS[i]}`;
}

/** Coarse "3mo ago" from unix seconds — triage needs the era, not the date. */
export function relativeTime(unixSec: number | null | undefined): string {
  if (!unixSec) return '';
  const days = Math.floor((Date.now() / 1000 - unixSec) / 86400);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
