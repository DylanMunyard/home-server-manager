import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { paths } from '../config.js';
import { loadAll } from '../servers/servers.loader.js';
import { loadRunbooks } from '../runbooks/runbooks.loader.js';
import type { InspectAction, Thresholds } from './metrics.types.js';

const FILE = resolve(paths.configRoot, 'dashboard.yaml');

const DEFAULT_THRESHOLDS: Thresholds = { cpu: 90, mem: 90, disk: 85, temp: 80 };
const DEFAULTS = {
  interval: 5,
  mounts: 'auto',
  retentionSec: 2 * 60 * 60,
  thresholds: DEFAULT_THRESHOLDS,
};

// A du-monitored directory on one node (dashboard `paths:`).
export type WatchedPath = { label: string; path: string };

// One watched node, resolved against the real server list.
export type DashboardNode = {
  id: string; name: string; group: string; host: string;
  paths: WatchedPath[];        // du-sampled dirs (METRICS_PATHS prelude)
  inspect: InspectAction[];    // drill-down runbooks for the detail view
  panels: string[];            // rich detail-view panels (e.g. 'k3s')
};

export type DashboardConfig = {
  interval: number;       // seconds between samples
  mounts: string;         // METRICS_MOUNTS value: 'auto' or a space-joined list
  retentionSec: number;   // ring-buffer window
  thresholds: Thresholds;
  nodes: DashboardNode[];  // resolved set of servers to watch
};

type RawDashboard = {
  interval?: number;
  mounts?: 'auto' | string[];
  retention?: string | number;
  thresholds?: Partial<Thresholds>;
  nodes?: 'all' | string[];
  paths?: Record<string, Record<string, string>>;  // node id → label → abs path
  inspect?: Record<string, string[]>;              // 'default' + node-id keys → runbook ids
  panels?: Record<string, string[]>;               // node id → panel ids
};

// Panel ids the UI knows how to render — anything else is a config typo.
const KNOWN_PANELS = new Set(['k3s']);

// Labels travel raw inside the probe's `label=path` prelude lines and its
// printf-built JSON — this charset check is the only sanitisation, keep it.
const PATH_LABEL = /^[A-Za-z0-9._-]+$/;

function resolvePaths(id: string, raw: Record<string, string> | undefined): WatchedPath[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: WatchedPath[] = [];
  for (const [label, p] of Object.entries(raw)) {
    if (!PATH_LABEL.test(label)) {
      console.warn(`[dashboard] ${id}: path label '${label}' invalid (allowed: A-Za-z0-9._-) — skipping`);
      continue;
    }
    const path = String(p);
    if (!path.startsWith('/') || /[\n"]/.test(path)) {
      console.warn(`[dashboard] ${id}: path for '${label}' must be absolute with no newline/quote — skipping`);
      continue;
    }
    out.push({ label, path });
  }
  return out;
}

// "2h" / "90m" / "30s" / 3600 → seconds. Falls back to the default on garbage.
function parseRetention(v: string | number | undefined): number {
  if (typeof v === 'number' && v > 0) return v;
  if (typeof v === 'string') {
    const m = /^(\d+)\s*([smh]?)$/.exec(v.trim());
    if (m) {
      const n = Number(m[1]);
      const mult = m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1;
      if (n > 0) return n * mult;
    }
  }
  return DEFAULTS.retentionSec;
}

/**
 * Load config/dashboard.yaml. Lenient like the jobs loader: a missing or
 * malformed file logs and falls back to defaults rather than throwing — the
 * dashboard is auxiliary and must never take down the API. Node ids that don't
 * resolve to a real server are dropped (with a warning).
 */
export async function loadDashboardConfig(): Promise<DashboardConfig> {
  const { groups, servers } = await loadAll();
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
  const allNodes: DashboardNode[] = servers.map((s) => ({
    id: s.id, name: s.name, group: groupName(s.groupId), host: s.host, paths: [], inspect: [], panels: [],
  }));

  let raw: RawDashboard = {};
  try {
    raw = (YAML.parse(await readFile(FILE, 'utf8')) ?? {}) as RawDashboard;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[dashboard] config unreadable, using defaults: ${(err as Error).message}`);
    }
    // No file is fine — watch everything with defaults.
  }

  let nodes = allNodes;
  if (Array.isArray(raw.nodes)) {
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    nodes = [];
    for (const id of raw.nodes) {
      const n = byId.get(id);
      if (n) nodes.push(n);
      else console.warn(`[dashboard] unknown node '${id}' — skipping`);
    }
  }

  // Per-node du-monitored paths — keys must be watched node ids (warn + drop).
  const watched = new Map(nodes.map((n) => [n.id, n]));
  for (const [id, entries] of Object.entries(raw.paths ?? {})) {
    const n = watched.get(id);
    if (!n) {
      console.warn(`[dashboard] paths for unknown node '${id}' — skipping`);
      continue;
    }
    n.paths = resolvePaths(id, entries);
  }

  // Rich detail-view panels — node id → panel ids, validated against the set
  // the UI can render (warn + drop, same lenient stance as `paths:` above).
  for (const [id, ids] of Object.entries(raw.panels ?? {})) {
    const n = watched.get(id);
    if (!n) {
      console.warn(`[dashboard] panels for unknown node '${id}' — skipping`);
      continue;
    }
    n.panels = (Array.isArray(ids) ? ids : []).map(String).filter((p) => {
      if (KNOWN_PANELS.has(p)) return true;
      console.warn(`[dashboard] unknown panel '${p}' (${id}) — skipping`);
      return false;
    });
  }

  // Drill-down runbooks — a node's list replaces `default`. Unknown runbook
  // ids are dropped with a warning (same lenient stance as `nodes:` above).
  if (raw.inspect && typeof raw.inspect === 'object') {
    const runbooks = new Map((await loadRunbooks()).map((r) => [r.id, r]));
    const resolved = new Map<string, InspectAction[]>();
    for (const [key, ids] of Object.entries(raw.inspect)) {
      if (key !== 'default' && !watched.has(key)) {
        console.warn(`[dashboard] inspect for unknown node '${key}' — skipping`);
        continue;
      }
      resolved.set(key, (Array.isArray(ids) ? ids : []).flatMap((id) => {
        const r = runbooks.get(String(id));
        if (!r) {
          console.warn(`[dashboard] inspect runbook '${id}' (${key}) not found — skipping`);
          return [];
        }
        return [{ id: r.id, description: r.description }];
      }));
    }
    for (const n of nodes) {
      n.inspect = resolved.get(n.id) ?? resolved.get('default') ?? [];
    }
  }

  return {
    interval: typeof raw.interval === 'number' && raw.interval > 0 ? raw.interval : DEFAULTS.interval,
    // 'auto' (or omitted) → probe discovers every real filesystem; an explicit
    // list is space-joined into METRICS_MOUNTS to restrict to those mounts.
    mounts: Array.isArray(raw.mounts) && raw.mounts.length > 0 ? raw.mounts.map(String).join(' ') : DEFAULTS.mounts,
    retentionSec: parseRetention(raw.retention),
    thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) },
    nodes,
  };
}
