import type { MediaServiceConfig } from './media.config.js';
import { fetchCause } from './media.fetch.js';

/**
 * Plex reads — JSON via Accept header, X-Plex-Token auth. Full section pulls
 * can be a few MB of JSON on a big library; they're transient per refresh
 * (mapped into small lookup structures and dropped), never cached raw.
 * Seasons come from ONE `?type=3` section query — never per-show children
 * calls (that's N+1 over HTTP).
 */
type PlexGuid = { id?: string };
type PlexMetadata = {
  ratingKey?: string;
  grandparentRatingKey?: string;  // the show, on episode (type=4) items
  parentIndex?: number;           // season number, on episode items
  viewCount?: number;
  lastViewedAt?: number;      // unix seconds
  leafCount?: number;
  viewedLeafCount?: number;
  Guid?: PlexGuid[];
};
type PlexContainer<T> = { MediaContainer?: { Metadata?: T[]; Directory?: T[] } };
type PlexSection = { key: string; type: string };

export type ExternalIds = { tmdbId?: number; tvdbId?: number; imdbId?: string };
export type PlexMovieEntry = ExternalIds & { viewCount: number; lastViewedAt: number | null };
export type PlexShowEntry = ExternalIds & {
  ratingKey: string;
  leafCount: number;
  viewedLeafCount: number;
  lastViewedAt: number | null;
};
export type PlexSeasonEntry = { showRatingKey: string; index: number; leafCount: number; viewedLeafCount: number };

export type PlexLibrary = {
  movies: PlexMovieEntry[];
  shows: PlexShowEntry[];
  seasons: PlexSeasonEntry[];
};

const TIMEOUT_MS = 30_000;

async function plexFetch<T>(cfg: MediaServiceConfig, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      headers: { 'X-Plex-Token': cfg.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`plex GET ${path}: ${fetchCause(err)}`);
  }
  if (!res.ok) throw new Error(`plex GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export function parseGuids(guids: PlexGuid[] | undefined): ExternalIds {
  const out: ExternalIds = {};
  for (const g of guids ?? []) {
    const m = /^(tmdb|tvdb|imdb):\/\/(.+)$/.exec(g.id ?? '');
    if (!m) continue;
    if (m[1] === 'tmdb') out.tmdbId = Number(m[2]);
    else if (m[1] === 'tvdb') out.tvdbId = Number(m[2]);
    else out.imdbId = m[2];
  }
  return out;
}

/** One pass over every movie + show section, correlation-ready. */
export async function getPlexLibrary(cfg: MediaServiceConfig): Promise<PlexLibrary> {
  const sections = await plexFetch<PlexContainer<PlexSection>>(cfg, '/library/sections');
  const dirs = sections.MediaContainer?.Directory ?? [];

  const lib: PlexLibrary = { movies: [], shows: [], seasons: [] };
  for (const sec of dirs) {
    if (sec.type === 'movie') {
      const items = await plexFetch<PlexContainer<PlexMetadata>>(
        cfg, `/library/sections/${sec.key}/all?includeGuids=1`);
      for (const it of items.MediaContainer?.Metadata ?? []) {
        lib.movies.push({
          ...parseGuids(it.Guid),
          viewCount: it.viewCount ?? 0,
          lastViewedAt: it.lastViewedAt ?? null,
        });
      }
    } else if (sec.type === 'show') {
      // Per-season watch state comes from ONE episode-level (?type=4) pull,
      // aggregated here: the season listing (?type=3) on current PMS doesn't
      // include leafCount/viewedLeafCount. Still a single request — never
      // per-show children calls (N+1 over HTTP).
      const [shows, episodes] = await Promise.all([
        plexFetch<PlexContainer<PlexMetadata>>(cfg, `/library/sections/${sec.key}/all?includeGuids=1`),
        plexFetch<PlexContainer<PlexMetadata>>(cfg, `/library/sections/${sec.key}/all?type=4`),
      ]);
      for (const it of shows.MediaContainer?.Metadata ?? []) {
        if (!it.ratingKey) continue;
        lib.shows.push({
          ...parseGuids(it.Guid),
          ratingKey: it.ratingKey,
          leafCount: it.leafCount ?? 0,
          viewedLeafCount: it.viewedLeafCount ?? 0,
          lastViewedAt: it.lastViewedAt ?? null,
        });
      }
      const bySeason = new Map<string, PlexSeasonEntry>();
      for (const ep of episodes.MediaContainer?.Metadata ?? []) {
        if (!ep.grandparentRatingKey || ep.parentIndex === undefined) continue;
        const k = `${ep.grandparentRatingKey}:${ep.parentIndex}`;
        let se = bySeason.get(k);
        if (!se) {
          se = { showRatingKey: ep.grandparentRatingKey, index: ep.parentIndex, leafCount: 0, viewedLeafCount: 0 };
          bySeason.set(k, se);
        }
        se.leafCount += 1;
        if ((ep.viewCount ?? 0) > 0) se.viewedLeafCount += 1;
      }
      lib.seasons.push(...bySeason.values());
    }
  }
  return lib;
}
