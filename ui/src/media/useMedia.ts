import { useCallback, useEffect, useState } from 'react';
import {
  deleteMovie, deleteSeason, deleteSeries, fetchMedia, refreshMedia,
  type MediaSnapshot,
} from '../shared/api.ts';

// The media view's single data hook, shared by both shells (never fork hook
// logic per shell). Snapshot + refresh + arr-managed deletes; after a
// successful delete the local snapshot is updated the same way the server's
// applyDelete mutates its cache, so the row vanishes without a refetch.
export function useMedia() {
  const [snapshot, setSnapshot] = useState<MediaSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 'movie:12' / 'series:34' / 'season:34:2' while its delete is in flight.
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  useEffect(() => {
    fetchMedia()
      .then((s) => { setSnapshot(s); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    refreshMedia()
      .then((s) => { setSnapshot(s); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setRefreshing(false));
  }, []);

  const runDelete = useCallback(async (
    key: string,
    call: () => Promise<{ ok: boolean; error?: string }>,
    apply: (s: MediaSnapshot) => MediaSnapshot,
  ): Promise<string | null> => {
    setDeletingKey(key);
    try {
      const res = await call();
      if (!res.ok) return res.error ?? 'delete failed';
      setSnapshot((s) => (s ? apply(s) : s));
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      setDeletingKey(null);
    }
  }, []);

  const removeMovie = useCallback((id: number, addImportExclusion: boolean) =>
    runDelete(`movie:${id}`, () => deleteMovie(id, addImportExclusion), (s) => ({
      ...s, movies: s.movies.filter((m) => m.id !== id),
    })), [runDelete]);

  const removeSeries = useCallback((id: number) =>
    runDelete(`series:${id}`, () => deleteSeries(id), (s) => ({
      ...s, series: s.series.filter((x) => x.id !== id),
    })), [runDelete]);

  const removeSeason = useCallback((seriesId: number, seasonNumber: number) =>
    runDelete(`season:${seriesId}:${seasonNumber}`, () => deleteSeason(seriesId, seasonNumber), (s) => ({
      ...s,
      series: s.series.map((x) => {
        if (x.id !== seriesId) return x;
        const season = x.seasons.find((se) => se.seasonNumber === seasonNumber);
        if (!season) return x;
        return {
          ...x,
          sizeOnDisk: x.sizeOnDisk - season.sizeOnDisk,
          episodeFileCount: x.episodeFileCount - season.episodeFileCount,
          seasons: x.seasons.filter((se) => se.seasonNumber !== seasonNumber),
        };
      }),
    })), [runDelete]);

  return { snapshot, loading, refreshing, error, deletingKey, refresh, removeMovie, removeSeries, removeSeason };
}
