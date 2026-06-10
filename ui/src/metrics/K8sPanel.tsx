import { useEffect, useMemo, useState } from 'react';
import type { K8sPod, K8sWorkload, Thresholds } from '../shared/api.ts';
import { useK8sWorkloads } from './useK8sWorkloads.ts';

type View = { kind: 'workloads' } | { kind: 'ns'; namespace: string };
type Sort = 'cpu' | 'mem' | 'name';

const KIND_ABBR: Record<string, string> = {
  Deployment: 'deploy', StatefulSet: 'sts', DaemonSet: 'ds',
  CronJob: 'cron', Job: 'job', Pod: 'pod',
};

const fmtCpu = (m: number | null) => (m === null ? '—' : `${m}m`);
const fmtMem = (mi: number | null) =>
  mi === null ? '—' : mi >= 1024 ? `${(mi / 1024).toFixed(1)}Gi` : `${Math.round(mi)}Mi`;
const fmtAge = (sec: number) =>
  sec < 60 ? `${sec}s`
  : sec < 3600 ? `${Math.floor(sec / 60)}m`
  : sec < 86400 ? `${Math.floor(sec / 3600)}h`
  : `${Math.floor(sec / 86400)}d`;
const ago = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

// One metric cell: prominent value with its label, and a thin bar underneath
// scaled against the biggest consumer in the current view (the comparator the
// "what's the hog" question needs). `over` is absolute heat vs the node.
function Metric({ label, value, max, over, pending }: {
  label: string; value: number | null; max: number; over: boolean; pending: boolean;
}) {
  const text = label === 'cpu' ? fmtCpu(value) : fmtMem(value);
  return (
    <span className="k8s-m">
      <span className="k8s-m-h">
        <span className="k8s-m-label">{label}</span>
        <span className="k8s-m-val">{pending && value === null ? '…' : text}</span>
      </span>
      <span className="k8s-m-track">
        {value !== null && max > 0 && (
          <span className="k8s-m-fill" data-over={over} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
        )}
      </span>
    </span>
  );
}

