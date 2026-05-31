import type { Job, TargetRunState } from '../shared/api.ts';
import { summarizeTarget } from './cron.ts';

// The captured output for one target's last run: the check's stdout/stderr
// (and any SSH-level error), or the recorded lastError if it never produced a
// result. This is the payload the user actually wants — e.g. which indexers a
// jackett-health check found down — that the head's one-line pill hides.
function outputText(ts: TargetRunState): string {
  const r = ts.lastCheck;
  if (!r) return ts.lastError ?? '(no output)';
  let text = [r.stdout, r.stderr].map((s) => s?.trim()).filter(Boolean).join('\n');
  if (r.error) text = text ? `${text}\n${r.error}` : r.error;
  return text || '(no output)';
}

function TargetBlock({ job, target, ts }: { job: Job; target: string; ts: TargetRunState | undefined }) {
  const [group, server] = target.split('/');
  const o = ts ? summarizeTarget(job, ts) : null;
  // The host is incidental for a single-target check (the output is the point),
  // so only label + tag per-host when the job actually fans out.
  const multi = job.targets.length > 1;
  return (
    <div className="job-output-target">
      {multi && (
        <div className="job-output-th">
          <span className="mono"><span className="dim">{group}/</span>{server}</span>
          {o && <span className={`job-output-tag ${o.tone}`}>{o.text}</span>}
        </div>
      )}
      <pre className="job-output-pre">{ts ? outputText(ts) : '(no result)'}</pre>
    </div>
  );
}

export function JobOutput({ job }: { job: Job }) {
  const { lastRunAt, lastDurationMs, targets } = job.state;
  if (!lastRunAt) {
    return (
      <div className="job-output empty">
        No runs yet{job.nextRunAt ? ` · next tick ${new Date(job.nextRunAt).toLocaleString()}` : ''}.
      </div>
    );
  }
  return (
    <div className="job-output">
      <div className="job-output-when">
        last run {new Date(lastRunAt).toLocaleString()}
        {typeof lastDurationMs === 'number' ? ` · ${(lastDurationMs / 1000).toFixed(1)}s` : ''}
      </div>
      {job.targets.map((t) => (
        <TargetBlock key={t} job={job} target={t} ts={targets[t]} />
      ))}
    </div>
  );
}
