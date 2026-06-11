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
  // If set, this runbook is hidden by default unless one of these node ids is selected.
  // Supports glob-style matching (e.g. "bfstats-*").
  nodes?: string[];
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

// ── AI investigation ────────────────────────────────────────────
// Mirror of api/src/ai/ai.investigate.ts — an agentic read-only probe loop that
// runs when an `investigate: true` job fails.
export type InvestigationStatus = 'running' | 'completed' | 'error';

// Streamed over /ws/ai/investigate (and buffered in GET /api/ai/investigations/:id).
export type InvestigationEvent =
  | { type: 'start'; jobName: string; target: string; reason: string }
  | { type: 'note'; text: string }                                  // model chat / reasoning
  | { type: 'probe'; n: number; purpose: string; bash: string }     // a tool call
  | { type: 'output'; n: number; exitCode: number | null; stdout: string; stderr: string; rejected?: string }
  | { type: 'summary'; text: string }
  | { type: 'done'; status: 'completed' | 'error'; error?: string };

export type Investigation = {
  id: string;
  jobId: string;
  target: string;
  status: InvestigationStatus;
  startedAt: string;
  summary?: string;
  error?: string;
  events: InvestigationEvent[];
};

// Mirrors the API's per-target outcome within a JobRunState.
export type TargetRunState = {
  lastCheck?: RunResult;
  lastTriggered?: boolean;
  // Per-runbook results of the `then` chain, in run order, when it ran.
  lastActions?: { runbook: string; result: RunResult }[];
  lastError?: string;
  // Latest AI investigation for this target (overlaid live by GET /api/jobs);
  // the full transcript streams over /ws/ai/investigate?id=…
  investigation?: { id: string; status: InvestigationStatus; summary?: string };
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
  then?: string[];         // runbook ids run in order when `when` matches
  notify?: JobNotify;
  env?: Record<string, string>;
  params?: Record<string, string>;   // literal values for the runbook's declared params
  investigate?: boolean;              // opt-in AI post-failure investigation
  nextRunAt: string | null;
  state: JobRunState;
};

// ── Live dashboard metrics ──────────────────────────────────────
// Mirror of api/src/metrics/metrics.types.ts. The newer fields (`paths`,
// `inspect`) stay optional here: a tab older/newer than the API can hold
// mixed-shape samples, so the UI treats them as possibly absent.
export type DiskSample = { mount: string; used: number; total: number }; // GiB
// du-sampled dir — no capacity (plain dir, not a mount): GiB used only,
// null = missing/unreadable.
export type PathSample = { label: string; path: string; used: number | null };
export type MetricSample = {
  ts: number;                       // unix seconds
  cpu: number;                      // %
  ncpu: number;
  load: [number, number, number];
  mem: { used: number; total: number }; // MiB
  temp: number | null;              // hottest °C, null if no sensors
  disk: DiskSample[];
  paths?: PathSample[];
};
export type NodeStatus = 'connecting' | 'live' | 'down';
// A drill-down runbook offered in the node detail (dashboard `inspect:`).
export type InspectAction = { id: string; description: string };
export type NodeSnapshot = {
  id: string;
  name: string;
  group: string;
  host: string;
  status: NodeStatus;
  lastError?: string;
  samples: MetricSample[];
  inspect?: InspectAction[];
  panels?: string[];
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
async function apiPost(path: string, errorMsg: string, body?: unknown): Promise<Response> {
  const r = await fetch(path, {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
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

// Buffered transcript of one investigation (the /ws live stream is the realtime
// counterpart, used by useInvestigation).
export async function fetchInvestigation(id: string): Promise<Investigation> {
  const r = await apiGet(`/api/ai/investigations/${encodeURIComponent(id)}`, 'failed to load investigation');
  return r.json();
}

export type AiStatus = { enabled: boolean; deployment: string | null; apiVersion: string };

export async function fetchAiStatus(): Promise<AiStatus> {
  const r = await apiGet('/api/ai/status', 'failed to load AI status');
  return r.json();
}

// Manually kick off an investigation against a job's last run (test hook for
// iterating on the prompt). Returns {id,target} on success, or {error} for the
// 404/409/503 cases so the caller can surface the reason inline.
export async function investigateJob(
  id: string,
  target?: string,
): Promise<{ id?: string; target?: string; error?: string }> {
  const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/investigate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  if (r.status === 401) {
    window.location.href = '/api/auth/login';
    return new Promise(() => {});
  }
  return r.json();
}

// ── AI chat session ─────────────────────────────────────────────
// Interactive chat: streamed live over /ws/ai/chat. The client owns the history
// (stateless server) and sends `{ history, userMessage }` frames; the server
// streams these events as the tool loop runs, ending each turn with `done` which
// carries the new turns to append (so the next frame replays full history).
export type ConvoMessage =
  | { role: 'user' | 'system'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ChatEvent =
  | { type: 'status'; phase: 'thinking' | 'running'; n?: number; purpose?: string }
  | { type: 'text'; content: string }
  | { type: 'cmd'; n: number; purpose: string; bash: string }
  | { type: 'output'; n: number; exitCode: number | null; stdout: string; stderr: string; rejected?: string }
  | { type: 'done'; ok: boolean; cancelled?: boolean; error?: string; messages: ConvoMessage[] };

// ── k3s panel ───────────────────────────────────────────────────
// Mirror of api/src/k8s/k8s.types.ts — streamed over /ws/k8s/workloads while
// the panel is open (one SSH session per connection; progressive events).
export type K8sWorkload = {
  kind: string;          // Deployment | StatefulSet | DaemonSet | Job | CronJob | Pod | ...
  name: string;
  namespace: string;
  pods: number;          // active pods
  ready: number;         // fully-ready running pods
  restarts: number;
  cpuM: number | null;   // millicores; null = no metrics-server
  memMi: number | null;
};
export type K8sPod = {
  name: string;
  namespace: string;
  phase: string;
  ready: number;
  total: number;
  restarts: number;
  ageSec: number;
  cpuM: number | null;
  memMi: number | null;
};
export type K8sSnapshot = {
  fetchedAt: number;
  durationMs: number;
  alloc: { cpuM: number; memMi: number } | null;  // bar denominator (% of node)
  metricsAvailable: boolean;
  workloads: K8sWorkload[];
  pods: K8sPod[];        // all namespaces — filtered client-side
};

// Streaming events from /ws/k8s/workloads. Within each fetch cycle:
// `alloc`/`structure` land as those API calls resolve (fast first paint),
// then the authoritative `snapshot`; cycles repeat ~20s on the held session.
export type K8sStreamEvent =
  | { type: 'alloc'; alloc: K8sSnapshot['alloc'] }
  | { type: 'structure'; workloads: K8sWorkload[]; pods: K8sPod[] }
  | { type: 'snapshot'; snapshot: K8sSnapshot }
  | { type: 'error'; message: string };

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
// `force` ("Test fire") makes the engine treat the `when` gate as tripped, so
// the `then` chain runs for real and the real alerts fire — the honest way to
// test the alert pipeline on a healthy box.
export async function runJob(id: string, force = false): Promise<Job> {
  const r = await apiPost(`/api/jobs/${encodeURIComponent(id)}/run`, 'failed to run job', force ? { force: true } : undefined);
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
