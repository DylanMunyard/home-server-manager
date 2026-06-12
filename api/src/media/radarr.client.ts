import type { MediaServiceConfig } from './media.config.js';
import { fetchCause } from './media.fetch.js';

// Raw Radarr v3 resources — only the fields we read. Mapping to wire types
// lives in media.aggregate.ts (k8s.client/k8s.parse split).
export type RadarrRating = { votes?: number; value?: number };
export type RadarrMovie = {
  id: number;
  title: string;
  year: number;
  sizeOnDisk?: number;
  monitored: boolean;
  added?: string;
  path?: string;
  tmdbId?: number;
  imdbId?: string;
  overview?: string;
  runtime?: number;
  genres?: string[];
  ratings?: { imdb?: RadarrRating; tmdb?: RadarrRating; rottenTomatoes?: RadarrRating; metacritic?: RadarrRating };
};

const TIMEOUT_MS = 30_000;

async function radarrFetch(cfg: MediaServiceConfig, path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: { 'X-Api-Key': cfg.apiKey, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`radarr ${init?.method ?? 'GET'} ${path}: ${fetchCause(err)}`);
  }
  if (!res.ok) throw new Error(`radarr ${init?.method ?? 'GET'} ${path} → ${res.status}`);
  return res;
}

export async function getMovies(cfg: MediaServiceConfig): Promise<RadarrMovie[]> {
  const res = await radarrFetch(cfg, '/api/v3/movie');
  return (await res.json()) as RadarrMovie[];
}

/** Arr-managed delete: removes the movie AND its files; optionally blocks
 *  re-adding via an import exclusion so it can't get re-grabbed. */
export async function deleteMovie(cfg: MediaServiceConfig, id: number, addImportExclusion: boolean): Promise<void> {
  await radarrFetch(
    cfg,
    `/api/v3/movie/${id}?deleteFiles=true&addImportExclusion=${addImportExclusion}`,
    { method: 'DELETE' },
  );
}