// Rich k3s drill-in (the 'k3s' panel plugin): per-workload cpu/mem streamed
// over /ws/k8s/workloads, with an in-place swap to the pods table for one
// namespace. The namespace view is a pure client-side filter of the same
// snapshot.
export function K8sPanel({ serverId, thresholds }: { serverId: string; thresholds: Thresholds }) {
  const { snapshot, partial, error, live, fetchedAt, refresh } = useK8sWorkloads(serverId);
  const [view, setView] = useState<View>({ kind: 'workloads' });
  const [sort, setSort] = useState<Sort>('cpu');

  // 5s ticker so "updated Xs ago" stays honest between cycles.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(iv);
  }, []);

  const metrics = snapshot?.metricsAvailable ?? false;

  const workloads = useMemo(() => {
    const list = [...(snapshot?.workloads ?? [])];
    const by: Record<Sort, (a: K8sWorkload, b: K8sWorkload) => number> = {
      cpu:  (a, b) => (b.cpuM ?? -1) - (a.cpuM ?? -1),
      mem:  (a, b) => (b.memMi ?? -1) - (a.memMi ?? -1),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    // Without usage numbers there's nothing to rank on but the name.
    return list.sort(metrics ? by[sort] : by.name);
  }, [snapshot, sort, metrics]);

  // Bar comparator: the biggest consumer in the current view.
  const maxWl = useMemo(() => ({
    cpu: Math.max(1, ...workloads.map((w) => w.cpuM ?? 0)),
    mem: Math.max(1, ...workloads.map((w) => w.memMi ?? 0)),
  }), [workloads]);

  const nsPods = useMemo(() => {
    if (view.kind !== 'ns') return [];
    return (snapshot?.pods ?? [])
      .filter((p) => p.namespace === view.namespace)
      .sort((a, b) => (b.cpuM ?? -1) - (a.cpuM ?? -1) || a.name.localeCompare(b.name));
  }, [snapshot, view]);

  const maxPod = useMemo(() => ({
    cpu: Math.max(1, ...nsPods.map((p) => p.cpuM ?? 0)),
    mem: Math.max(1, ...nsPods.map((p) => p.memMi ?? 0)),
  }), [nsPods]);

  // Absolute heat vs the node — red even when it's also the biggest bar.
  const overCpu = (v: number | null) =>
    snapshot?.alloc != null && v !== null && (v / snapshot.alloc.cpuM) * 100 >= thresholds.cpu;
  const overMem = (v: number | null) =>
    snapshot?.alloc != null && v !== null && (v / snapshot.alloc.memMi) * 100 >= thresholds.mem;

  const phaseClass = (p: K8sPod) =>
    p.phase === 'Failed' ? 'err' : p.phase === 'Running' || p.phase === 'Succeeded' ? 'ok' : '';

  return (
    <section className="k8s-panel">
      <header className="k8s-h">
        <span className="k8s-title">
          {view.kind === 'ns' ? (
            <>
              <button className="nd-back" onClick={() => setView({ kind: 'workloads' })}>← workloads</button>
              <span className="ndchart-title">k3s · pods — {view.namespace}</span>
            </>
          ) : (
            <span className="ndchart-title">k3s workloads</span>
          )}
        </span>
        <span className="k8s-meta">
          <span className="k8s-live" data-live={live}>{live ? 'live' : 'reconnecting'}</span>
          {fetchedAt !== null && <span className="k8s-fresh">updated {ago(now - fetchedAt)} ago</span>}
          {partial && <span className="k8s-fresh">loading usage…</span>}
          <button className="k8s-refresh" onClick={refresh} disabled={!live}>refresh</button>
        </span>
      </header>

      {error && (
        <div className="k8s-msg k8s-msg-err">
          {snapshot
            ? `update failed — ${error} · showing data from ${fetchedAt !== null ? `${ago(now - fetchedAt)} ago` : 'earlier'}`
            : error}
        </div>
      )}
      {!error && !snapshot && <div className="k8s-msg">{live ? 'fetching cluster snapshot…' : 'connecting…'}</div>}
      {snapshot && !partial && !metrics && (
        <div className="k8s-msg">no usage numbers — metrics-server unavailable on the cluster</div>
      )}

      {snapshot && view.kind === 'workloads' && (
        <>
          <div className="k8s-sort">
            {(['cpu', 'mem', 'name'] as Sort[]).map((s) => (
              <button key={s} className="fb-sortbtn" data-on={sort === s} onClick={() => setSort(s)} disabled={!metrics && s !== 'name'}>
                {s}
              </button>
            ))}
          </div>
          <div className="k8s-list">
            {workloads.map((w) => (
              <button
                key={`${w.namespace}|${w.kind}|${w.name}`}
                className="k8s-row"
                onClick={() => setView({ kind: 'ns', namespace: w.namespace })}
                title={`Pods in ${w.namespace}`}
              >
                <span className="k8s-kind">{KIND_ABBR[w.kind] ?? w.kind.toLowerCase()}</span>
                <span className="k8s-id">
                  <span className="k8s-name">{w.name}</span>
                  <span className="k8s-sub">{w.namespace}</span>
                </span>
                <Metric label="cpu" value={w.cpuM} max={maxWl.cpu} over={overCpu(w.cpuM)} pending={partial} />
                <Metric label="mem" value={w.memMi} max={maxWl.mem} over={overMem(w.memMi)} pending={partial} />
                <span className="k8s-health">
                  <span className="k8s-ready" data-bad={w.pods > 0 && w.ready < w.pods}>
                    {w.pods === 0 ? '—' : `${w.ready}/${w.pods}`}
                  </span>
                  {w.restarts > 0 && <span className="k8s-restarts" data-some="true">↻{w.restarts}</span>}
                </span>
              </button>
            ))}
            {workloads.length === 0 && <div className="k8s-msg">no workloads found</div>}
          </div>
        </>
      )}

      {snapshot && view.kind === 'ns' && (
        <div className="k8s-list">
          {nsPods.map((p) => (
            <div key={p.name} className="k8s-pods-row">
              <span className="k8s-id">
                <span className="k8s-name">{p.name}</span>
                <span className="k8s-sub">
                  <span className={`k8s-phase job-output-tag ${phaseClass(p)}`}>{p.phase.toLowerCase()}</span>
                  <span className="k8s-ready" data-bad={p.phase === 'Running' && p.ready < p.total}>{p.ready}/{p.total}</span>
                  {p.restarts > 0 && <span className="k8s-restarts" data-some="true">↻{p.restarts}</span>}
                </span>
              </span>
              <Metric label="cpu" value={p.cpuM} max={maxPod.cpu} over={overCpu(p.cpuM)} pending={partial} />
              <Metric label="mem" value={p.memMi} max={maxPod.mem} over={overMem(p.memMi)} pending={partial} />
              <span className="k8s-age">{fmtAge(p.ageSec)}</span>
            </div>
          ))}
          {nsPods.length === 0 && <div className="k8s-msg">no pods in this namespace</div>}
        </div>
      )}
    </section>
  );
}
