// Wire types for the media cleanup view — mirrored into ui/src/shared/api.ts
// (same convention as metrics.types.ts / k8s.types.ts). Keep the items slim:
// the snapshot ships the whole library in one JSON payload, sorted/filtered
// client-side.

export type MediaServiceId = 'radarr' | 'sonarr' | 'plex';

export type MediaServiceState =
  | { state: 'ok' }
  | { state: 'disabled'; reason: string }   // not configured / env var unset
  | { state: 'error'; error: string };      // configured but the last fetch failed

// Plex watch state. `null` on an item = no Plex match — render a "no plex
// data" badge, never treat it as an error (the FOMO case must stay visible).
export type PlexMovieWatch = { viewCount: number; lastViewedAt: number | null };
export type PlexShowWatch = { leafCount: number; viewedLeafCount: number; lastViewedAt: number | null };
export type PlexSeasonWatch = { leafCount: number; viewedLeafCount: number };

export type MovieItem = {
  id: number;                 // Radarr movie id
  title: string;
  year: number;
  sizeOnDisk: number;         // bytes
  monitored: boolean;
  added: string;              // ISO date Radarr added it
  path: string;
  tmdbId?: number;
  imdbId?: string;
  overview?: string;          // arr-supplied plot summary, for the detail view
  runtime?: number;           // minutes
  genres?: string[];
  // Flattened ratings (value only) — Radarr exposes several sources.
  ratings: { imdb?: number; tmdb?: number; rottenTomatoes?: number; metacritic?: number };
  plex: PlexMovieWatch | null;
};

export type SeasonItem = {
  seasonNumber: number;       // 0 = specials (lines up with Plex's index)
  monitored: boolean;
  sizeOnDisk: number;
  episodeFileCount: number;
  totalEpisodeCount: number;
  plex: PlexSeasonWatch | null;
};

export type SeriesItem = {
  id: number;                 // Sonarr series id
  title: string;
  year: number;
  tvdbId?: number;
  imdbId?: string;
  monitored: boolean;
  ended: boolean;
  added: string;
  path: string;
  sizeOnDisk: number;
  episodeFileCount: number;
  totalEpisodeCount: number;
  rating?: number;            // Sonarr's single ratings.value (tvdb) — no RT/IMDb for TV
  overview?: string;
  runtime?: number;           // minutes per episode
  genres?: string[];
  seasons: SeasonItem[];
  plex: PlexShowWatch | null;
};

export type MediaSnapshot = {
  fetchedAt: number;          // unix ms of the last successful aggregation; 0 = never
  services: Record<MediaServiceId, MediaServiceState>;
  movies: MovieItem[];        // empty when radarr is disabled/errored with no prior data
  series: SeriesItem[];
};

// Cheap config-only gate for UI affordance visibility (analogue of /api/ai/status).
export type MediaStatus = {
  enabled: boolean;                            // radarr || sonarr configured
  services: Record<MediaServiceId, boolean>;   // configured?
};
