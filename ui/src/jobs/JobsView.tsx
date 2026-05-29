import { useMemo, useState } from 'react';
import { useJobs } from './useJobs.ts';
import { useRunbook } from '../runbooks/useRunbooks.ts';
import { JobFlow } from './JobFlow.tsx';
import { humanizeCron, uiState } from './cron.ts';
import type { Job } from '../shared/api.ts';

function JobRow({ job, active, onPick }: { job: Job; active: boolean; onPick: () => void }) {
  const state = uiState(job.state.running);
  const { human, cadence } = humanizeCron(job.schedule);
  const chain = job.then ? `${job.run} → ${job.then}` : `${job.run} → notify only`;
  return (
    <li className={`list-row job-row ${active ? 'active' : ''}`} onClick={onPick}>
      <span className={`dot ${state}`} />
      <span>
        <div className="name">{job.name}</div>
        <div className="sub">{chain}</div>
        <div className="sub">⏲ {human} · {job.target.split('/')[1]}</div>
      </span>
      <span className="job-row-right">
        <span className="cad">{cadence}</span>
        <span className={`tag ${state}`}>{state === 'running' ? '● live' : '○ armed'}</span>
      </span>
    </li>
  );
}

export function JobsView() {
  const { jobs, error, run, runningId } = useJobs();
  const [selId, setSelId] = useState<string | null>(null);
  const job = useMemo(() => jobs.find((j) => j.id === selId) ?? jobs[0] ?? null, [jobs, selId]);

  const checkRunbook = useRunbook(job?.run ?? null);
  const remediateRunbook = useRunbook(job?.then ?? null);

  const state = job ? uiState(job.state.running) : 'armed';
  const isRunning = !!job && (job.state.running || runningId === job.id);

  return (
    <div className="jobs-view">
      {/* LEFT — jobs list */}
      <aside className="jobs-rail">
        <div className="panel-h">
          <span>Jobs</span>
          <span className="count">{jobs.length}</span>
        </div>
        <div className="panel-body">
          {error && <div className="empty">{error}</div>}
          {!error && jobs.length === 0 && (
            <div className="empty">Drop a <code>.yaml</code> file in <code>config/jobs/</code> to add a recurring job.</div>
          )}
          <ul className="list">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} active={j.id === job?.id} onPick={() => setSelId(j.id)} />
            ))}
          </ul>
        </div>
      </aside>

      {/* RIGHT — job detail */}
      <div className="jobs-detail">
        {!job ? (
          <div className="empty">No job selected.</div>
        ) : (
          <>
            <div className="job-head">
              <div className="job-head-top">
                <div>
                  <div className="meta">recurring job</div>
                  <h2>{job.name}</h2>
                  {job.description && <div className="desc">{job.description}</div>}
                </div>
                <div className="job-head-actions">
                  <button
                    data-variant="run"
                    disabled={isRunning}
                    onClick={() => run(job.id)}
                  >
                    {isRunning ? 'Running…' : 'Run now'}
                  </button>
                  {!job.then && <span className="monitor-tag">monitor only</span>}
                </div>
              </div>

              <dl className="job-meta">
                <div className="job-meta-cell">
                  <dt>schedule</dt>
                  <dd className="big">{humanizeCron(job.schedule).human}</dd>
                  <dd className="raw">{job.schedule}</dd>
                </div>
                <div className="job-meta-cell">
                  <dt>target</dt>
                  <dd className="mono">
                    <span className="dim">{job.target.split('/')[0]}/</span>{job.target.split('/')[1]}
                  </dd>
                </div>
                <div className="job-meta-cell">
                  <dt>state</dt>
                  <dd className={`state ${state}`}>
                    <span className={`dot ${state}`} />
                    {state === 'running' ? 'enabled · checking now' : 'enabled · waiting for tick'}
                  </dd>
                </div>
                {job.state.lastError && (
                  <div className="job-meta-cell">
                    <dt>last error</dt>
                    <dd className="err">{job.state.lastError}</dd>
                  </div>
                )}
              </dl>
            </div>

            <div className="job-flow-wrap">
              <div className="panel-h"><span>Flow</span></div>
              <JobFlow job={job} checkRunbook={checkRunbook} remediateRunbook={remediateRunbook} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
