import type { JobConfig, JobHistoryEntry, RunOutcome, TargetRunState } from './jobs.types.js';

// In-memory only — same no-persistence rule as jobs.runner.ts's state Map.
// Lost on restart; the point is surviving *between* ticks, not across deploys.
//
// Retention favours failures: every non-'ok' run (a real failure, or a
// triggered remediation) is kept, capped per job so a permanently-flapping
// check can't grow unbounded. Clean ('ok') runs are cheap to lose — only the
// single most recent one is kept, so "last successful run" is always
// available without paying to store every healthy tick.
const MAX_KEPT_PER_JOB = 200;

const nonOk = new Map<string, JobHistoryEntry[]>(); // jobId -> newest-first, outcome !== 'ok'
const lastOk = new Map<string, JobHistoryEntry>();  // jobId -> most recent outcome === 'ok'

/** Worst-target-wins tone for one target's result — mirrors ui/src/jobs/cron.ts's summarizeTarget. */
function targetOutcome(job: JobConfig, ts: TargetRunState): RunOutcome {
  if (ts.lastError) return 'err';
  if (ts.lastTriggered && ts.lastActions?.length) {
    const bad = ts.lastActions.some((a) => a.result.error || a.result.exitCode !== 0);
    return bad ? 'err' : 'warn';
  }
  if (!job.when && ts.lastCheck) {
    return ts.lastCheck.exitCode === 0 ? 'ok' : 'err';
  }
  return 'ok';
}

export function rollupOutcome(job: JobConfig, targets: Record<string, TargetRunState>): RunOutcome {
  const tones = Object.values(targets).map((ts) => targetOutcome(job, ts));
  if (tones.includes('err')) return 'err';
  if (tones.includes('warn')) return 'warn';
  return 'ok';
}

/** Record one completed execution into the job's history. Never throws. */
export function recordRun(job: JobConfig, entry: JobHistoryEntry): void {
  if (entry.outcome === 'ok') {
    lastOk.set(job.id, entry);
    return;
  }
  const list = nonOk.get(job.id) ?? [];
  list.unshift(entry);
  if (list.length > MAX_KEPT_PER_JOB) list.length = MAX_KEPT_PER_JOB;
  nonOk.set(job.id, list);
}

/** Every kept entry for a job, newest first: preserved failures/remediations + the last clean run. */
export function getHistory(jobId: string): JobHistoryEntry[] {
  const entries = [...(nonOk.get(jobId) ?? [])];
  const ok = lastOk.get(jobId);
  if (ok) entries.push(ok);
  return entries.sort((a, b) => (a.runAt < b.runAt ? 1 : -1));
}
