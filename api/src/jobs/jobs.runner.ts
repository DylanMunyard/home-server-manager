import { expandEnv } from '../config.js';
import { loadServer } from '../servers/servers.loader.js';
import { loadRunbook, resolveParamValues, type Runbook } from '../runbooks/runbooks.loader.js';
import { runScript } from '../ssh/ssh.session.js';
import { exportPrelude } from '../ssh/prelude.js';
import type { ServerConfig } from '../servers/servers.types.js';
import { sendAlert } from '../alerts/ntfy.js';
import type { JobConfig, JobRunState, RunResult, Trigger } from './jobs.types.js';

// In-memory job state. Lost on restart by design — the scheduler just starts
// fresh. No DB, no state file (see plan / CLAUDE.md no-persistence rule).
const state = new Map<string, JobRunState>();

export function getState(id: string): JobRunState {
  let s = state.get(id);
  if (!s) {
    s = { running: false };
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

/** Run one runbook over SSH, buffering output into a single RunResult. */
function runRunbookOnce(server: ServerConfig, contents: string): Promise<RunResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let connected = false;
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let signal: string | null | undefined;
    let error: string | undefined;

    const handle = runScript(server, contents, (e) => {
      switch (e.type) {
        case 'connect': connected = true; break;
        case 'stdout':  stdout += e.data; break;
        case 'stderr':  stderr += e.data; break;
        case 'exit':    exitCode = e.code; signal = e.signal; break;
        case 'error':   error = e.message; break;
      }
    });

    handle.done.then(() => {
      resolve({ connected, stdout, stderr, exitCode, signal, error, durationMs: Date.now() - start });
    });
  });
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
 * Execute a job once: run the check, evaluate `when`, optionally run `then`,
 * then fire ntfy alerts per `notify`. Updates in-memory state. Never throws —
 * scheduler ticks must not crash the process.
 */
export async function executeJob(job: JobConfig): Promise<void> {
  const s = getState(job.id);
  if (s.running) {
    console.warn(`[jobs] ${job.id}: previous run still in flight — skipping tick`);
    return;
  }
  s.running = true;
  const start = Date.now();
  // Reset the per-run fields so stale results don't linger after a clean run.
  s.lastTriggered = false;
  s.lastAction = undefined;
  s.lastError = undefined;

  try {
    const server = await loadServer(job.target);
    if (!server) throw new Error(`unknown target '${job.target}'`);

    const checkRunbook = await loadRunbook(job.run);
    if (!checkRunbook) throw new Error(`unknown run runbook '${job.run}'`);

    // Built per-runbook below. Resolving `env` throws here if a ${VAR} is unset,
    // which the outer catch turns into lastError (no process crash).
    const check = await runRunbookOnce(server, runbookPrelude(checkRunbook, job) + checkRunbook.contents);
    s.lastCheck = check;

    const triggered = job.when ? triggerMatches(job.when, check) : false;
    s.lastTriggered = triggered;

    // The "work runbook" whose failure counts as an `error` for alerting:
    // `then` if it ran, else the check when the job has no `when` (i.e. the
    // check IS the work). A check with a `when` is a signal — its nonzero exit
    // is the trigger, not a failure.
    let action: RunResult | undefined;
    if (triggered && job.then) {
      const actionRunbook = await loadRunbook(job.then);
      if (!actionRunbook) throw new Error(`unknown then runbook '${job.then}'`);
      action = await runRunbookOnce(server, runbookPrelude(actionRunbook, job) + actionRunbook.contents);
      s.lastAction = action;
    }

    const events = new Set(job.notify?.on ?? []);
    const priority = job.notify?.priority;

    // `action` event — remediation ran (informational), regardless of outcome.
    if (action && events.has('action')) {
      const ok = !failed(action);
      await sendAlert({
        title: `${job.name}: ran ${job.then} on ${job.target}`,
        body: alertBody(job.target, job.then!, action),
        priority,
        tags: [ok ? 'wrench' : 'rotating_light'],
      });
    }

    // `error` event — the effective work runbook failed.
    if (events.has('error')) {
      if (action && failed(action)) {
        s.lastError = `then '${job.then}' failed: ${failureSummary(action)}`;
        await sendAlert({
          title: `${job.name}: ${job.then} FAILED on ${job.target}`,
          body: alertBody(job.target, job.then!, action),
          priority: priority ?? 'high',
          tags: ['rotating_light'],
        });
      } else if (!job.when && failed(check)) {
        // Plain scheduled job: the check is the work, so its failure is an error.
        s.lastError = `run '${job.run}' failed: ${failureSummary(check)}`;
        await sendAlert({
          title: `${job.name}: ${job.run} FAILED on ${job.target}`,
          body: alertBody(job.target, job.run, check),
          priority: priority ?? 'high',
          tags: ['rotating_light'],
        });
      } else if (check.error) {
        // Even a check (with a `when`) can hit an SSH-level error — that's not
        // a trigger signal, it's a genuine failure worth surfacing.
        s.lastError = `run '${job.run}' could not execute: ${check.error}`;
        await sendAlert({
          title: `${job.name}: ${job.run} could not run on ${job.target}`,
          body: alertBody(job.target, job.run, check),
          priority: priority ?? 'high',
          tags: ['rotating_light'],
        });
      }
    }

    console.log(
      `[jobs] ${job.id}: check exit=${check.exitCode}${check.error ? ` error=${check.error}` : ''}` +
      ` triggered=${triggered}` +
      (action ? ` action(${job.then}) exit=${action.exitCode}${action.error ? ` error=${action.error}` : ''}` : ''),
    );
  } catch (err) {
    s.lastError = (err as Error).message;
    console.error(`[jobs] ${job.id}: ${(err as Error).message}`);
  } finally {
    s.running = false;
    s.lastRunAt = new Date(start).toISOString();
    s.lastDurationMs = Date.now() - start;
  }
}
