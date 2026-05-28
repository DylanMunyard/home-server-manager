import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';
import { paths, expandEnv } from '../config.js';
import type { GroupSummary, ServerAuth, ServerConfig, ServerDetail, ServerSummary } from './servers.types.js';

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

type RawServer = {
  id?: string;
  name?: string;
  host?: string;
  port?: number;
  user?: string;
  key?: string;
  password?: string;
  passphrase?: string;
};

// Mirrors ServerConfig but retains the raw key string so the UI can show
// what's in YAML alongside the resolved path.
type ServerInternal = ServerConfig & { rawKey?: string };

type RawGroup = {
  name?: string;
  description?: string;
  defaults?: RawServer;
  servers?: RawServer[];
};

function resolveAuth(merged: RawServer, ctx: string): ServerAuth {
  // Server-level auth wins entirely over defaults. If server specifies neither,
  // defaults supply both. If server specifies one, the other from defaults is ignored.
  // ${VAR} interpolation already happened in expandAllEnvRefs() during file load.
  if (merged.password) return { type: 'password', password: merged.password };
  if (merged.key) {
    return {
      type: 'key',
      privateKey: expandHome(merged.key),
      passphrase: merged.passphrase,
    };
  }
  throw new Error(`${ctx}: missing auth — need either 'key' or 'password' (server-level or in defaults)`);
}

/**
 * Recursively walk a parsed YAML structure and replace ${VAR} refs in any
 * string leaf via expandEnv. Lets the user use ${VAR} in any field (host,
 * user, etc.), not just the auth ones. Throws on unset vars (via expandEnv).
 */
function expandAllEnvRefs<T>(value: T): T {
  if (typeof value === 'string') return expandEnv(value) as unknown as T;
  if (Array.isArray(value)) return value.map(expandAllEnvRefs) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandAllEnvRefs(v);
    return out as T;
  }
  return value;
}

function mergeWithDefaults(defaults: RawServer | undefined, server: RawServer): RawServer {
  const d = defaults ?? {};
  const hasOwnAuth = !!(server.key || server.password);
  const inheritedAuth: RawServer = hasOwnAuth
    ? {}
    : { key: d.key, password: d.password, passphrase: d.passphrase };
  return {
    ...d,
    ...inheritedAuth,
    ...server,
  };
}

function buildServer(groupId: string, raw: RawServer, defaults: RawServer | undefined): ServerInternal {
  const serverId = raw.id;
  if (!serverId) throw new Error(`${groupId}: server entry missing 'id'`);
  const ctx = `${groupId}/${serverId}`;

  const merged = mergeWithDefaults(defaults, raw);
  if (!merged.host) throw new Error(`${ctx}: missing 'host'`);
  if (!merged.user) throw new Error(`${ctx}: missing 'user'`);

  return {
    id: ctx,
    groupId,
    serverId,
    name: raw.name ?? serverId,
    host: merged.host,
    port: Number(merged.port ?? 22),
    user: merged.user,
    auth: resolveAuth(merged, ctx),
    rawKey: merged.key,
  };
}

async function loadGroupFile(filename: string): Promise<{ group: GroupMeta; servers: ServerInternal[] }> {
  const groupId = basename(filename, extname(filename));
  const text = await readFile(join(paths.servers, filename), 'utf8');
  const parsed = (YAML.parse(text) ?? {}) as RawGroup;
  const raw = expandAllEnvRefs(parsed);
  const list = raw.servers ?? [];
  const servers = list.map((s) => buildServer(groupId, s, raw.defaults));
  return {
    group: { id: groupId, name: raw.name ?? groupId, description: raw.description },
    servers,
  };
}

type GroupMeta = { id: string; name: string; description?: string };

export async function loadAll(): Promise<{ groups: GroupMeta[]; servers: ServerInternal[] }> {
  let entries: string[];
  try {
    entries = await readdir(paths.servers);
  } catch {
    return { groups: [], servers: [] };
  }
  const files = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();

  const groups: GroupMeta[] = [];
  const servers: ServerInternal[] = [];
  for (const f of files) {
    const { group, servers: gs } = await loadGroupFile(f);
    groups.push(group);
    servers.push(...gs);
  }
  return { groups, servers };
}

export async function loadServer(id: string): Promise<ServerConfig | null> {
  const { servers } = await loadAll();
  return servers.find((s) => s.id === id) ?? null;
}

export async function loadServerDetail(id: string): Promise<ServerDetail | null> {
  const { groups, servers } = await loadAll();
  const s = servers.find((srv) => srv.id === id);
  if (!s) return null;
  const g = groups.find((grp) => grp.id === s.groupId)!;
  const summary = toServerSummary(s);
  const passphraseSet = s.auth.type === 'key' && !!s.auth.passphrase;
  const passwordSet   = s.auth.type === 'password' && !!s.auth.password;
  return {
    ...summary,
    groupName: g.name,
    groupDescription: g.description,
    keyPath:    s.auth.type === 'key' ? s.auth.privateKey : undefined,
    rawKeyPath: s.auth.type === 'key' ? s.rawKey : undefined,
    passphraseSet,
    passwordSet,
  };
}

export function toServerSummary(s: ServerConfig): ServerSummary {
  const { id, groupId, serverId, name, host, port, user, auth } = s;
  return { id, groupId, serverId, name, host, port, user, authType: auth.type };
}

export async function loadGroupSummaries(): Promise<GroupSummary[]> {
  const { groups, servers } = await loadAll();
  return groups.map((g) => ({
    ...g,
    servers: servers.filter((s) => s.groupId === g.id).map(toServerSummary),
  }));
}
