import { loadMediaConfig } from './media.config.js';
import type { MediaConfig } from './media.config.js';
import { getMovies } from './radarr.client.js';
import type { RadarrMovie } from './radarr.client.js';
import { getSeries } from './sonarr.client.js';
import type { SonarrSeries } from './sonarr.client.js';
import { getPlexLibrary } from './plex.client.js';
import type { PlexLibrary, PlexSeasonEntry } from './plex.client.js';
import type {
  MediaServiceState, MediaSnapshot, MovieItem, SeasonItem, SeriesItem,
} from './media.types.js';

/**
 * In-memory cache + join engine. No persistence by design (clone-and-go):
 * module-level state only, refilled on demand. TTL + single-flight keep the
 * expensive three-service pull rare; a failed service carries forward its
 * items from the last good snapshot (stale beats blank in a triage view).
 * Nothing here ever throws to the routes — failures become `state: 'error'`.
 */
const TTL_MS = 15 * 60_000;

let cache: MediaSnapshot | null = null;
let inflight: Promise<MediaSnapshot> | null = null;

export async function getSnapshot(opts?: { force?: boolean }): Promise<MediaSnapshot> {
  if (!opts?.force && cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = refresh().finally(() => { inflight = null; });
  return inflight;
}

async function refresh(): Promise<MediaSnapshot> {
  const config = await loadMediaConfig();

  const [radarrRes, sonarrRes, plexRes] = await Promise.allSettled([
    config.radarr ? getMovies(config.radarr) : Promise.reject(new Error('disabled')),
    config.sonarr ? getSeries(config.sonarr) : Promise.reject(new Error('disabled')),
    config.plex ? getPlexLibrary(config.plex) : Promise.reject(new Error('disabled')),
  ]);

  const plex = plexRes.status === 'fulfilled' ? plexRes.value : null;
  const snapshot: MediaSnapshot = {
    fetchedAt: Date.now(),
    services: {
      radarr: serviceState('radarr', config, radarrRes),
      sonarr: serviceState('sonarr', config, sonarrRes),
      plex: serviceState('plex', config, plexRes),
    },
    // Only items with bytes on disk — it's a *disk* triage view, and Radarr's
    // full list includes everything merely wanted/monitored. Carry-forward is
    // for transient errors only; a disabled service shows empty, not stale.
    movies: radarrRes.status === 'fulfilled' ? joinMovies(radarrRes.value, plex)
      : config.radarr ? cache?.movies ?? [] : [],
    series: sonarrRes.status === 'fulfilled' ? joinSeries(sonarrRes.value, plex)
      : config.sonarr ? cache?.series ?? [] : [],
  };

  cache = snapshot;
  return snapshot;
}

function serviceState(
  id: 'radarr' | 'sonarr' | 'plex',
  config: MediaConfig,
  res: PromiseSettledResult<unknown>,
): MediaServiceState {
  if (!config[id]) return { state: 'disabled', reason: config.disabledReason[id] ?? 'not configured' };
  if (res.status === 'rejected') return { state: 'error', error: (res.reason as Error).message };
  return { state: 'ok' };
}

// Poster artwork for the detail view: the `poster` image's public source URL
// (remoteUrl — a TMDB/thetvdb CDN link, browser-loadable). The arr-local `url`
// needs the arr's API key + reachability, so we don't surface it.
function posterUrl(images?: { coverType?: string; remoteUrl?: string }[]): string | undefined {
  return images?.find((i) => i.coverType === 'poster')?.remoteUrl || undefined;
}

function joinMovies(raw: RadarrMovie[], plex: PlexLibrary | null): MovieItem[] {
  const byTmdb = new Map(plex?.movies.filter((m) => m.tmdbId).map((m) => [m.tmdbId!, m]) ?? []);
  const byImdb = new Map(plex?.movies.filter((m) => m.imdbId).map((m) => [m.imdbId!, m]) ?? []);

  return raw
    .filter((m) => (m.sizeOnDisk ?? 0) > 0)
    .map((m) => {
      const match = (m.tmdbId && byTmdb.get(m.tmdbId)) || (m.imdbId && byImdb.get(m.imdbId)) || null;
      return {
        id: m.id,
        title: m.title,
        year: m.year,
        sizeOnDisk: m.sizeOnDisk ?? 0,
        monitored: m.monitored,
        added: m.added ?? '',
        path: m.path ?? '',
        tmdbId: m.tmdbId,
        imdbId: m.imdbId,
        overview: m.overview || undefined,
        runtime: m.runtime || undefined,
        genres: m.genres?.length ? m.genres : undefined,
        poster: posterUrl(m.images),
        ratings: {
          imdb: m.ratings?.imdb?.value || undefined,
          tmdb: m.ratings?.tmdb?.value || undefined,
          rottenTomatoes: m.ratings?.rottenTomatoes?.value || undefined,
          metacritic: m.ratings?.metacritic?.value || undefined,
        },
        plex: match ? { viewCount: match.viewCount, lastViewedAt: match.lastViewedAt } : null,
      };
    });
}

function joinSeries(raw: SonarrSeries[], plex: PlexLibrary | null): SeriesItem[] {
  const byTvdb = new Map(plex?.shows.filter((s) => s.tvdbId).map((s) => [s.tvdbId!, s]) ?? []);
  const seasonsByShow = new Map<string, PlexSeasonEntry[]>();
  for (const se of plex?.seasons ?? []) {
    const list = seasonsByShow.get(se.showRatingKey) ?? [];
    list.push(se);
    seasonsByShow.set(se.showRatingKey, list);
  }

  return raw
    .filter((s) => (s.statistics?.sizeOnDisk ?? 0) > 0)
    .map((s) => {
      const show = (s.tvdbId && byTvdb.get(s.tvdbId)) || null;
      const plexSeasons = show ? seasonsByShow.get(show.ratingKey) ?? [] : [];

      const seasons: SeasonItem[] = (s.seasons ?? [])
        .filter((se) => (se.statistics?.episodeFileCount ?? 0) > 0)
        .map((se) => {
          // Plex season `index` lines up with Sonarr's seasonNumber (0 = specials).
          const ps = plexSeasons.find((p) => p.index === se.seasonNumber) ?? null;
          return {
            seasonNumber: se.seasonNumber,
            monitored: se.monitored,
            sizeOnDisk: se.statistics?.sizeOnDisk ?? 0,
            episodeFileCount: se.statistics?.episodeFileCount ?? 0,
            totalEpisodeCount: se.statistics?.totalEpisodeCount ?? 0,
            plex: ps ? { leafCount: ps.leafCount, viewedLeafCount: ps.viewedLeafCount } : null,
          };
        });

      return {
        id: s.id,
        title: s.title,
        year: s.year,
        tvdbId: s.tvdbId,
        imdbId: s.imdbId,
        monitored: s.monitored,
        ended: s.ended ?? false,
        added: s.added ?? '',
        path: s.path ?? '',
        sizeOnDisk: s.statistics?.sizeOnDisk ?? 0,
        episodeFileCount: s.statistics?.episodeFileCount ?? 0,
        totalEpisodeCount: s.statistics?.totalEpisodeCount ?? 0,
        rating: s.ratings?.value || undefined,
        overview: s.overview || undefined,
        runtime: s.runtime || undefined,
        genres: s.genres?.length ? s.genres : undefined,
        poster: posterUrl(s.images),
        seasons,
        plex: show
          ? { leafCount: show.leafCount, viewedLeafCount: show.viewedLeafCount, lastViewedAt: show.lastViewedAt }
          : null,
      };
    });
}

/**
 * Optimistic cache mutation after a successful delete, so the next GET
 * reflects it instantly, then a fire-and-forget background refresh trues
 * everything up without making the caller wait for a full 3-service pull.
 */
export function applyDelete(
  action:
    | { kind: 'movie'; id: number }
    | { kind: 'series'; id: number }
    | { kind: 'season'; seriesId: number; seasonNumber: number },
): void {
  if (cache) {
    if (action.kind === 'movie') {
      cache.movies = cache.movies.filter((m) => m.id !== action.id);
    } else if (action.kind === 'series') {
      cache.series = cache.series.filter((s) => s.id !== action.id);
    } else {
      const series = cache.series.find((s) => s.id === action.seriesId);
      const season = series?.seasons.find((se) => se.seasonNumber === action.seasonNumber);
      if (series && season) {
        series.sizeOnDisk -= season.sizeOnDisk;
        series.episodeFileCount -= season.episodeFileCount;
        series.seasons = series.seasons.filter((se) => se.seasonNumber !== action.seasonNumber);
      }
    }
  }
  getSnapshot({ force: true }).catch(() => { /* next GET retries */ });
}
