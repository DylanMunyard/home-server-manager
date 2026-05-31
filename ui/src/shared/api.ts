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

// A declared input; `name` is the shell var injected before the script runs.
// `choices` present ⇒ render a <select>; `default`/first-choice prefill the UI.
export type RunbookParam = {
  name: string;
  label: string;
  required: boolean;
  default?: string;
  choices?: string[];
};

export type RunbookSummary = {
  id: string;
  name: string;
  description: string;
  params: RunbookParam[];
  // Set ⇒ a manual run must be confirmed first (the value is the prompt text).
  // Marks a destructive/irreversible runbook. Jobs and feature integrations run
  // the script directly and ignore this.
  confirm?: string;
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

// Mirrors the API's per-target outcome within a JobRunState.
export type TargetRunState = {
  lastCheck?: RunResult;
  lastTriggered?: boolean;
  lastAction?: RunResult;
  lastError?: string;
};

// Mirrors the API's in-memory JobRunState. No history — single last-run snapshot
// per target (keyed by global server id).
export type JobRunState = {
  running: boolean;
  lastRunAt?: string;
  lastDurationMs?: number;
  targets: Record<string, TargetRunState>;
};

export type Job = {
  id: string;
  name: string;
  description?: string;
  schedule: string;        // raw 5-field cron
  targets: string[];       // one or more "<group>/<server>"
  run: string;             // check runbook id
  when?: JobTrigger;
  then?: string;           // remediation runbook id
  notify?: JobNotify;
  env?: Record<string, string>;
  params?: Record<string, string>;   // literal values for the runbook's declared params
  nextRunAt: string | null;
  state: JobRunState;
};

// ── Live dashboard metrics ──────────────────────────────────────
// Mirror of api/src/metrics/metrics.types.ts.
export type DiskSample = { mount: string; used: number; total: number }; // GiB
export type MetricSample = {
  ts: number;                       // unix seconds
  cpu: number;                      // %
  ncpu: number;
  load: [number, number, number];
  mem: { used: number; total: number }; // MiB
  temp: number | null;              // hottest °C, null if no sensors
  disk: DiskSample[];
};
export type NodeStatus = 'connecting' | 'live' | 'down';
export type NodeSnapshot = {
  id: string;
  name: string;
  group: string;
  host: string;
  status: NodeStatus;
  lastError?: string;
  samples: MetricSample[];
};
export type Thresholds = { cpu: number; mem: number; disk: number; temp: number };
export type DashboardMeta = { interval: number; retentionSec: number; thresholds: Thresholds };
export type MetricsSnapshot = { meta: DashboardMeta; nodes: NodeSnapshot[] };
export type MetricsEvent =
  | { type: 'snapshot'; snapshot: MetricsSnapshot }
  | { type: 'sample'; id: string; sample: MetricSample }
  | { type: 'status'; id: string; status: NodeStatus; lastError?: string };

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

export async function fetchMetrics(): Promise<MetricsSnapshot> {
  const r = await apiGet('/api/metrics', 'failed to load metrics');
  return r.json();
}

// ── File browser ────────────────────────────────────────────────
// Mirror of api/src/files/files.types.ts.
export type FileKind = 'dir' | 'file' | 'other';
export type FileEntry = {
  name: string;
  path: string;
  type: FileKind;
  size: number;     // bytes — recursive total for dirs, own size for files
  mtime: number;    // unix seconds
};
// Streamed over /ws/files/list (mirror of api/src/files/files.types.ts).
export type FilesEvent =
  | { type: 'meta'; path: string; parent: string | null }
  | { type: 'entry'; entry: FileEntry }
  | { type: 'size'; path: string; size: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

// Delete a file/dir over SSH. Returns {ok,error?} for the success and guard/
// failure cases alike so the caller can surface the actual reason.
export async function deleteFile(server: string, path: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/files/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server, path }),
  });
  if (r.status === 401) {
    window.location.href = '/api/auth/login';
    return new Promise(() => {});
  }
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
