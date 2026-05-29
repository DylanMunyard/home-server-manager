export type ServerSummary = {
  id: string;          // "<groupId>/<serverId>"
  groupId: string;
  serverId: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authType: 'key' | 'password';
};

export type GroupSummary = {
  id: string;
  name: string;
  description?: string;
  servers: ServerSummary[];
};

export type ServerDetail = ServerSummary & {
  groupName: string;
  groupDescription?: string;
  keyPath?: string;
  rawKeyPath?: string;
  passphraseSet: boolean;
  passwordSet: boolean;
};

export type RunbookSummary = {
  id: string;
  name: string;
  description: string;
  filename: string;
};

export type Runbook = RunbookSummary & { contents: string };

// ── Recurring jobs ──────────────────────────────────────────────
export type JobTrigger = { exit?: 'nonzero' | 'zero' | number; stdoutContains?: string };
export type JobNotify = { on: ('action' | 'error')[]; priority?: string };

export type RunResult = {
  connected: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  error?: string;
  durationMs: number;
};

// Mirrors the API's in-memory JobRunState. No history — single last-run snapshot.
export type JobRunState = {
  running: boolean;
  lastRunAt?: string;
  lastDurationMs?: number;
  lastCheck?: RunResult;
  lastTriggered?: boolean;
  lastAction?: RunResult;
  lastError?: string;
};

export type Job = {
  id: string;
  name: string;
  description?: string;
  schedule: string;        // raw 5-field cron
  target: string;          // "<group>/<server>"
  run: string;             // check runbook id
  when?: JobTrigger;
  then?: string;           // remediation runbook id
  notify?: JobNotify;
  env?: Record<string, string>;
  nextRunAt: string | null;
  state: JobRunState;
};

// Wraps fetch so an expired/absent session (401) bounces to the OAuth start
// route instead of surfacing as a generic load error. Same-origin requests
// send the session cookie automatically.
async function apiGet(path: string, errorMsg: string): Promise<Response> {
  const r = await fetch(path);
  if (r.status === 401) {
    window.location.href = '/api/auth/login';
    // Never resolves — we're navigating away.
    return new Promise<Response>(() => {});
  }
  if (!r.ok) throw new Error(errorMsg);
  return r;
}

export async function fetchGroups(): Promise<GroupSummary[]> {
  const r = await apiGet('/api/groups', 'failed to load groups');
  return r.json();
}

export async function fetchServerDetail(id: string): Promise<ServerDetail> {
  // id is "<group>/<server>"; both segments need to be URL-encoded individually
  // so we preserve the slash as a path separator.
  const [g, s] = id.split('/');
  const r = await apiGet(
    `/api/servers/${encodeURIComponent(g)}/${encodeURIComponent(s)}`,
    'failed to load server detail',
  );
  return r.json();
}

export async function fetchRunbooks(): Promise<RunbookSummary[]> {
  const r = await apiGet('/api/runbooks', 'failed to load runbooks');
  return r.json();
}

export async function fetchRunbook(id: string): Promise<Runbook> {
  const r = await apiGet(`/api/runbooks/${encodeURIComponent(id)}`, 'failed to load runbook');
  return r.json();
}

// Same 401 bounce as apiGet, for the run-now action.
async function apiPost(path: string, errorMsg: string): Promise<Response> {
  const r = await fetch(path, { method: 'POST' });
  if (r.status === 401) {
    window.location.href = '/api/auth/login';
    return new Promise<Response>(() => {});
  }
  if (!r.ok) throw new Error(errorMsg);
  return r;
}

export async function fetchJobs(): Promise<Job[]> {
  const r = await apiGet('/api/jobs', 'failed to load jobs');
  return r.json();
}

// Triggers a job off-schedule; resolves with the updated job (incl. fresh state).
export async function runJob(id: string): Promise<Job> {
  const r = await apiPost(`/api/jobs/${encodeURIComponent(id)}/run`, 'failed to run job');
  return r.json();
}

// Fires a synthetic "script failed" ntfy alert (no run, no remediation) so you
// can verify alert delivery from the runbook page. Returns {sent, reason?} for
// 2xx and the 502/503 cases alike, so the caller can show the actual reason.
export async function testAlert(
  runbook: string | null,
  target: string | null,
): Promise<{ sent: boolean; reason?: string }> {
  const r = await fetch('/api/alerts/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runbook: runbook ?? undefined, target: target ?? undefined }),
  });
  if (r.status === 401) {
    window.location.href = '/api/auth/login';
    return new Promise(() => {});
  }
  return r.json();
}
