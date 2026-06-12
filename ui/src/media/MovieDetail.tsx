import { useState } from 'react';
import type { MovieItem } from '../shared/api.ts';
import { humanSize, relativeTime } from '../shared/format.ts';
import { ConfirmDialog } from '../shared/ConfirmDialog.tsx';
import { externalLinks, movieWatchClass, runtimeLabel } from './mediaSelect.ts';
import { movieWatchLabel } from './MediaRow.tsx';

// Movie drill-down — the "should I delete this?" card: every rating source at
// its native scale, the plot summary, and a link out to the full page online.
export function MovieDetail({ movie, deleting, onDelete, onClose }: {
  movie: MovieItem;
  deleting: boolean;
  onDelete: (addImportExclusion: boolean) => void;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [exclude, setExclude] = useState(true);

  const r = movie.ratings;
  const ratings: { label: string; value: string }[] = [
    ...(r.imdb ? [{ label: 'imdb', value: r.imdb.toFixed(1) }] : []),
    ...(r.tmdb ? [{ label: 'tmdb', value: r.tmdb.toFixed(1) }] : []),
    ...(r.rottenTomatoes ? [{ label: 'rt', value: `${Math.round(r.rottenTomatoes)}%` }] : []),
    ...(r.metacritic ? [{ label: 'mc', value: `${Math.round(r.metacritic)}` }] : []),
  ];

  return (
    <div className="media-detail">
      <div className="media-detail-bar">
        <button className="media-back" onClick={onClose}>← back</button>
        <div className="media-detail-id">
          <b>{movie.title}</b>
          <span className="media-year">{movie.year || ''}</span>
        </div>
      </div>

      <div className="media-detail-meta">
        <span className="media-size">{humanSize(movie.sizeOnDisk)}</span>
        <span className="media-badge" data-watch={movieWatchClass(movie)}>{movieWatchLabel(movie)}</span>
        {movie.added && <span>added {relativeTime(Date.parse(movie.added) / 1000)}</span>}
        {runtimeLabel(movie.runtime) && <span>{runtimeLabel(movie.runtime)}</span>}
        {!movie.monitored && <span>unmonitored</span>}
      </div>

      {ratings.length > 0 && (
        <div className="media-ratings">
          {ratings.map((x) => (
            <span className="media-ratecell" key={x.label}><b>{x.value}</b> {x.label}</span>
          ))}
        </div>
      )}

      {movie.genres && <div className="media-genres">{movie.genres.join(' · ')}</div>}
      {movie.overview && <p className="media-overview">{movie.overview}</p>}

      <div className="media-links">
        {externalLinks(movie).map((l) => (
          <a className="media-link" key={l.label} href={l.url} target="_blank" rel="noreferrer">
            {l.label} ↗
          </a>
        ))}
      </div>

      <div className="media-detail-actions">
        <button className="media-del media-del-all" disabled={deleting} onClick={() => setConfirm(true)}>
          {deleting ? 'deleting…' : 'delete movie'}
        </button>
      </div>

      {confirm && (
        <ConfirmDialog
          title="delete movie?"
          message={`Removes '${movie.title}' (${humanSize(movie.sizeOnDisk)}) from Radarr and deletes `
            + `its files from disk. ${movieWatchLabel(movie)}.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => { setConfirm(false); onDelete(exclude); }}
        >
          <label className="media-exclude">
            <input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} />
            also block re-adding (import exclusion)
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}
