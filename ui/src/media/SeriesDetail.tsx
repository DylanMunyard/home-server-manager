import { useState } from 'react';
import type { SeriesItem } from '../shared/api.ts';
import { humanSize } from '../shared/format.ts';
import { ConfirmDialog } from '../shared/ConfirmDialog.tsx';
import { seriesWatchLabel } from './MediaRow.tsx';
import { externalLinks, runtimeLabel, seriesWatchClass } from './mediaSelect.ts';
import { Poster } from './MediaPoster.tsx';

// Per-season drill-down: drop just seasons 1–3 instead of the whole show.
// Rendered inside the scrolling .media container (desktop) or a mobile screen
// body — natural height, no inner scroller (root CLAUDE.md rule).
export function SeriesDetail({ series, deletingKey, onDeleteSeason, onDeleteSeries, onClose }: {
  series: SeriesItem;
  deletingKey: string | null;
  onDeleteSeason: (seasonNumber: number) => void;
  onDeleteSeries: () => void;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState<{ kind: 'series' } | { kind: 'season'; n: number } | null>(null);

  const seasonLabel = (n: number) => (n === 0 ? 'specials' : `season ${n}`);

  return (
    <div className="media-detail">
      <div className="media-detail-bar">
        <button className="media-back" onClick={onClose}>← back</button>
        <div className="media-detail-id">
          <b>{series.title}</b>
          <span className="media-year">{series.year || ''}</span>
        </div>
      </div>

      <div className="media-detail-top">
        <Poster src={series.poster} alt={series.title} />
        <div className="media-detail-info">
          <div className="media-detail-meta">
            <span className="media-size">{humanSize(series.sizeOnDisk)}</span>
            <span>{series.episodeFileCount}/{series.totalEpisodeCount} eps on disk</span>
            <span className="media-badge" data-watch={seriesWatchClass(series)}>{seriesWatchLabel(series)}</span>
            <span>{series.ended ? 'ended' : 'continuing'}</span>
            {runtimeLabel(series.runtime) && <span>{runtimeLabel(series.runtime)}/ep</span>}
            {!series.monitored && <span>unmonitored</span>}
          </div>

          {series.rating && (
            <div className="media-ratings">
              <span className="media-ratecell"><b>{series.rating.toFixed(1)}</b> tvdb</span>
            </div>
          )}

          {series.genres && <div className="media-genres">{series.genres.join(' · ')}</div>}
          {series.overview && <p className="media-overview">{series.overview}</p>}
        </div>
      </div>

      <div className="media-links">
        {externalLinks(series).map((l) => (
          <a className="media-link" key={l.label} href={l.url} target="_blank" rel="noreferrer">
            {l.label} ↗
          </a>
        ))}
      </div>

      <div className="media-seasons">
        {series.seasons.map((se) => {
          const deleting = deletingKey === `season:${series.id}:${se.seasonNumber}`;
          const watched = se.plex
            ? `${se.plex.viewedLeafCount}/${se.plex.leafCount} watched`
            : 'no plex data';
          return (
            <div className="media-season-row" key={se.seasonNumber}>
              <span className="media-season-n">{seasonLabel(se.seasonNumber)}</span>
              <span className="media-size">{humanSize(se.sizeOnDisk)}</span>
              <span>{se.episodeFileCount}/{se.totalEpisodeCount} eps</span>
              <span className="media-badge" data-watch={se.plex ? (se.plex.viewedLeafCount === 0 ? 'never' : se.plex.viewedLeafCount >= se.plex.leafCount ? 'watched' : 'partial') : 'none'}>
                {watched}
              </span>
              <span className="media-season-mon">{se.monitored ? '' : 'unmonitored'}</span>
              <button className="media-del" disabled={deleting}
                onClick={() => setConfirm({ kind: 'season', n: se.seasonNumber })}>
                {deleting ? '…' : 'del'}
              </button>
            </div>
          );
        })}
      </div>

      <div className="media-detail-actions">
        <button className="media-del media-del-all" disabled={deletingKey === `series:${series.id}`}
          onClick={() => setConfirm({ kind: 'series' })}>
          {deletingKey === `series:${series.id}` ? 'deleting…' : 'delete entire series'}
        </button>
      </div>

      {confirm?.kind === 'season' && (() => {
        const se = series.seasons.find((s) => s.seasonNumber === confirm.n)!;
        return (
          <ConfirmDialog
            title={`delete ${seasonLabel(confirm.n)}?`}
            message={`Removes ${seasonLabel(confirm.n)} of '${series.title}' from disk via Sonarr `
              + `(${humanSize(se.sizeOnDisk)}, ${se.episodeFileCount} files) and unmonitors it so it isn't re-grabbed.`}
            confirmLabel="Delete"
            danger
            onCancel={() => setConfirm(null)}
            onConfirm={() => { setConfirm(null); onDeleteSeason(confirm.n); }}
          />
        );
      })()}
      {confirm?.kind === 'series' && (
        <ConfirmDialog
          title="delete entire series?"
          message={`Removes '${series.title}' from Sonarr and deletes all ${series.episodeFileCount} files `
            + `(${humanSize(series.sizeOnDisk)}) from disk. ${seriesWatchLabel(series)}.`}
          confirmLabel="Delete series"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); onDeleteSeries(); }}
        />
      )}
    </div>
  );
}
