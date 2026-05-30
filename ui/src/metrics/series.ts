import type { MetricSample, NodeSnapshot } from '../shared/api.ts';
import type { Point } from './MetricChart.tsx';

// Turn a node's raw samples into the per-metric Point series the charts plot.
// All x values are unix ms (the probe emits seconds). Kept dumb and pure so
// both the compact tile and the expanded detail share exactly one derivation.

export const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

export const cpuSeries = (s: MetricSample[]): Point[] => s.map((d) => ({ x: d.ts * 1000, y: d.cpu }));

export const memSeries = (s: MetricSample[]): Point[] =>
  s.map((d) => ({ x: d.ts * 1000, y: pct(d.mem.used, d.mem.total) }));

// Drop null-temp points (sensor-less hosts) so the line doesn't dive to zero.
export const tempSeries = (s: MetricSample[]): Point[] =>
  s.filter((d) => d.temp !== null).map((d) => ({ x: d.ts * 1000, y: d.temp as number }));

export const diskSeries = (s: MetricSample[], mount: string): Point[] =>
  s
    .map((d) => {
      const disk = d.disk.find((x) => x.mount === mount);
      return disk ? { x: d.ts * 1000, y: pct(disk.used, disk.total) } : null;
    })
    .filter((p): p is Point => p !== null);

export const latest = (n: NodeSnapshot): MetricSample | null =>
  n.samples.length ? n.samples[n.samples.length - 1] : null;

// Mounts present in the most recent sample (drives the disk rows/charts).
export const mountsOf = (n: NodeSnapshot): string[] => latest(n)?.disk.map((d) => d.mount) ?? [];
