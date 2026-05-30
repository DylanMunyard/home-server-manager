import { useMemo, useState } from 'react';
import type { Job } from '../shared/api.ts';
import { humanizeCron, uiState } from '../jobs/cron.ts';

type Props = {
  jobs: Job[];
  selectedId: string | null;
  onPick: (id: string) => void;
};

export function JobsScreen({ jobs, selectedId, onPick }: Props) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) =>
      j.name.toLowerCase().includes(q) || (j.description ?? '').toLowerCase().includes(q),
    );
  }, [jobs, query]);

  return (
    <>
      <div className="m-search">
        <span className="m-search-icon">/</span>
        <input
          placeholder="search jobs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="m-section">
        <span>recurring jobs</span>
        <span className="m-count">{filtered.length}</span>
      </div>
      <div className="m-content">
        {filtered.length === 0 ? (
          <div className="m-empty">
            {jobs.length === 0
              ? <>Drop a <code>.yaml</code> file in <code>config/jobs/</code></>
              : <>No jobs match "{query}"</>}
          </div>
        ) : filtered.map((j) => {
          const state = uiState(j.state.running);
          const { human, cadence } = humanizeCron(j.schedule);
          const chain = j.then ? `${j.run} → ${j.then}` : `${j.run} → notify only`;
          return (
            <button
              key={j.id}
              className={`m-row m-job ${j.id === selectedId ? 'selected' : 'unsel'}`}
              onClick={() => onPick(j.id)}
            >
              <span className={`m-jind ${state}`} />
              <span className="m-row-body">
                <span className="m-row-nm">{j.name}</span>
                <span className="m-row-sub chain">{chain}</span>
                <span className="m-row-sub">⏲ {human} · {j.targets.length === 1 ? j.targets[0].split('/')[1] : `${j.targets.length} hosts`}</span>
              </span>
              <span className="m-jrow-state">
                <span className="cad">{cadence}</span>
                <span className={`tag ${state}`}>{state === 'running' ? '● live' : '○ armed'}</span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
