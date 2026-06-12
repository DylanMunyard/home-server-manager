import type { MovieItem, SeriesItem } from '../shared/api.ts';
import { humanSize, relativeTime } from '../shared/format.ts';
import { movieRating, movieWatchClass, seriesWatchClass, type WatchClass } from './mediaSelect.ts';

// One triage row — movie or series. Numeric cells are tabular; the only red
// is the delete affordance and the "huge & never watched" highlight.

const HUGE_BYTES = 20 * 1024 ** 3; // ≥20 GiB unwatched gets the highlight

function WatchBadge({ cls, label }: { cls: WatchClass; label: string }) {
  return <span className="media-badge" data-watch={cls}>{label}</span>;
}

export function movieWatchLabel(m: MovieItem): string {
  const cls = movieWatchClass(m);
  if (cls === 'none') return 'no plex data';
  if (cls === 'never') return 'never watched';
  const ago = relativeTime(m.plex!.lastViewedAt);
  // viewCount 0 + a timestamp = started but never finished.
  if (cls === 'partial') return ago ? `started, ${ago}` : 'started';
  const times = m.plex!.viewCount === 1 ? '1×' : `${m.plex!.viewCount}×`;
  return ago ? `${times}, ${ago}` : times;
}

export function seriesWatchLabel(s: SeriesItem): string {
  const cls = seriesWatchClass(s);
  if (cls === 'none') return 'no plex data';
  if (cls === 'never') return 'never watched';
  if (s.plex!.viewedLeafCount === 0) return 'started';   // partial via lastViewedAt only
  return `${s.plex!.viewedLeafCount}/${s.plex!.leafCount} eps`;
}

export function MovieRow({ movie, deleting, onDelete, onOpen }: {
  movie: MovieItem;
  deleting: boolean;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const cls = movieWatchClass(movie);
  const rating = movieRating(movie);
  const hot = (cls === 'never' || cls === 'none') && movie.sizeOnDisk >= HUGE_BYTES;
  return (
    <div className="media-row" data-hot={hot}>
      <button className="media-title media-open" onClick={onOpen}>
        {movie.title} <span className="media-year">{movie.year || ''}</span>
      </button>
      <span className="media-size">{humanSize(movie.sizeOnDisk)}</span>
      <span className="media-rating">
        {rating ? <>{rating.value.toFixed(1)} <i>{rating.source}</i></> : '—'}
      </span>
      <WatchBadge cls={cls} label={movieWatchLabel(movie)} />
      <span className="media-added">{movie.added ? relativeTime(Date.parse(movie.added) / 1000) : ''}</span>
      <button className="media-del" onClick={onDelete} disabled={deleting}>
        {deleting ? '…' : 'del'}
      </button>
    </div>
  );
}

export function SeriesRow({ series, deleting, onDelete, onOpen }: {
  series: SeriesItem;
  deleting: boolean;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const cls = seriesWatchClass(series);
  const hot = (cls === 'never' || cls === 'none') && series.sizeOnDisk >= HUGE_BYTES;
  return (
    <div className="media-row" data-hot={hot}>
      <button className="media-title media-open" onClick={onOpen}>
        {series.title} <span className="media-year">{series.year || ''}</span>
        <span className="media-eps">{series.episodeFileCount} files</span>
      </button>
      <span className="media-size">{humanSize(series.sizeOnDisk)}</span>
      <span className="media-rating">
        {series.rating ? <>{series.rating.toFixed(1)} <i>tvdb</i></> : '—'}
      </span>
      <WatchBadge cls={cls} label={seriesWatchLabel(series)} />
      <span className="media-added">{series.added ? relativeTime(Date.parse(series.added) / 1000) : ''}</span>
      <button className="media-del" onClick={onDelete} disabled={deleting}>
        {deleting ? '…' : 'del'}
      </button>
    </div>
  );
}
