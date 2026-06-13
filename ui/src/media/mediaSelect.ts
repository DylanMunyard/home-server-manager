import type { MovieItem, SeriesItem } from '../shared/api.ts';

// Pure sort/filter helpers for the media triage list — applied client-side
// (the snapshot ships the whole library; no server round-trip per control).

export type SortKey = 'title' | 'size' | 'rating' | 'lastWatched' | 'added';
export type SortDir = 1 | -1;   // 1 = ascending, -1 = descending
export type WatchFilter = 'all' | 'never' | 'partial' | 'watched';

// First click on a column gives its triage-natural direction.
export const DEFAULT_DIR: Record<SortKey, SortDir> = {
  title: 1,          // A→Z
  size: -1,          // biggest first
  rating: 1,         // worst first
  lastWatched: -1,   // most recent first (null/never sorts to the end either way)
  added: 1,          // oldest first
};

export type WatchClass = 'never' | 'partial' | 'watched' | 'none'; // none = no plex match

// `viewCount 0 + lastViewedAt set` = started but never finished — Plex tracks
// in-progress plays that way. Distinct from never-touched.
export function movieWatchClass(m: MovieItem): WatchClass {
  if (!m.plex) return 'none';
  if (m.plex.viewCount > 0) return 'watched';
  return m.plex.lastViewedAt ? 'partial' : 'never';
}

export function seriesWatchClass(s: SeriesItem): WatchClass {
  if (!s.plex || s.plex.leafCount === 0) return 'none';
  if (s.plex.viewedLeafCount === 0) return s.plex.lastViewedAt ? 'partial' : 'never';
  return s.plex.viewedLeafCount >= s.plex.leafCount ? 'watched' : 'partial';
}

// Best available rating for a movie, with its source (for the wee tag).
export function movieRating(m: MovieItem): { value: number; source: string } | null {
  const r = m.ratings;
  if (r.imdb) return { value: r.imdb, source: 'imdb' };
  if (r.tmdb) return { value: r.tmdb, source: 'tmdb' };
  if (r.rottenTomatoes) return { value: r.rottenTomatoes / 10, source: 'rt' };  // 0–100 → 0–10
  if (r.metacritic) return { value: r.metacritic / 10, source: 'mc' };
  return null;
}

// External "full details" links for the detail views, best-source first.
export function externalLinks(item: MovieItem | SeriesItem): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  if (item.imdbId) links.push({ label: 'imdb', url: `https://www.imdb.com/title/${item.imdbId}/` });
  if ('seasons' in item) {
    if (item.tvdbId) links.push({ label: 'tvdb', url: `https://thetvdb.com/dereferrer/series/${item.tvdbId}` });
  } else if (item.tmdbId) {
    links.push({ label: 'tmdb', url: `https://www.themoviedb.org/movie/${item.tmdbId}` });
  }
  return links;
}

export function runtimeLabel(minutes: number | undefined): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m ? `${m}m` : ''}`.trim() : `${m}m`;
}

// Distinct genres (categories) across a set of items, A→Z — powers the genre
// filter dropdown. Genres come from the *arrs (Radarr/Sonarr supply them), so
// they're present even when Plex isn't configured.
export function collectGenres(items: (MovieItem | SeriesItem)[]): string[] {
  const set = new Set<string>();
  for (const it of items) for (const g of it.genres ?? []) set.add(g);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// `all` (the sentinel) matches everything; otherwise the item must carry the genre.
export function matchesGenre(item: MovieItem | SeriesItem, genre: string): boolean {
  if (genre === 'all') return true;
  return (item.genres ?? []).includes(genre);
}

// "no plex data" items surface under `all` AND `never` — the delete-FOMO case
// must stay visible, not vanish because Plex never matched the title.
export function matchesWatch(cls: WatchClass, filter: WatchFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'never') return cls === 'never' || cls === 'none';
  return cls === filter;
}

export function sortItems<T extends MovieItem | SeriesItem>(items: T[], key: SortKey, dir: SortDir): T[] {
  const rating = (i: MovieItem | SeriesItem): number =>
    'seasons' in i ? i.rating ?? 0 : movieRating(i)?.value ?? 0;
  const by: Record<SortKey, (a: T, b: T) => number> = {
    title: (a, b) => a.title.localeCompare(b.title),
    size: (a, b) => a.sizeOnDisk - b.sizeOnDisk,
    rating: (a, b) => rating(a) - rating(b),
    lastWatched: (a, b) => (a.plex?.lastViewedAt ?? 0) - (b.plex?.lastViewedAt ?? 0),
    added: (a, b) => (a.added < b.added ? -1 : a.added > b.added ? 1 : 0),
  };
  const sorted = [...items].sort((a, b) => dir * by[key](a, b));
  if (key !== 'lastWatched') return sorted;
  // Never/no-data (lastViewedAt null → 0) always reads best at the end,
  // whichever direction the watched items are going.
  const unwatched = sorted.filter((i) => !i.plex?.lastViewedAt);
  return sorted.filter((i) => i.plex?.lastViewedAt).concat(unwatched);
}
