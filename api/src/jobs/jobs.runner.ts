import { expandEnv } from '../config.js';
import { loadServer } from '../servers/servers.loader.js';
import { loadRunbook, resolveParamValues, type Runbook } from '../runbooks/runbooks.loader.js';
import { collectScript } from '../ssh/ssh.collect.js';
import { exportPrelude } from '../ssh/prelude.js';
import { sendAlert } from '../alerts/ntfy.js';
import { recordRun, rollupOutcome } from './jobs.history.js';
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

type ActionRun = { runbook: string; result: RunResult };

function output(r: RunResult): string {
  return [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || '(no output)';
}

// ntfy turns a body over ~4 KB into a .txt attachment, unreadable on a phone —
// keep each section short enough that a check + a couple of diagnostics stay
// inline. The full output is always in the jobs UI (lastCheck/lastActions).
function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (+${s.length - max} chars — full output in the jobs UI)`;
}

/**
 * Body for the `action` alert: WHY the gate tripped (the check's output), then
 * one section per `then` runbook. One push per target, however long the chain.
 */
function actionAlertBody(target: string, job: JobConfig, check: RunResult, actions: ActionRun[]): string {
  const parts = [
    `target: ${target}`,
    `check:  ${job.run} → ${failureSummary(check)}`,
    '',
    clip(output(check), 800),
  ];
  for (const a of actions) {
    parts.push('', `== ${a.runbook} (${failureSummary(a.result)}) ==`, clip(output(a.result), 1200));
  }
  return parts.join('\n');
}

/**
 * Run the job's check (+ optional `then` + alerts) against ONE target, returning
 * that target's outcome. Never throws — a bad target must not abort its siblings
 * or crash the scheduler tick. The notify semantics are unchanged from the
 * single-target days; they just key on this target.
 */
async function runOnTarget(job: JobConfig, target: string, forceTrigger: boolean): Promise<TargetRunState> {
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

    // A forced run ("Test fire") treats the gate as tripped no matter what the
    // check said — the real `then` chain runs and the real alerts fire, which
    // is the only honest way to test the whole pipeline on a healthy box.
    const triggered = forceTrigger || (job.when ? triggerMatches(job.when, check) : false);
    ts.lastTriggered = triggered;

    // The "work runbooks" whose failure counts as an `error` for alerting:
    // the `then` chain if it ran, else the check when the job has no `when`
    // (i.e. the check IS the work). A check with a `when` is a signal — its
    // nonzero exit is the trigger, not a failure.
    //
    // The chain runs SEQUENTIALLY in declared order — responses often sample
    // the same resources (perf, nsenter) and their sections should read in
    // order in the alert. One failing doesn't stop the rest: a later runbook
    // may still carry the useful signal.
    const actions: ActionRun[] = [];
    if (triggered && job.then) {
      for (const id of job.then) {
        const actionRunbook = await loadRunbook(id);
        if (!actionRunbook) throw new Error(`unknown then runbook '${id}'`);
        actions.push({ runbook: id, result: await collectScript(server, runbookPrelude(actionRunbook, job) + actionRunbook.contents) });
      }
      ts.lastActions = actions;
    }

    const events = new Set(job.notify?.on ?? []);
    const priority = job.notify?.priority;

    // `action` event — the chain ran (informational), regardless of outcome.
    // One combined push per target: trigger reason + a section per runbook.
    if (actions.length > 0 && events.has('action')) {
      const ok = actions.every((a) => !failed(a.result));
      await sendAlert({
        // Mark forced runs so a test push is never mistaken for a real incident.
        title: `${job.name}: ran ${job.then!.join(' + ')} on ${target}${forceTrigger ? ' (test fire)' : ''}`,
        body: actionAlertBody(target, job, check, actions),
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
    const failedActions = actions.filter((a) => failed(a.result));
    if (failedActions.length > 0) {
      // The error alert carries the FIRST failure's output; the `action` alert
      // (and the jobs UI) has every section.
      const ids = failedActions.map((a) => a.runbook).join(', ');
      workFailure = {
        runbookId: failedActions[0].runbook,
        result: failedActions[0].result,
        reason: `then '${ids}' failed: ${failureSummary(failedActions[0].result)}`,
        title: `${job.name}: ${ids} FAILED on ${target}`,
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

      // `error` event — push the immediate failure alert only when the job
      // itself executed and failed, not if it couldn't connect to the server
      // or encountered an SSH-level / prerequisite failure.
      const isConnectionFailure = !workFailure.result.connected || !!workFailure.result.error;
      if (events.has('error') && !isConnectionFailure) {
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
      ` triggered=${triggered}${forceTrigger ? ' (forced)' : ''}` +
      actions.map((a) => ` action(${a.runbook}) exit=${a.result.exitCode}${a.result.error ? ` error=${a.result.error}` : ''}`).join(''),
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
export async function executeJob(job: JobConfig, opts: { forceTrigger?: boolean } = {}): Promise<void> {
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
    const results = await Promise.all(job.targets.map((t) => runOnTarget(job, t, opts.forceTrigger ?? false)));
    job.targets.forEach((t, i) => { s.targets[t] = results[i]; });
  } finally {
    s.running = false;
    s.lastRunAt = new Date(start).toISOString();
    s.lastDurationMs = Date.now() - start;
    recordRun(job, {
      runAt: s.lastRunAt,
      durationMs: s.lastDurationMs,
      forced: opts.forceTrigger ?? false,
      outcome: rollupOutcome(job, s.targets),
      targets: s.targets,
    });
  }
}
