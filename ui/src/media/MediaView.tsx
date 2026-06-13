import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { MediaServiceId, MovieItem, SeriesItem } from '../shared/api.ts';
import { humanSize, relativeTime } from '../shared/format.ts';
import { ConfirmDialog } from '../shared/ConfirmDialog.tsx';
import { useMedia } from './useMedia.ts';
import {
  collectGenres, DEFAULT_DIR, matchesGenre, matchesWatch, movieWatchClass,
  seriesWatchClass, sortItems, type SortDir, type SortKey, type WatchFilter,
} from './mediaSelect.ts';
import { MovieRow, SeriesRow, movieWatchLabel } from './MediaRow.tsx';
import { SeriesDetail } from './SeriesDetail.tsx';
import { MovieDetail } from './MovieDetail.tsx';

// The disk-triage view, shared by both shells (desktop tokens; .m-app remap).
// Desktop renders series detail inline (Dashboard/NodeDetail precedent);
// mobile passes onOpenSeries to navigate to its own route instead.
type MediaKind = 'movies' | 'tv';

const FILTERS: { key: WatchFilter; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'never', label: 'never watched' },
  { key: 'partial', label: 'partial' },
  { key: 'watched', label: 'watched' },
];

// Sortable column headers; the title cell sorts too. `watched` sorts by the
// Plex last-watched timestamp (never/no-data always group at the end).
const COLUMNS: { key: SortKey; label: string; cls: string }[] = [
  { key: 'title', label: 'title', cls: 'media-title' },
  { key: 'size', label: 'size', cls: 'media-size' },
  { key: 'rating', label: 'rating', cls: 'media-rating' },
  { key: 'lastWatched', label: 'watched', cls: 'media-badge' },
  { key: 'added', label: 'added', cls: 'media-added' },
];

