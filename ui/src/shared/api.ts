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
