import type { K8sPod, K8sSnapshot, K8sWorkload } from './k8s.types.js';

// Pure parsing/aggregation over k8s API JSON — no SSH imports, so the whole
// layer is checkable locally with canned fixtures.

// Minimal slices of the k8s API objects we actually read.
export type PodItem = {
  metadata: {
    name: string;
    namespace: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    ownerReferences?: { kind: string; name: string; controller?: boolean }[];
  };
  spec?: { containers?: unknown[] };
  status?: {
    phase?: string;
    containerStatuses?: { ready?: boolean; restartCount?: number }[];
  };
};

export type PodList = { items?: PodItem[] };
export type NodeList = { items?: { status?: { allocatable?: { cpu?: string; memory?: string } } }[] };
// /apis/metrics.k8s.io/v1beta1/pods response shape.
export type MetricsPodList = {
  items?: {
    metadata: { name: string; namespace: string };
    containers?: { name?: string; usage: { cpu?: string; memory?: string } }[];
  }[];
};

const QTY_MULT: Record<string, number> = {
  '': 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
};

/**
 * Kubernetes resource.Quantity → base units (cores for CPU, bytes for memory).
 * Unknown suffix / malformed → NaN; callers skip those rows.
 */
export function parseQuantity(s: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)([a-zA-Z]*)$/.exec(s.trim());
  if (!m) return NaN;
  const mult = QTY_MULT[m[2]];
  return mult === undefined ? NaN : Number(m[1]) * mult;
}

const toCpuM = (q: string) => Math.round(parseQuantity(q) * 1000);
const toMemMi = (q: string) => parseQuantity(q) / 2 ** 20;

/** Metrics API response → "<ns>/<pod>" → usage (containers summed per pod). */
export function parseMetricsApi(doc: MetricsPodList): Map<string, { cpuM: number; memMi: number }> {
  const out = new Map<string, { cpuM: number; memMi: number }>();
  for (const item of doc.items ?? []) {
    let cpuM = 0;
    let memMi = 0;
    for (const c of item.containers ?? []) {
      if (c.usage.cpu) cpuM += toCpuM(c.usage.cpu);
      if (c.usage.memory) memMi += toMemMi(c.usage.memory);
    }
    if (!Number.isNaN(cpuM) && !Number.isNaN(memMi)) {
      out.set(`${item.metadata.namespace}/${item.metadata.name}`, { cpuM, memMi: Math.round(memMi * 10) / 10 });
    }
  }
  return out;
}

/** Sum .status.allocatable across nodes — the bar denominator ("% of node"). */
export function parseAlloc(nodes: NodeList): { cpuM: number; memMi: number } | null {
  let cpuM = 0;
  let memMi = 0;
  for (const n of nodes.items ?? []) {
    const a = n.status?.allocatable;
    if (!a?.cpu || !a?.memory) continue;
    const c = toCpuM(a.cpu);
    const m = toMemMi(a.memory);
    if (Number.isNaN(c) || Number.isNaN(m)) continue;
    cpuM += c;
    memMi += m;
  }
  return cpuM > 0 && memMi > 0 ? { cpuM, memMi: Math.round(memMi) } : null;
}

/**
 * Resolve a pod's top-level workload (the aggregation key). Heuristics, kept
 * deliberately cheap (no extra API calls for RS/Job parents):
 * - ReplicaSet → Deployment, name = RS name minus the pod-template-hash suffix.
 *   A bare ReplicaSet (no Deployment parent) gets mislabelled Deployment — accepted.
 * - Job named `<base>-<epoch>` (8+ digits) → CronJob `<base>` — CronJob children
 *   are named from the schedule epoch; a hand-made job with a numeric suffix
 *   would be mislabelled — accepted.
 * - Anything else passes through with its literal owner kind.
 */
export function ownerOf(pod: PodItem): { kind: string; name: string } {
  const refs = pod.metadata.ownerReferences ?? [];
  const ref = refs.find((r) => r.controller) ?? refs[0];
  if (!ref) return { kind: 'Pod', name: pod.metadata.name };

  if (ref.kind === 'ReplicaSet') {
    const hash = pod.metadata.labels?.['pod-template-hash'];
    const name = hash && ref.name.endsWith(`-${hash}`)
      ? ref.name.slice(0, -(hash.length + 1))
      : ref.name.replace(/-[a-z0-9]+$/, '');
    return { kind: 'Deployment', name };
  }
  if (ref.kind === 'Job') {
    const m = /^(.+)-\d{8,}$/.exec(ref.name);
    if (m) return { kind: 'CronJob', name: m[1] };
    return { kind: 'Job', name: ref.name };
  }
  return { kind: ref.kind, name: ref.name };
}

