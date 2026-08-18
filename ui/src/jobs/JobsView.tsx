import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useJobs } from './useJobs.ts';
import { useRunbook, useRunbookMap } from '../runbooks/useRunbooks.ts';
import { JobFlow } from './JobFlow.tsx';
import { JobOutput } from './JobOutput.tsx';
import { JobHistory } from './JobHistory.tsx';
import { JobInvestigations } from './Investigation.tsx';
import { useAiStatus } from './useAiStatus.ts';
import { humanizeCron, summarizeJobRun, summarizeTarget, uiState } from './cron.ts';
import { testAlert, downloadBackup, type Job } from '../shared/api.ts';

// "proxmox" for a one-host job, "3 hosts" for a fan-out.
function targetsLabel(job: Job): string {
  return job.targets.length === 1 ? job.targets[0].split('/')[1] : `${job.targets.length} hosts`;
}

function JobRow({ job, active, onPick }: { job: Job; active: boolean; onPick: () => void }) {
  const state = uiState(job.state.running);
  const { human, cadence } = humanizeCron(job.schedule);
  const chain = job.then?.length ? `${job.run} → ${job.then.join(' → ')}` : `${job.run} → notify only`;
  return (
    <li className={`list-row job-row ${active ? 'active' : ''}`} onClick={onPick}>
      <span className={`dot ${state}`} />
      <span>
        <div className="name">{job.name}</div>
        <div className="sub">{chain}</div>
        <div className="sub">⏲ {human} · {targetsLabel(job)}</div>
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
  const aiEnabled = !!useAiStatus()?.enabled;
  const [params, setParams] = useSearchParams();
  const selId = params.get('job');
  const setSelId = (id: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('job', id); return n; });
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<'output' | 'history' | 'flow' | 'investigation'>('output');
  const [backupBusy, setBackupBusy] = useState<'sqlite' | 'neo4j' | null>(null);
  const job = useMemo(() => jobs.find((j) => j.id === selId) ?? jobs[0] ?? null, [jobs, selId]);

  const sendTestAlert = async () => {
    if (!job) return;
    setAlertBusy(true);
    setAlertMsg(null);
    // Representative single host — real alerts fire per-target, so the test
    // mirrors that rather than listing every node.
    const r = await testAlert(job.run, job.targets[0]);
    setAlertBusy(false);
    setAlertMsg(r.sent ? 'test alert sent ✓' : `alert failed: ${r.reason ?? 'unknown'}`);
  };

  const handleBackup = (type: 'sqlite' | 'neo4j') => {
    const label = type === 'sqlite' ? 'SQLite' : 'Neo4j';
    const msg =
      type === 'sqlite'
        ? `This will stop the bf42-stats deployment for ~30–60s while the SQLite database is dumped and streamed to your browser. The app will restart automatically after the download begins. Continue?`
        : `This will stop both the bf42-stats app and the Neo4j deployment for ~60–120s while the database is archived and streamed to your browser. Both will restart automatically after. Continue?`;
    if (!window.confirm(`Download ${label} backup\n\n${msg}`)) return;
    setBackupBusy(type);
    downloadBackup(type);
    // Reset busy state after a short delay — there's no completion event from
    // the browser download API; the download continues independently.
    setTimeout(() => setBackupBusy(null), 3000);
  };

  const checkRunbook = useRunbook(job?.run ?? null);
  const thenRunbooks = useRunbookMap(job?.then ?? []);

  const state = job ? uiState(job.state.running) : 'armed';
  const isRunning = !!job && (job.state.running || runningId === job.id);
  // The investigation tab is available when AI is configured (test any job) or
  // the job opts into auto-firing. Don't strand it when neither holds.
  const showInvestigation = aiEnabled || !!job?.investigate;
  const activeTab = tab === 'investigation' && !showInvestigation ? 'output' : tab;

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
              <JobRow key={j.id} job={j} active={j.id === job?.id} onPick={() => { setSelId(j.id); setAlertMsg(null); }} />
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
                  {!!job.then?.length && (
                    <button
                      disabled={isRunning}
                      onClick={() => run(job.id, true)}
                      title={`Run ${job.run}, force the gate, and run ${job.then.join(' + ')} FOR REAL — the actual ntfy alerts fire (titled "test fire")`}
                    >
                      {isRunning ? 'Running…' : 'Test fire'}
                    </button>
                  )}
                  <button
                    disabled={alertBusy}
                    onClick={sendTestAlert}
                    title="Send a test ntfy alert simulating this job's check failing — nothing runs, no remediation"
                  >
                    {alertBusy ? 'Sending…' : 'Test alert'}
                  </button>
                  {alertMsg && <span className="job-alert-msg">{alertMsg}</span>}
                  {(() => {
                    const o = !isRunning ? summarizeJobRun(job) : null;
                    return o && <span className={`job-run-outcome ${o.tone}`}>{o.text}</span>;
                  })()}
                  {!job.then?.length && <span className="monitor-tag">monitor only</span>}
                  {job.id === 'bfstats-watchdog' && (
                    <>
                      <div className="backup-divider" />
                      <button
                        data-variant="backup"
                        disabled={backupBusy !== null}
                        onClick={() => handleBackup('sqlite')}
                        title="Stop bf42-stats (~30–60s), dump SQLite to a .sql.gz file, restart"
                      >
                        {backupBusy === 'sqlite' ? 'Starting…' : '↓ SQLite backup'}
                      </button>
                      <button
                        data-variant="backup"
                        disabled={backupBusy !== null}
                        onClick={() => handleBackup('neo4j')}
                        title="Stop bf42-stats + Neo4j (~60–120s), archive Neo4j data dir, restart"
                      >
                        {backupBusy === 'neo4j' ? 'Starting…' : '↓ Neo4j backup'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <dl className="job-meta">
                <div className="job-meta-cell">
                  <dt>schedule</dt>
                  <dd className="big">{humanizeCron(job.schedule).human}</dd>
                  <dd className="raw">{job.schedule}</dd>
                </div>
                <div className="job-meta-cell">
                  <dt>state</dt>
                  <dd className={`state ${state}`}>
                    <span className={`dot ${state}`} />
                    {state === 'running' ? 'enabled · checking now' : 'enabled · waiting for tick'}
                  </dd>
                </div>
                <div className="job-meta-cell job-targets-cell">
                  <dt>{job.targets.length === 1 ? 'target' : `targets · ${job.targets.length}`}</dt>
                  <dd>
                    <ul className="job-targets">
                      {job.targets.map((t) => {
                        const [g, srv] = t.split('/');
                        const o = !isRunning ? summarizeTarget(job, job.state.targets[t]) : null;
                        return (
                          <li key={t} className="job-target">
                            <span className="mono"><span className="dim">{g}/</span>{srv}</span>
                            {o && <span className={`job-run-outcome ${o.tone}`}>{o.text}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </dd>
                </div>
              </dl>
            </div>

            <div className="job-flow-wrap">
              <div className="panel-h job-tabhead">
                <div className="tabrow">
                  <button className={`tab ${tab === 'output' ? 'active' : ''}`} onClick={() => setTab('output')}>Last run</button>
                  <button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>History</button>
                  <button className={`tab ${tab === 'flow' ? 'active' : ''}`} onClick={() => setTab('flow')}>Flow</button>
                  {showInvestigation && (() => {
                    const hasInv = Object.values(job.state.targets).some((t) => t.investigation);
                    return (
                      <button className={`tab ${activeTab === 'investigation' ? 'active' : ''}`} onClick={() => setTab('investigation')}>
                        AI investigation{hasInv && <span className="tab-badge">●</span>}
                      </button>
                    );
                  })()}
                </div>
              </div>
              {activeTab === 'output' && <JobOutput job={job} />}
              {activeTab === 'history' && <JobHistory job={job} />}
              {activeTab === 'flow' && <JobFlow job={job} checkRunbook={checkRunbook} thenRunbooks={thenRunbooks} />}
              {activeTab === 'investigation' && <JobInvestigations job={job} aiEnabled={aiEnabled} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
