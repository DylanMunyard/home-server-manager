import type { NtfyPriority } from '../alerts/ntfy.js';
import type { CollectResult } from '../ssh/ssh.collect.js';

/** What a check's result has to look like for the job to take action. */
export type Trigger = {
  /** 'nonzero' | 'zero' | a specific exit code. Defaults to 'nonzero'. */
  exit?: 'nonzero' | 'zero' | number;
  /** Optional extra condition, ANDed with `exit`: stdout must contain this. */
  stdoutContains?: string;
};

export type NotifyEvent = 'action' | 'error';

export type NotifyRule = {
  on: NotifyEvent[];
  priority?: NtfyPriority;
};

export type JobConfig = {
  id: string;            // filename stem
  name: string;          // display label (defaults to id)
  description?: string;
  schedule: string;      // 5-field cron
  targets: string[];     // one or more global server ids "<group>/<server>"
  run: string;           // runbook id executed each tick (the "check")
  when?: Trigger;        // when run's result means "remediate"
  then?: string;         // runbook id run when `when` matches
  notify?: NotifyRule;
  // Vars injected (as `export NAME=value`) into the job's runbooks before they
  // run over SSH. Values support ${VAR} from the API process env (.env / k8s
  // secret) — stored RAW here (the ${VAR} reference, not the resolved value) so
  // GET /api/jobs never leaks secrets; resolved at execution time.
  env?: Record<string, string>;
  // Literal values for the target runbook's declared `# params:`. Resolved
  // against each runbook's params at run time (defaults fill in, undeclared keys
  // are dropped). Use this for the runbook inputs a scheduled run needs; use
  // `env` for secrets (these are plain values, surfaced by GET /api/jobs).
  params?: Record<string, string>;
  // Opt-in: when this job fails, kick off an AI investigation of the target —
  // an agentic loop of read-only SSH probes that correlates the cause and pushes
  // a follow-up ntfy. Off by default (it costs tokens + SSH per failure); only
  // enable it where a "what was happening on the box?" answer earns its keep.
  // No-op when AI isn't configured. See api/src/ai/ai.investigate.ts.
  investigate?: boolean;
  // Optional free-text intent for the investigation — what the AI should focus
  // on / correlate (e.g. "correlate the high temp with what's running"). In the
  // YAML, writing a string for `investigate:` both enables it AND sets this; the
  // loader splits the two. Steers the probe loop when the script's intent isn't
  // self-evident; omit it and the AI infers from the script + output + metrics.
  investigateHint?: string;
};

/** Captured outcome of running one runbook over SSH (shared SSH collect shape). */
export type RunResult = CollectResult;

/** Most recent execution of the job's runbooks against a single target. */
export type TargetRunState = {
  lastCheck?: RunResult;     // result of `run`
  lastTriggered?: boolean;   // did `when` match?
  lastAction?: RunResult;    // result of `then`, if it ran
  lastError?: string;        // human summary of this target's last failure
  // Latest AI investigation for this target, if `investigate` is on and one has
  // run. Live status + summary are overlaid by GET /api/jobs from the ai
  // registry; the full transcript streams over /ws/ai/investigate?id=…
  investigation?: { id: string; status: 'running' | 'completed' | 'error'; summary?: string };
};

/**
 * In-memory record of a job's most recent execution. No persistence. The job
 * fans out across `targets`, so per-target outcomes live in `targets` keyed by
 * global server id; the top level only holds run-wide timing.
 */
export type JobRunState = {
  running: boolean;
  lastRunAt?: string;        // ISO timestamp
  lastDurationMs?: number;
  targets: Record<string, TargetRunState>;
};