export function MediaView({ onOpenSeries, onOpenMovie, openMovieId, openSeriesId, onCloseDetail }: {
  // Mobile passes only the on* handlers to navigate to its own full-screen
  // routes. Desktop additionally passes the open id (from the URL query) +
  // onCloseDetail, so the inline drill-down is URL-driven — refresh + back
  // button work. With none of these (standalone), it falls back to local state.
  onOpenSeries?: (id: number) => void;
  onOpenMovie?: (id: number) => void;
  openMovieId?: number | null;
  openSeriesId?: number | null;
  onCloseDetail?: () => void;
}) {
  const media = useMedia();
  const { snapshot, loading, refreshing, error, deletingKey } = media;
  const [searchParams, setSearchParams] = useSearchParams();

  // View controls (kind/filter/genre/sort) live in the URL query, so refresh +
  // a shared link restore exactly what you were looking at. `replace` keeps
  // each toggle out of the history stack (back shouldn't step through every
  // filter click), and defaults are omitted to keep the URL clean.
  const patch = useCallback((p: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(p)) { if (v === null) next.delete(k); else next.set(k, v); }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const kind: MediaKind = searchParams.get('kind') === 'tv' ? 'tv' : 'movies';
  const filterParam = searchParams.get('filter') as WatchFilter | null;
  const filter: WatchFilter = filterParam && FILTERS.some((f) => f.key === filterParam) ? filterParam : 'all';
  const genre = searchParams.get('genre') || 'all';
  const sortParam = searchParams.get('sort') as SortKey | null;
  const sortKey: SortKey = sortParam && COLUMNS.some((c) => c.key === sortParam) ? sortParam : 'size';
  const dirParam = searchParams.get('dir');
  const sortDir: SortDir = dirParam === 'asc' ? 1 : dirParam === 'desc' ? -1 : DEFAULT_DIR[sortKey];
  const sort = { key: sortKey, dir: sortDir };

  const setFilter = (f: WatchFilter) => patch({ filter: f === 'all' ? null : f });
  const setGenre = (g: string) => patch({ genre: g === 'all' ? null : g });

  const [openSeriesState, setOpenSeriesState] = useState<number | null>(null);
  const [openMovieState, setOpenMovieState] = useState<number | null>(null);

  // The inline detail is "controlled" when the parent drives open-state via the
  // URL (desktop). Mobile navigates away on open, so its props stay nullish and
  // the inline detail never renders there.
  const controlled = onCloseDetail !== undefined;
  const openMovie = controlled ? openMovieId ?? null : openMovieState;
  const openSeries = controlled ? openSeriesId ?? null : openSeriesState;
  const closeDetail = controlled
    ? onCloseDetail!
    : () => { setOpenMovieState(null); setOpenSeriesState(null); };
  const [confirmMovie, setConfirmMovie] = useState<MovieItem | null>(null);
  const [confirmSeries, setConfirmSeries] = useState<SeriesItem | null>(null);
  const [excludeOnDelete, setExcludeOnDelete] = useState(true);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Click the active column again to flip direction; a new column starts at
  // its triage-natural default. Default key (size) + default dir drop out of
  // the URL so the clean `/media` stays clean.
  const sortBy = (key: SortKey) => {
    const dir: SortDir = sort.key === key ? ((sort.dir * -1) as SortDir) : DEFAULT_DIR[key];
    patch({
      sort: key === 'size' ? null : key,
      dir: dir === DEFAULT_DIR[key] ? null : dir === 1 ? 'asc' : 'desc',
    });
  };

  const movies = useMemo(() =>
    sortItems((snapshot?.movies ?? []).filter((m) => matchesWatch(movieWatchClass(m), filter) && matchesGenre(m, genre)), sortKey, sortDir),
    [snapshot, sortKey, sortDir, filter, genre]);
  const series = useMemo(() =>
    sortItems((snapshot?.series ?? []).filter((s) => matchesWatch(seriesWatchClass(s), filter) && matchesGenre(s, genre)), sortKey, sortDir),
    [snapshot, sortKey, sortDir, filter, genre]);

  // Genre options follow the active kind (movie/TV genre sets differ), drawn
  // from the unfiltered library so the dropdown stays stable as watch-filters
  // change. Switching kind resets a now-stale selection back to "all".
  const genreOptions = useMemo(() =>
    collectGenres(kind === 'movies' ? snapshot?.movies ?? [] : snapshot?.series ?? []),
    [snapshot, kind]);

  // Switching movies↔TV resets a now-stale genre selection (the sets differ).
  const switchKind = (k: MediaKind) => patch({ kind: k === 'movies' ? null : 'tv', genre: null });

  const totalBytes = useMemo(() =>
    (snapshot?.movies ?? []).reduce((a, m) => a + m.sizeOnDisk, 0)
    + (snapshot?.series ?? []).reduce((a, s) => a + s.sizeOnDisk, 0),
    [snapshot]);

  const badServices = (Object.entries(snapshot?.services ?? {}) as [MediaServiceId, { state: string; reason?: string; error?: string }][])
    .filter(([, st]) => st.state !== 'ok');

  const doDelete = async (run: () => Promise<string | null>) => {
    setDeleteError(null);
    const err = await run();
    if (err) setDeleteError(err);
  };

  // Inline movie detail (desktop). Mobile routes instead via onOpenMovie.
  const movieDetail = openMovie !== null ? snapshot?.movies.find((m) => m.id === openMovie) ?? null : null;
  if (movieDetail) {
    return (
      <div className="media">
        {deleteError && <div className="media-err">{deleteError}</div>}
        <MovieDetail
          movie={movieDetail}
          deleting={deletingKey === `movie:${movieDetail.id}`}
          onDelete={(exclude) => doDelete(async () => {
            const err = await media.removeMovie(movieDetail.id, exclude);
            if (!err) closeDetail();
            return err;
          })}
          onClose={closeDetail}
        />
      </div>
    );
  }

  // Inline series detail (desktop). Mobile routes instead via onOpenSeries.
  const detail = openSeries !== null ? snapshot?.series.find((s) => s.id === openSeries) ?? null : null;
  if (detail) {
    return (
      <div className="media">
        {deleteError && <div className="media-err">{deleteError}</div>}
        <SeriesDetail
          series={detail}
          deletingKey={deletingKey}
          onDeleteSeason={(n) => doDelete(() => media.removeSeason(detail.id, n))}
          onDeleteSeries={() => doDelete(async () => {
            const err = await media.removeSeries(detail.id);
            if (!err) closeDetail();
            return err;
          })}
          onClose={closeDetail}
        />
      </div>
    );
  }

  const list = kind === 'movies' ? movies : series;

  return (
    <div className="media">
      <div className="media-head">
        <h2>media</h2>
        <span className="media-meta">
          {snapshot && `${humanSize(totalBytes)} on disk`}
          {snapshot && snapshot.fetchedAt > 0 && ` · fetched ${relativeTime(snapshot.fetchedAt / 1000) || 'today'}`}
          <button className="media-refresh" onClick={media.refresh} disabled={refreshing || loading}>
            {refreshing ? 'refreshing…' : 'refresh'}
          </button>
        </span>
      </div>

      {badServices.length > 0 && (
        <div className="media-services">
          {badServices.map(([id, st]) => (
            <span className="media-chip" data-state={st.state} key={id}>
              {id}: {st.state === 'disabled' ? st.reason : st.error}
            </span>
          ))}
        </div>
      )}

      {error && <div className="media-err">{error}</div>}
      {deleteError && <div className="media-err">{deleteError}</div>}
      {loading && <div className="media-msg">pulling libraries…</div>}

      {!loading && snapshot && (
        <>
          <div className="media-controls">
            <button className="media-ctl media-ctl-kind" data-on={kind === 'movies'} onClick={() => switchKind('movies')}>
              movies · {snapshot.movies.length}
            </button>
            <button className="media-ctl media-ctl-kind" data-on={kind === 'tv'} onClick={() => switchKind('tv')}>
              tv · {snapshot.series.length}
            </button>
            <span className="media-ctl-label media-ctl-gap">show</span>
            {FILTERS.map((f) => (
              <button key={f.key} className="media-ctl" data-on={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
            {genreOptions.length > 0 && (
              <>
                <span className="media-ctl-label media-ctl-gap">genre</span>
                <select className="media-genre-select" data-on={genre !== 'all'} value={genre} onChange={(e) => setGenre(e.target.value)}>
                  <option value="all">all</option>
                  {genreOptions.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </>
            )}
          </div>

          <div className="media-row media-hrow">
            {COLUMNS.map((c) => (
              <button key={c.key} className={`media-h ${c.cls}`} data-on={sort.key === c.key} onClick={() => sortBy(c.key)}>
                {c.label}{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </button>
            ))}
            <span />
          </div>

          <div className="media-list">
            {kind === 'movies'
              ? movies.map((m) => (
                <MovieRow key={m.id} movie={m}
                  deleting={deletingKey === `movie:${m.id}`}
                  onDelete={() => setConfirmMovie(m)}
                  onOpen={() => (onOpenMovie ? onOpenMovie(m.id) : setOpenMovieState(m.id))} />
              ))
              : series.map((s) => (
                <SeriesRow key={s.id} series={s}
                  deleting={deletingKey?.startsWith(`series:${s.id}`) || deletingKey?.startsWith(`season:${s.id}:`) || false}
                  onDelete={() => setConfirmSeries(s)}
                  onOpen={() => (onOpenSeries ? onOpenSeries(s.id) : setOpenSeriesState(s.id))} />
              ))}
          </div>

          {list.length === 0 && (
            <div className="media-msg">nothing matches — services down, empty library, or filter too tight</div>
          )}
        </>
      )}

      {confirmSeries && (
        <ConfirmDialog
          title="delete entire series?"
          message={`Removes '${confirmSeries.title}' from Sonarr and deletes all ${confirmSeries.episodeFileCount} files `
            + `(${humanSize(confirmSeries.sizeOnDisk)}) from disk.`}
          confirmLabel="Delete series"
          danger
          onCancel={() => setConfirmSeries(null)}
          onConfirm={() => {
            const s = confirmSeries;
            setConfirmSeries(null);
            doDelete(() => media.removeSeries(s.id));
          }}
        />
      )}
      {confirmMovie && (
        <ConfirmDialog
          title="delete movie?"
          message={`Removes '${confirmMovie.title}' (${humanSize(confirmMovie.sizeOnDisk)}) from Radarr and `
            + `deletes its files from disk. ${movieWatchLabel(confirmMovie)}.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmMovie(null)}
          onConfirm={() => {
            const m = confirmMovie;
            setConfirmMovie(null);
            doDelete(() => media.removeMovie(m.id, excludeOnDelete));
          }}
        >
          <label className="media-exclude">
            <input type="checkbox" checked={excludeOnDelete} onChange={(e) => setExcludeOnDelete(e.target.checked)} />
            also block re-adding (import exclusion)
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}