const DONE_PHASES = new Set(['Succeeded', 'Failed']);

export type PodsStructure = {
  workloads: K8sWorkload[];   // usage null, sorted by name (nothing to rank on yet)
  pods: K8sPod[];             // usage null
  // "<ns>/<pod>" → its workload object — lets the metrics overlay sum exactly
  // by owner instead of guessing from name prefixes.
  ownerIndex: Map<string, K8sWorkload>;
};

/** Pods doc → workloads + pods, structure only (no usage). */
export function parsePodsStructure(doc: PodList): PodsStructure {
  const now = Date.now();
  const pods: K8sPod[] = [];
  const workloads: K8sWorkload[] = [];
  const byKey = new Map<string, K8sWorkload>();
  const ownerIndex = new Map<string, K8sWorkload>();

  for (const item of doc.items ?? []) {
    const ns = item.metadata.namespace;
    const name = item.metadata.name;
    const statuses = item.status?.containerStatuses ?? [];
    const phase = item.status?.phase ?? 'Unknown';
    const ready = statuses.filter((c) => c.ready).length;
    const total = (item.spec?.containers ?? []).length;
    const restarts = statuses.reduce((s, c) => s + (c.restartCount ?? 0), 0);
    const created = item.metadata.creationTimestamp ? Date.parse(item.metadata.creationTimestamp) : NaN;

    pods.push({
      name, namespace: ns, phase, ready, total, restarts,
      ageSec: Number.isNaN(created) ? 0 : Math.max(0, Math.floor((now - created) / 1000)),
      cpuM: null, memMi: null,
    });

    const owner = ownerOf(item);
    const key = `${ns}|${owner.kind}|${owner.name}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        kind: owner.kind, name: owner.name, namespace: ns,
        pods: 0, ready: 0, restarts: 0, cpuM: null, memMi: null,
      };
      byKey.set(key, g);
      workloads.push(g);
    }
    if (!DONE_PHASES.has(phase)) g.pods += 1;
    if (phase === 'Running' && total > 0 && ready === total) g.ready += 1;
    g.restarts += restarts;
    ownerIndex.set(`${ns}/${name}`, g);
  }

  workloads.sort((a, b) => a.name.localeCompare(b.name));
  return { workloads, pods, ownerIndex };
}

/**
 * Full snapshot: structure + metrics overlaid exactly via the owner index.
 * Pods missing from the metrics API count as 0 (it floors at 0m anyway);
 * null usage is reserved for "no metrics-server at all".
 */
export function buildSnapshotFromApi(
  nodesDoc: NodeList,
  podsDoc: PodList,
  metricsDoc: MetricsPodList | null,
  durationMs: number,
): K8sSnapshot {
  const { workloads, pods, ownerIndex } = parsePodsStructure(podsDoc);
  const top = metricsDoc ? parseMetricsApi(metricsDoc) : new Map<string, { cpuM: number; memMi: number }>();
  const metricsAvailable = top.size > 0;

  if (metricsAvailable) {
    for (const w of workloads) { w.cpuM = 0; w.memMi = 0; }
    for (const p of pods) {
      const usage = top.get(`${p.namespace}/${p.name}`);
      if (!usage) continue;
      p.cpuM = usage.cpuM;
      p.memMi = usage.memMi;
      const w = ownerIndex.get(`${p.namespace}/${p.name}`);
      if (!w) continue;
      w.cpuM = (w.cpuM ?? 0) + usage.cpuM;
      w.memMi = Math.round(((w.memMi ?? 0) + usage.memMi) * 10) / 10;
    }
    workloads.sort((a, b) => (b.cpuM ?? -1) - (a.cpuM ?? -1) || a.name.localeCompare(b.name));
  }

  return {
    fetchedAt: Date.now(),
    durationMs,
    alloc: parseAlloc(nodesDoc),
    metricsAvailable,
    workloads,
    pods,
  };
}
