import { useState } from 'react';
import { testAlert, type Job, type Runbook } from '../shared/api.ts';
import { condText, humanizeCron, summarizeJobRun, summarizeTarget, uiState } from '../jobs/cron.ts';
import { JobOutput } from '../jobs/JobOutput.tsx';
import { JobInvestigations } from '../jobs/Investigation.tsx';
import { useAiStatus } from '../jobs/useAiStatus.ts';

type Props = {
  job: Job;
  checkRunbook: Runbook | null;
  thenRunbooks: Record<string, Runbook | null>;
  running: boolean;
  onRun: () => void;
  onFire: () => void;   // forced run: gate tripped, `then` chain + real alerts
};

function Peek({ runbook }: { runbook: Runbook | null }) {
  if (!runbook) return <div className="m-jpeek"><span className="ln">script unavailable</span></div>;
  const lines = runbook.contents.replace(/\n$/, '').split('\n');
  return (
    <div className="m-jpeek">
      {lines.map((t, i) => (
        <div key={i} className={`ln ${/^\s*#/.test(t) ? 'com' : ''}`}>{t || ' '}</div>
      ))}
    </div>
  );
}

export function JobDetailScreen({ job, checkRunbook, thenRunbooks, running, onRun, onFire }: Props) {
  const thens = job.then ?? [];
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<'output' | 'flow' | 'investigation'>('output');
  const sendTestAlert = async () => {
    setAlertBusy(true);
    setAlertMsg(null);
    // Representative single host — real alerts fire per-target, so the test
    // mirrors that rather than listing every node.
    const r = await testAlert(job.run, job.targets[0]);
    setAlertBusy(false);
    setAlertMsg(r.sent ? 'SENT ✓' : 'FAILED');
  };
  const state = uiState(job.state.running);
  const aiEnabled = !!useAiStatus()?.enabled;
  const showInvestigation = aiEnabled || !!job.investigate;
  const activeTab = tab === 'investigation' && !showInvestigation ? 'output' : tab;
  const { human } = humanizeCron(job.schedule);
  const notifyOn = job.notify?.on ?? [];
  const single = job.targets.length === 1;
  const [group, server] = job.targets[0].split('/');
  const runsOn = single ? server : `${job.targets.length} hosts`;

  return (
    <>
      {state === 'running' && (
        <div className="m-runstatus">
          <span className="m-live"><span className="m-blip" /> checking now</span>
          <span>{job.run}</span>
        </div>
      )}

      <div className="m-dhead">
        <div className="m-dhead-row">
          <div className="m-dhead-ttl">{job.name}</div>
          {!thens.length && <span className="m-chip key" style={{ background: 'var(--m-ink-2)' }}>monitor</span>}
        </div>
        {job.description && <div className="m-dhead-desc">{job.description}</div>}
        <div className="m-dhead-target">
          <span className="m-chip"><span className="m-chip-dot" />{runsOn}</span>
          <span className="m-chip" style={{ color: state === 'running' ? 'var(--m-ok)' : undefined }}>
            <span className="m-chip-dot" style={{ background: state === 'running' ? 'var(--m-ok)' : undefined }} />
            enabled
          </span>
        </div>
      </div>

      <div className="m-jsched">
        <div>
          <div className="k">schedule</div>
          <div className="big">{human}</div>
          <div className="raw">{job.schedule}</div>
        </div>
        <div>
          <div className="k">runs on</div>
          <div className="big">{runsOn}</div>
          <div className="raw">{single ? group : job.targets.map((t) => t.split('/')[1]).join(', ')}</div>
        </div>
      </div>

      {/* per-target last-run status */}
      <div className="m-jtargets">
        {job.targets.map((t) => {
          const o = !running ? summarizeTarget(job, job.state.targets[t]) : null;
          return (
            <div key={t} className="m-jtarget">
              <span className="nm">{t.split('/')[1]}</span>
              {o ? <span className={`m-jobout ${o.tone}`}>{o.text}</span> : <span className="dim">—</span>}
            </div>
          );
        })}
      </div>

      <div className="m-content">
        <div className="m-jtabs">
          <button className={`m-jtab ${activeTab === 'output' ? 'on' : ''}`} onClick={() => setTab('output')}>Last run</button>
          <button className={`m-jtab ${activeTab === 'flow' ? 'on' : ''}`} onClick={() => setTab('flow')}>Flow</button>
          {showInvestigation && (
            <button className={`m-jtab ${activeTab === 'investigation' ? 'on' : ''}`} onClick={() => setTab('investigation')}>
              AI Chat{Object.values(job.state.targets).some((t) => t.investigation) && <span className="m-jtab-badge">●</span>}
            </button>
          )}
        </div>
        {activeTab === 'output' && <JobOutput job={job} />}
        {activeTab === 'investigation' && <JobInvestigations job={job} aiEnabled={aiEnabled} />}
        {activeTab === 'flow' && (
        <div className="m-jflow">
          {/* CHECK */}
          <div className="m-jstep">
            <div className="m-jrail"><div className="m-jnode">1</div><div className="m-jline" /></div>
            <div className="m-jbody">
              <div className="m-jkind ok">{human} · run check</div>
              <div className="m-jbk">{job.run}</div>
              {checkRunbook?.description && <div className="m-jbd">{checkRunbook.description}</div>}
              <Peek runbook={checkRunbook} />
              <div className="m-jmeta">on <b>{job.targets.join(', ')}</b> · exit code drives the gate ↓</div>
            </div>
          </div>

          {/* GATE */}
          <div className="m-jstep">
            <div className="m-jrail"><div className="m-jnode dia"><span>?</span></div><div className="m-jline" /></div>
            <div className="m-jbody">
              <div className="m-jkind err">gate · when</div>
              <div className="m-jcond">{condText(job.when)}</div>
              <div className="m-jbranch"><span className="y">✓ false</span> → healthy · sleep until next tick</div>
              <div className="m-jbranch t">
                <span className="n">✗ true</span> → {thens.length ? `run ${thens.length === 1 ? 'response' : `${thens.length} responses in order`} ↓` : 'alert only · no remediation ↓'}
              </div>
            </div>
          </div>

          {/* THEN chain */}
          {thens.map((id, i) => (
            <div className="m-jstep" key={id}>
              <div className="m-jrail"><div className="m-jnode warn">{i + 2}</div><div className="m-jline" /></div>
              <div className="m-jbody">
                <div className="m-jkind err">then · respond{thens.length > 1 ? ` · ${i + 1}/${thens.length}` : ''}</div>
                <div className="m-jbk">{id}</div>
                {thenRunbooks[id]?.description && <div className="m-jbd">{thenRunbooks[id]?.description}</div>}
                <Peek runbook={thenRunbooks[id] ?? null} />
              </div>
            </div>
          ))}

          {/* NOTIFY */}
          {job.notify && (
            <div className="m-jstep">
              <div className="m-jrail"><div className="m-jnode">!</div></div>
              <div className="m-jbody last">
                <div className="m-jkind">notify · ntfy</div>
                <div className="m-jntfy">
                  {notifyOn.includes('action') && <span className="nf">on <b>action</b> · fix ran</span>}
                  {notifyOn.includes('error') && <span className="nf err">on <b>error</b> · run failed</span>}
                  {job.notify.priority && <span className="nf pri">priority · {job.notify.priority}</span>}
                </div>
              </div>
            </div>
          )}
        </div>
        )}
      </div>

      {/* Forced run — the real `then` chain + real alerts, unlike TEST ALERT
          (synthetic push, nothing runs). Own row: it's a heavier action. */}
      {thens.length > 0 && (
        <div className="m-actionbar">
          <button className="m-run-btn outline small" disabled={running} onClick={onFire}
            title={`Run ${job.run}, force the gate, and run ${thens.join(' + ')} for real — actual alerts fire`}>
            {running ? 'RUNNING…' : 'TEST FIRE · RUNS FOR REAL ▸'}
          </button>
        </div>
      )}
      <div className="m-actionbar two">
        <button className="m-run-btn outline small" disabled={alertBusy} onClick={sendTestAlert}
          title="Send a test ntfy alert simulating a failure — nothing runs">
          {alertBusy ? 'SENDING…' : alertMsg ?? 'TEST ALERT'}
        </button>
        <button className="m-run-btn" disabled={running} onClick={onRun}>
          {running ? 'RUNNING…' : 'RUN CHECK ▸'}
        </button>
      </div>
      {(() => {
        const o = !running ? summarizeJobRun(job) : null;
        return o && <div className={`m-jobout ${o.tone}`}>{o.text}</div>;
      })()}
    </>
  );
}
