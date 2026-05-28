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

export async function fetchGroups(): Promise<GroupSummary[]> {
  const r = await fetch('/api/groups');
  if (!r.ok) throw new Error('failed to load groups');
  return r.json();
}

export async function fetchServerDetail(id: string): Promise<ServerDetail> {
  // id is "<group>/<server>"; both segments need to be URL-encoded individually
  // so we preserve the slash as a path separator.
  const [g, s] = id.split('/');
  const r = await fetch(`/api/servers/${encodeURIComponent(g)}/${encodeURIComponent(s)}`);
  if (!r.ok) throw new Error('failed to load server detail');
  return r.json();
}

export async function fetchRunbooks(): Promise<RunbookSummary[]> {
  const r = await fetch('/api/runbooks');
  if (!r.ok) throw new Error('failed to load runbooks');
  return r.json();
}

export async function fetchRunbook(id: string): Promise<Runbook> {
  const r = await fetch(`/api/runbooks/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error('failed to load runbook');
  return r.json();
}
