import { loadAll } from '../servers/servers.loader.js';
import { loadRunbook } from '../runbooks/runbooks.loader.js';
import { exportPrelude } from '../ssh/prelude.js';
import type { ServerConfig } from '../servers/servers.types.js';
import { streamMetrics, type MetricsHandle } from './metrics.session.js';
import { loadDashboardConfig, type DashboardConfig, type DashboardNode } from './dashboard.loader.js';
import type {
  MetricSample, MetricsEvent, MetricsSnapshot, NodeSnapshot, NodeStatus,
} from './metrics.types.js';

const PROBE_RUNBOOK = 'metrics-stream';
const RECONNECT_MS = 5_000;

// In-memory only — no persistence, by design (clone-and-go). The collector is
// always-on: it starts at boot and keeps one streamMetrics connection per
// watched node, pushing samples into a per-node ring buffer capped by the
// retention window. Browsers get a snapshot of these buffers on connect, then
// live events via subscribe(). A dropped stream reconnects after a backoff.

type Node = {
  meta: DashboardNode;
  server: ServerConfig;
  status: NodeStatus;
  lastError?: string;
  samples: MetricSample[];
  handle: MetricsHandle | null;
};

let config: DashboardConfig | null = null;
let probeScript: string | null = null;
let maxSamples = 0;
let running = false;
const nodes = new Map<string, Node>();
const subscribers = new Set<(e: MetricsEvent) => void>();

function emit(e: MetricsEvent) {
  for (const cb of subscribers) {
    try { cb(e); } catch { /* a slow/closed subscriber must not break others */ }
  }
}

function setStatus(node: Node, status: NodeStatus, lastError?: string) {
  node.status = status;
  node.lastError = lastError;
  emit({ type: 'status', id: node.meta.id, status, lastError });
}

function connect(node: Node) {
  if (!running || !probeScript) return;
  setStatus(node, 'connecting');
  node.handle = streamMetrics(node.server, probeScript, {
    onSample: (sample) => {
      if (node.status !== 'live') setStatus(node, 'live');
      node.samples.push(sample);
      if (node.samples.length > maxSamples) node.samples.splice(0, node.samples.length - maxSamples);
      emit({ type: 'sample', id: node.meta.id, sample });
    },
    onError: (message) => { node.lastError = message; },
  });
  // When the stream ends (host dropped it, auth failed, network blip), mark the
  // node down and reconnect after a backoff — unless we're shutting down.
  node.handle.done.then(() => {
    node.handle = null;
    if (!running) return;
    setStatus(node, 'down', node.lastError);
    setTimeout(() => connect(node), RECONNECT_MS);
  });
}

export function getSnapshot(): MetricsSnapshot {
  const meta = config
    ? { interval: config.interval, retentionSec: config.retentionSec, thresholds: config.thresholds }
    : { interval: 5, retentionSec: 7200, thresholds: { cpu: 90, mem: 90, disk: 85, temp: 80 } };
  const nodeSnaps: NodeSnapshot[] = [...nodes.values()].map((n) => ({
    id: n.meta.id,
    name: n.meta.name,
    group: n.meta.group,
    host: n.meta.host,
    status: n.status,
    lastError: n.lastError,
    samples: n.samples,
  }));
  return { meta, nodes: nodeSnaps };
}

export function subscribe(cb: (e: MetricsEvent) => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

/**
 * Start the always-on collector. Isolated from the fatal listen path in
 * server.ts (logs instead of exiting) — like the job scheduler, the dashboard
 * is auxiliary and must never take down the API. A missing probe runbook or
 * zero configured nodes is a no-op, not an error.
 */
export async function startCollector(): Promise<void> {
  if (running) return;
  config = await loadDashboardConfig();
  maxSamples = Math.ceil(config.retentionSec / config.interval) + 2;

  const probe = await loadRunbook(PROBE_RUNBOOK);
  if (!probe) {
    console.warn(`[dashboard] runbook '${PROBE_RUNBOOK}' not found — collector idle`);
    return;
  }
  probeScript = exportPrelude({
    METRICS_INTERVAL: String(config.interval),
    METRICS_MOUNTS: config.mounts.join(' '),
  }) + probe.contents;

  const { servers } = await loadAll();
  const byId = new Map(servers.map((s) => [s.id, s]));

  running = true;
  for (const meta of config.nodes) {
    const server = byId.get(meta.id);
    if (!server) continue; // loader already resolved these, but stay defensive
    const node: Node = { meta, server, status: 'connecting', samples: [], handle: null };
    nodes.set(meta.id, node);
    connect(node);
  }
  console.log(`[dashboard] collector watching ${nodes.size} node(s) @ ${config.interval}s`);
}

export function stopCollector(): void {
  running = false;
  for (const n of nodes.values()) n.handle?.cancel();
  nodes.clear();
}
