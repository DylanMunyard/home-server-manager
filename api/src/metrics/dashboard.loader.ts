import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { paths } from '../config.js';
import { loadAll } from '../servers/servers.loader.js';
import type { Thresholds } from './metrics.types.js';

const FILE = resolve(paths.configRoot, 'dashboard.yaml');

const DEFAULT_THRESHOLDS: Thresholds = { cpu: 90, mem: 90, disk: 85, temp: 80 };
const DEFAULTS = {
  interval: 5,
  mounts: 'auto',
  retentionSec: 2 * 60 * 60,
  thresholds: DEFAULT_THRESHOLDS,
};

// One watched node, resolved against the real server list.
export type DashboardNode = { id: string; name: string; group: string; host: string };

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
};

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
    id: s.id, name: s.name, group: groupName(s.groupId), host: s.host,
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
