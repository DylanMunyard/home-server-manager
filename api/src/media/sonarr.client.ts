import type { MediaServiceConfig } from './media.config.js';
import { fetchCause } from './media.fetch.js';

// Raw Sonarr v3 resources — only the fields we read (plus the full series
// object passthrough needed for the season-unmonitor PUT).
export type SonarrSeasonStats = { sizeOnDisk?: number; episodeFileCount?: number; totalEpisodeCount?: number };
export type SonarrSeason = { seasonNumber: number; monitored: boolean; statistics?: SonarrSeasonStats };
export type SonarrSeries = {
  id: number;
  title: string;
  year: number;
  tvdbId?: number;
  imdbId?: string;
  monitored: boolean;
  ended?: boolean;
  added?: string;
  path?: string;
  ratings?: { votes?: number; value?: number };  // single tvdb rating — no RT/IMDb for TV
  overview?: string;
  runtime?: number;
  genres?: string[];
  statistics?: SonarrSeasonStats & { episodeCount?: number };
  seasons?: SonarrSeason[];
  [key: string]: unknown;  // PUT round-trips the full resource — preserve the rest
};
export type SonarrEpisodeFile = { id: number; seasonNumber: number; size?: number };

const TIMEOUT_MS = 30_000;

async function sonarrFetch(cfg: MediaServiceConfig, path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: { 'X-Api-Key': cfg.apiKey, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`sonarr ${init?.method ?? 'GET'} ${path}: ${fetchCause(err)}`);
  }
  if (!res.ok) throw new Error(`sonarr ${init?.method ?? 'GET'} ${path} → ${res.status}`);
  return res;
}

export async function getSeries(cfg: MediaServiceConfig): Promise<SonarrSeries[]> {
  const res = await sonarrFetch(cfg, '/api/v3/series');
  return (await res.json()) as SonarrSeries[];
}

export async function deleteSeries(cfg: MediaServiceConfig, id: number): Promise<void> {
  await sonarrFetch(cfg, `/api/v3/series/${id}?deleteFiles=true`, { method: 'DELETE' });
}

/**
 * Season-level delete composite — Sonarr has no season-delete endpoint.
 * Ordering invariant: unmonitor the season FIRST (so Sonarr doesn't re-grab
 * episodes while their files vanish), then bulk-delete the season's files.
 * A season with no files still gets unmonitored (idempotent cleanup).
 */
export async function deleteSeason(cfg: MediaServiceConfig, seriesId: number, seasonNumber: number): Promise<void> {
  // 1. Fresh series resource, flip the season's monitored flag, PUT it back.
  const series = (await (await sonarrFetch(cfg, `/api/v3/series/${seriesId}`)).json()) as SonarrSeries;
  const season = series.seasons?.find((s) => s.seasonNumber === seasonNumber);
  if (!season) throw new Error(`series ${seriesId} has no season ${seasonNumber}`);
  season.monitored = false;
  await sonarrFetch(cfg, `/api/v3/series/${seriesId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(series),
  });

  // 2. Bulk-delete that season's episode files.
  const files = (await (await sonarrFetch(cfg, `/api/v3/episodefile?seriesId=${seriesId}`)).json()) as SonarrEpisodeFile[];
  const ids = files.filter((f) => f.seasonNumber === seasonNumber).map((f) => f.id);
  if (ids.length === 0) return;
  await sonarrFetch(cfg, '/api/v3/episodefile/bulk', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episodeFileIds: ids }),
  });
}
