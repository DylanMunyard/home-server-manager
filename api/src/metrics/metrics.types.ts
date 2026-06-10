// Shapes shared across the metrics feature. A `MetricSample` is exactly what
// the metrics-stream.sh probe emits as one NDJSON line; the rest wrap it for
// the collector's in-memory buffers and the routes that surface them.

export type DiskSample = { mount: string; used: number; total: number }; // GiB

// A du-sampled directory (config/dashboard.yaml `paths:`). Plain dirs, not
// mounts, so there's no capacity — `used` GiB only; null = missing/unreadable
// (kept visible in the UI, same convention as temp:null).
export type PathSample = { label: string; path: string; used: number | null };

export type MetricSample = {
  ts: number;                       // unix seconds (probe's clock)
  cpu: number;                      // % utilisation over the interval
  ncpu: number;                     // core count (for load normalisation)
  load: [number, number, number];  // 1/5/15-min load average
  mem: { used: number; total: number }; // MiB
  temp: number | null;              // hottest °C, null on sensor-less hosts
  disk: DiskSample[];
  paths: PathSample[];              // [] on nodes with no configured paths
};

// A drill-down runbook offered in a node's detail view (dashboard `inspect:`).
export type InspectAction = { id: string; description: string };

export type NodeStatus = 'connecting' | 'live' | 'down';

// One watched node's live view: identity + status + its ring buffer of samples.
export type NodeSnapshot = {
  id: string;        // "<group>/<server>"
  name: string;      // display label
  group: string;     // group display name (for grouping tiles)
  host: string;
  status: NodeStatus;
  lastError?: string;
  samples: MetricSample[];
  inspect: InspectAction[];  // static config — carried by the snapshot frame only
};

export type Thresholds = { cpu: number; mem: number; disk: number; temp: number };

// The slice of dashboard config the UI needs to render (thresholds + cadence).
export type DashboardMeta = { interval: number; retentionSec: number; thresholds: Thresholds };

export type MetricsSnapshot = { meta: DashboardMeta; nodes: NodeSnapshot[] };

// Live events pushed over /ws/metrics after the initial snapshot frame.
export type MetricsEvent =
  | { type: 'snapshot'; snapshot: MetricsSnapshot }
  | { type: 'sample'; id: string; sample: MetricSample }
  | { type: 'status'; id: string; status: NodeStatus; lastError?: string };
