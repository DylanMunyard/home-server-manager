// Shapes for the dashboard k3s panel. Data comes from the k8s API over an SSH
// tunnel (k8s.client.ts) and is parsed/aggregated by k8s.parse.ts; the WS route
// streams progressive events while the panel is open.

// A top-level workload (pods aggregated by their controller owner).
export type K8sWorkload = {
  kind: string;          // Deployment | StatefulSet | DaemonSet | Job | CronJob | Pod | <literal owner kind>
  name: string;
  namespace: string;
  pods: number;          // active pods (phase not Succeeded/Failed)
  ready: number;         // Running pods with every container ready
  restarts: number;      // sum of restartCount across ALL member pods
  cpuM: number | null;   // millicores from the metrics API; null = no metrics-server
  memMi: number | null;  // MiB from the metrics API
};

export type K8sPod = {
  name: string;
  namespace: string;
  phase: string;         // Running | Pending | Succeeded | Failed | Unknown
  ready: number;         // ready containers
  total: number;         // spec containers
  restarts: number;
  ageSec: number;        // now - creationTimestamp
  cpuM: number | null;
  memMi: number | null;
};

export type K8sSnapshot = {
  fetchedAt: number;     // unix ms (server clock)
  durationMs: number;    // elapsed for this fetch cycle
  alloc: { cpuM: number; memMi: number } | null;  // summed node allocatable — bar denominator
  metricsAvailable: boolean;                       // metrics API returned usage
  workloads: K8sWorkload[];
  pods: K8sPod[];        // all namespaces — the UI filters client-side
};

// Streamed over /ws/k8s/workloads. Within each fetch cycle the route emits
// `alloc`/`structure` as those API calls land (fast first paint), then the
// authoritative `snapshot` once metrics arrive; the cycle repeats every ~20s
// on the same SSH session. `structure` only matters before the first full
// snapshot — the client ignores later ones (usage would flicker to null).
export type K8sStreamEvent =
  | { type: 'alloc'; alloc: K8sSnapshot['alloc'] }
  | { type: 'structure'; workloads: K8sWorkload[]; pods: K8sPod[] }
  | { type: 'snapshot'; snapshot: K8sSnapshot }
  | { type: 'error'; message: string };
