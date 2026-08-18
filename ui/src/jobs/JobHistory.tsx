import { useState } from 'react';
import type { Job, JobHistoryEntry } from '../shared/api.ts';
import { useJobHistory } from './useJobHistory.ts';
import { TargetBlock } from './JobOutput.tsx';

const OUTCOME_LABEL: Record<JobHistoryEntry['outcome'], string> = {
  ok: 'passed',
  warn: 'remediated',
  err: 'failed',
};

function HistoryRow({ job, entry, open, onToggle }: { job: Job; entry: JobHistoryEntry; open: boolean; onToggle: () => void }) {
  return (
    <li className={`job-history-row ${open ? 'open' : ''}`}>
      <button className="job-history-head" onClick={onToggle}>
        <span className={`job-history-dot ${entry.outcome}`} />
        <span className="job-history-when">{new Date(entry.runAt).toLocaleString()}</span>
        <span className="job-history-dur">{(entry.durationMs / 1000).toFixed(1)}s</span>
        {entry.forced && <span className="job-history-forced">test fire</span>}
        <span className={`job-output-tag ${entry.outcome}`}>{OUTCOME_LABEL[entry.outcome]}</span>
      </button>
      {open && (
        <div className="job-history-body">
          {Object.entries(entry.targets).map(([t, ts]) => (
            <TargetBlock key={t} job={job} target={t} ts={ts} />
          ))}
        </div>
      )}
    </li>
  );
}

// Past executions for the selected job — failures + triggered remediations are
// kept (capped server-side), plus the single most recent clean run. See
// jobs.history.ts for the retention policy this mirrors.
export function JobHistory({ job }: { job: Job }) {
  const { entries, loading, error, reload } = useJobHistory(job.id);
  const [openAt, setOpenAt] = useState<string | null>(null);

  if (error) return <div className="job-output empty">{error}</div>;
  if (loading && entries.length === 0) return <div className="job-output empty">Loading history…</div>;
  if (entries.length === 0) {
    return (
      <div className="job-output empty">
        No history yet — runs are recorded here as they happen. Failures and
        triggered remediations are kept longest; only the latest clean run is kept.
      </div>
    );
  }

  return (
    <div className="job-history">
      <div className="job-history-toolbar">
        <span className="job-output-when">{entries.length} run{entries.length === 1 ? '' : 's'} kept · failures prioritized</span>
        <button className="job-history-refresh" onClick={reload} disabled={loading}>{loading ? 'refreshing…' : '↻ refresh'}</button>
      </div>
      <ul className="job-history-list">
        {entries.map((e) => (
          <HistoryRow key={e.runAt} job={job} entry={e} open={openAt === e.runAt} onToggle={() => setOpenAt(openAt === e.runAt ? null : e.runAt)} />
        ))}
      </ul>
    </div>
  );
}
