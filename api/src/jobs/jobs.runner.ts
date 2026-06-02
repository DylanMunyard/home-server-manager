import { expandEnv } from '../config.js';
import { loadServer } from '../servers/servers.loader.js';
import { loadRunbook, resolveParamValues, type Runbook } from '../runbooks/runbooks.loader.js';
import { collectScript } from '../ssh/ssh.collect.js';
import { exportPrelude } from '../ssh/prelude.js';
import { sendAlert } from '../alerts/ntfy.js';
import type { JobConfig, JobRunState, RunResult, TargetRunState, Trigger } from './jobs.types.js';

// In-memory job state. Lost on restart by design — the scheduler just starts
// fresh. No DB, no state file (see plan / CLAUDE.md no-persistence rule).
const state = new Map<string, JobRunState>();

export function getState(id: string): JobRunState {
  let s = state.get(id);
  if (!s) {
    s = { running: false, targets: {} };
    state.set(id, s);
  }
  return s;
}

export function allStates(): Record<string, JobRunState> {
  return Object.fromEntries(state);
}

/**
 * `export NAME=value` lines for the job's env, resolved from process env via
 * ${VAR}. Prepended to a runbook so the remote `bash -s` sees them as real
 * env vars (the API process env doesn't propagate over SSH on its own).
 */
function envPrelude(env: Record<string, string> | undefined): string {
  if (!env) return '';
  const resolved = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, expandEnv(v)]),
  );
  return exportPrelude(resolved);
}

/**
 * The full `export` prelude for one of the job's runbooks: the job's `env`
 * (${VAR}-resolved) followed by the runbook's params resolved against the job's
 * `params` (declared defaults fill in; `params` override on name collision).
 * Resolved per-runbook because `run` and `then` can declare different params.
 */
function runbookPrelude(runbook: Runbook, job: JobConfig): string {
  return envPrelude(job.env) + exportPrelude(resolveParamValues(runbook.params, job.params ?? {}));
}

/** Did the check's result match the trigger? `when.exit` defaults to 'nonzero'. */
function triggerMatches(when: Trigger, r: RunResult): boolean {
  if (r.error) return false; // SSH-level failure is an error, not a clean signal
  const want = when.exit ?? 'nonzero';
  const code = r.exitCode;
  let exitOk: boolean;
  if (want === 'nonzero') exitOk = code !== 0;
  else if (want === 'zero') exitOk = code === 0;
  else exitOk = code === want;
  if (!exitOk) return false;
  if (when.stdoutContains !== undefined && !r.stdout.includes(when.stdoutContains)) return false;
  return true;
}

/** A runbook "failed" if SSH errored or it exited nonzero. */
function failed(r: RunResult): boolean {
  return !!r.error || r.exitCode !== 0;
}

function failureSummary(r: RunResult): string {
  if (r.error) return r.error;
  return `exit ${r.exitCode}${r.signal ? ` (signal ${r.signal})` : ''}`;
}

function alertBody(target: string, runbook: string, r: RunResult): string {
  const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  return [
    `target:  ${target}`,
    `runbook: ${runbook}`,
    `result:  ${failureSummary(r)}`,
    '',
    out || '(no output)',
  ].join('\n');
}

/**
 * Run the job's check (+ optional `then` + alerts) against ONE target, returning
 * that target's outcome. Never throws — a bad target must not abort its siblings
 * or crash the scheduler tick. The notify semantics are unchanged from the
 * single-target days; they just key on this target.
 */
