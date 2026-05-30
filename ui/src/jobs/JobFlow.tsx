import type { Job, Runbook } from '../shared/api.ts';
import { ScriptViewer } from '../runbooks/ScriptViewer.tsx';
import { condText, humanizeCron } from './cron.ts';

type Props = {
  job: Job;
  checkRunbook: Runbook | null;
  remediateRunbook: Runbook | null;
};

function BookRef({ id, runbook }: { id: string; runbook: Runbook | null }) {
  return (
    <div className="flow-book">
      <div className="flow-book-head">
        <span className="flow-book-name">{id}</span>
        <span className="flow-book-tag">runbook</span>
      </div>
      {runbook?.description && <div className="flow-book-desc">{runbook.description}</div>}
      {runbook
        ? <ScriptViewer contents={runbook.contents} />
        : <div className="flow-book-missing">script unavailable</div>}
    </div>
  );
}

export function JobFlow({ job, checkRunbook, remediateRunbook }: Props) {
  const { human } = humanizeCron(job.schedule);
  const notifyOn = job.notify?.on ?? [];

  return (
    <div className="flow">
      {/* 1 — TICK + CHECK */}
      <div className="flow-step">
        <div className="flow-rail">
          <span className="flow-node">1</span>
          <span className="flow-line" />
        </div>
        <div className="flow-body">
          <div className="flow-kind ok">{human} · run check</div>
          <BookRef id={job.run} runbook={checkRunbook} />
          <div className="flow-meta">
            on <b>{job.targets.join(', ')}</b> · exit code drives the gate ↓
          </div>
        </div>
      </div>

      {/* GATE — when */}
      <div className="flow-step">
        <div className="flow-rail">
          <span className="flow-node gate"><span>?</span></span>
          <span className="flow-line" />
        </div>
        <div className="flow-body">
          <div className="flow-kind err">gate · when</div>
          <div className="flow-cond">{condText(job.when)}</div>
          <div className="flow-branch"><span className="y">✓ false</span> → healthy · sleep until next tick</div>
          <div className="flow-branch t">
            <span className="n">✗ true</span> → {job.then ? 'run remediation ↓' : 'alert only · no remediation ↓'}
          </div>
        </div>
      </div>

      {/* 2 — REMEDIATE (hidden when no `then`) */}
      {job.then && (
        <div className="flow-step">
          <div className="flow-rail">
            <span className="flow-node warn">2</span>
            <span className="flow-line" />
          </div>
          <div className="flow-body">
            <div className="flow-kind err">then · remediate</div>
            <BookRef id={job.then} runbook={remediateRunbook} />
          </div>
        </div>
      )}

      {/* NOTIFY (hidden when absent) */}
      {job.notify && (
        <div className="flow-step">
          <div className="flow-rail">
            <span className="flow-node">!</span>
          </div>
          <div className="flow-body last">
            <div className="flow-kind">notify · ntfy</div>
            <div className="flow-notify">
              {notifyOn.includes('action') && <span className="nf">on <b>action</b> · remediation ran</span>}
              {notifyOn.includes('error') && <span className="nf err">on <b>error</b> · a runbook failed</span>}
              {job.notify.priority && <span className="nf pri">priority · {job.notify.priority}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
