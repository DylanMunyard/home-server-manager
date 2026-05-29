import type { NtfyPriority } from '../alerts/ntfy.js';

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
  target: string;        // global server id "<group>/<server>"
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
};

/** Captured outcome of running one runbook over SSH. */
export type RunResult = {
  connected: boolean;        // did the SSH session reach exec?
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  error?: string;            // SSH/connect-level error message, if any
  durationMs: number;
};

/** In-memory record of a job's most recent execution. No persistence. */
export type JobRunState = {
  running: boolean;
  lastRunAt?: string;        // ISO timestamp
  lastDurationMs?: number;
  lastCheck?: RunResult;     // result of `run`
  lastTriggered?: boolean;   // did `when` match?
  lastAction?: RunResult;    // result of `then`, if it ran
  lastError?: string;        // human summary of the last failure, if any
};