async function runOnTarget(job: JobConfig, target: string): Promise<TargetRunState> {
  const ts: TargetRunState = {};
  try {
    const server = await loadServer(target);
    if (!server) throw new Error(`unknown target '${target}'`);

    const checkRunbook = await loadRunbook(job.run);
    if (!checkRunbook) throw new Error(`unknown run runbook '${job.run}'`);

    // Resolving `env` throws here if a ${VAR} is unset, which the catch turns
    // into this target's lastError (no process crash, siblings unaffected).
    const check = await collectScript(server, runbookPrelude(checkRunbook, job) + checkRunbook.contents);
    ts.lastCheck = check;

    const triggered = job.when ? triggerMatches(job.when, check) : false;
    ts.lastTriggered = triggered;

    // The "work runbook" whose failure counts as an `error` for alerting:
    // `then` if it ran, else the check when the job has no `when` (i.e. the
    // check IS the work). A check with a `when` is a signal — its nonzero exit
    // is the trigger, not a failure.
    let action: RunResult | undefined;
    if (triggered && job.then) {
      const actionRunbook = await loadRunbook(job.then);
      if (!actionRunbook) throw new Error(`unknown then runbook '${job.then}'`);
      action = await collectScript(server, runbookPrelude(actionRunbook, job) + actionRunbook.contents);
      ts.lastAction = action;
    }

    const events = new Set(job.notify?.on ?? []);
    const priority = job.notify?.priority;

    // `action` event — remediation ran (informational), regardless of outcome.
    if (action && events.has('action')) {
      const ok = !failed(action);
      await sendAlert({
        title: `${job.name}: ran ${job.then} on ${target}`,
        body: alertBody(target, job.then!, action),
        priority,
        tags: [ok ? 'wrench' : 'rotating_light'],
      });
    }

    // The effective work failure (independent of notify config) — the runbook
    // whose failure counts as an `error`, with a human reason + alert title.
    // `then` if it ran and failed; else the check when the job has no `when`
    // (the check IS the work); else an SSH-level error on the check (a check
    // WITH a `when` exiting nonzero is a trigger signal, not a failure).
    let workFailure: { runbookId: string; result: RunResult; reason: string; title: string } | undefined;
    if (action && failed(action)) {
      workFailure = {
        runbookId: job.then!,
        result: action,
        reason: `then '${job.then}' failed: ${failureSummary(action)}`,
        title: `${job.name}: ${job.then} FAILED on ${target}`,
      };
    } else if (!job.when && failed(check)) {
      workFailure = {
        runbookId: job.run,
        result: check,
        reason: `run '${job.run}' failed: ${failureSummary(check)}`,
        title: `${job.name}: ${job.run} FAILED on ${target}`,
      };
    } else if (check.error) {
      workFailure = {
        runbookId: job.run,
        result: check,
        reason: `run '${job.run}' could not execute: ${check.error}`,
        title: `${job.name}: ${job.run} could not run on ${target}`,
      };
    }

    if (workFailure) {
      ts.lastError = workFailure.reason;

      // `error` event — push the immediate failure alert.
      if (events.has('error')) {
        await sendAlert({
          title: workFailure.title,
          body: alertBody(target, workFailure.runbookId, workFailure.result),
          priority: priority ?? 'high',
          tags: ['rotating_light'],
        });
      }

      // NOTE: AI investigation is intentionally NOT auto-triggered here. It runs
      // only on demand from the Jobs UI ("Investigate" → POST /api/jobs/:id/
      // investigate), so a flapping check can't spiral into an investigation
      // every tick. The job's `investigate:` hint still steers those manual
      // runs. (If auto-firing is reintroduced, gate it behind a per-host
      // cooldown so it can't run on every failure.)
    }

    console.log(
      `[jobs] ${job.id}@${target}: check exit=${check.exitCode}${check.error ? ` error=${check.error}` : ''}` +
      ` triggered=${triggered}` +
      (action ? ` action(${job.then}) exit=${action.exitCode}${action.error ? ` error=${action.error}` : ''}` : ''),
    );
  } catch (err) {
    ts.lastError = (err as Error).message;
    console.error(`[jobs] ${job.id}@${target}: ${(err as Error).message}`);
  }
  return ts;
}

/**
 * Execute a job once: fan out across every `target` in parallel (independent SSH
 * sessions), recording each target's outcome. Updates in-memory state. Never
 * throws — scheduler ticks must not crash the process.
 */
export async function executeJob(job: JobConfig): Promise<void> {
  const s = getState(job.id);
  if (s.running) {
    console.warn(`[jobs] ${job.id}: previous run still in flight — skipping tick`);
    return;
  }
  s.running = true;
  const start = Date.now();
  // Reset per-run results so a removed target / stale outcome doesn't linger.
  s.targets = {};

  try {
    const results = await Promise.all(job.targets.map((t) => runOnTarget(job, t)));
    job.targets.forEach((t, i) => { s.targets[t] = results[i]; });
  } finally {
    s.running = false;
    s.lastRunAt = new Date(start).toISOString();
    s.lastDurationMs = Date.now() - start;
  }
}
