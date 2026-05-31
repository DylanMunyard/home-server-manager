import { useState } from 'react';
import { testAlert, type Job, type Runbook } from '../shared/api.ts';
import { condText, humanizeCron, summarizeJobRun, summarizeTarget, uiState } from '../jobs/cron.ts';
import { JobOutput } from '../jobs/JobOutput.tsx';

type Props = {
  job: Job;
  checkRunbook: Runbook | null;
  remediateRunbook: Runbook | null;
  running: boolean;
  onRun: () => void;
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

export function JobDetailScreen({ job, checkRunbook, remediateRunbook, running, onRun }: Props) {
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<'output' | 'flow'>('output');
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
          {!job.then && <span className="m-chip key" style={{ background: 'var(--m-ink-2)' }}>monitor</span>}
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
          <button className={`m-jtab ${tab === 'output' ? 'on' : ''}`} onClick={() => setTab('output')}>Last run</button>
          <button className={`m-jtab ${tab === 'flow' ? 'on' : ''}`} onClick={() => setTab('flow')}>Flow</button>
        </div>
        {tab === 'output' && <JobOutput job={job} />}
        {tab === 'flow' && (
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
                <span className="n">✗ true</span> → {job.then ? 'run remediation ↓' : 'alert only · no remediation ↓'}
              </div>
            </div>
          </div>

          {/* REMEDIATE */}
          {job.then && (
            <div className="m-jstep">
              <div className="m-jrail"><div className="m-jnode warn">2</div><div className="m-jline" /></div>
              <div className="m-jbody">
                <div className="m-jkind err">then · remediate</div>
                <div className="m-jbk">{job.then}</div>
                {remediateRunbook?.description && <div className="m-jbd">{remediateRunbook.description}</div>}
                <Peek runbook={remediateRunbook} />
              </div>
            </div>
          )}

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
