import { useMemo, useState } from 'react';
import type { MediaServiceId, MovieItem, SeriesItem } from '../shared/api.ts';
import { humanSize, relativeTime } from '../shared/format.ts';
import { ConfirmDialog } from '../shared/ConfirmDialog.tsx';
import { useMedia } from './useMedia.ts';
import {
  DEFAULT_DIR, matchesWatch, movieWatchClass, seriesWatchClass, sortItems,
  type SortDir, type SortKey, type WatchFilter,
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

export function MediaView({ onOpenSeries, onOpenMovie }: {
  onOpenSeries?: (id: number) => void;
  onOpenMovie?: (id: number) => void;
}) {
  const media = useMedia();
  const { snapshot, loading, refreshing, error, deletingKey } = media;
  const [kind, setKind] = useState<MediaKind>('movies');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'size', dir: DEFAULT_DIR.size });
  const [filter, setFilter] = useState<WatchFilter>('all');
  const [openSeries, setOpenSeries] = useState<number | null>(null);
  const [openMovie, setOpenMovie] = useState<number | null>(null);
  const [confirmMovie, setConfirmMovie] = useState<MovieItem | null>(null);
  const [confirmSeries, setConfirmSeries] = useState<SeriesItem | null>(null);
  const [excludeOnDelete, setExcludeOnDelete] = useState(true);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Click the active column again to flip direction; a new column starts at
  // its triage-natural default.
  const sortBy = (key: SortKey) => setSort((s) =>
    s.key === key ? { key, dir: (s.dir * -1) as SortDir } : { key, dir: DEFAULT_DIR[key] });

  const movies = useMemo(() =>
    sortItems((snapshot?.movies ?? []).filter((m) => matchesWatch(movieWatchClass(m), filter)), sort.key, sort.dir),
    [snapshot, sort, filter]);
  const series = useMemo(() =>
    sortItems((snapshot?.series ?? []).filter((s) => matchesWatch(seriesWatchClass(s), filter)), sort.key, sort.dir),
    [snapshot, sort, filter]);

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
            if (!err) setOpenMovie(null);
            return err;
          })}
          onClose={() => setOpenMovie(null)}
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
            if (!err) setOpenSeries(null);
            return err;
          })}
          onClose={() => setOpenSeries(null)}
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
            <button className="media-ctl media-ctl-kind" data-on={kind === 'movies'} onClick={() => setKind('movies')}>
              movies · {snapshot.movies.length}
            </button>
            <button className="media-ctl media-ctl-kind" data-on={kind === 'tv'} onClick={() => setKind('tv')}>
              tv · {snapshot.series.length}
            </button>
            <span className="media-ctl-label media-ctl-gap">show</span>
            {FILTERS.map((f) => (
              <button key={f.key} className="media-ctl" data-on={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
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
                  onOpen={() => (onOpenMovie ? onOpenMovie(m.id) : setOpenMovie(m.id))} />
              ))
              : series.map((s) => (
                <SeriesRow key={s.id} series={s}
                  deleting={deletingKey?.startsWith(`series:${s.id}`) || deletingKey?.startsWith(`season:${s.id}:`) || false}
                  onDelete={() => setConfirmSeries(s)}
                  onOpen={() => (onOpenSeries ? onOpenSeries(s.id) : setOpenSeries(s.id))} />
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
