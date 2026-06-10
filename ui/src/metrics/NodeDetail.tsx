import type { NodeSnapshot, Thresholds } from '../shared/api.ts';
import { MetricChart, type Point } from './MetricChart.tsx';
import { InspectPanel } from './InspectPanel.tsx';
import { cpuSeries, memSeries, tempSeries, diskSeries, pathSeries, latest, mountsOf, pathsOf, pct } from './series.ts';

const FULL_H = 150;

function Chart({ title, value, data, yMax, threshold }: {
  title: string; value: string; data: Point[]; yMax?: number; threshold?: number;
}) {
  return (
    <section className="ndchart">
      <header className="ndchart-h">
        <span className="ndchart-title">{title}</span>
        <span className="ndchart-val">{value}</span>
      </header>
      <MetricChart data={data} height={FULL_H} yMax={yMax} threshold={threshold} variant="full" />
    </section>
  );
}

// The expanded, fully-axed view for one node — every metric the probe reports,
// grouped under the node. Reuses the same derivations as the compact tile.
export function NodeDetail({ node, thresholds, onClose }: {
  node: NodeSnapshot;
  thresholds: Thresholds;
  onClose: () => void;
}) {
  const last = latest(node);
  const memPct = last ? pct(last.mem.used, last.mem.total) : 0;
  const gib = (mib: number) => (mib / 1024).toFixed(1);

  return (
    <div className="nodedetail">
      <div className="nodedetail-bar">
        <button className="nd-back" onClick={onClose}>← all nodes</button>
        <div className="nd-id">
          <span className="mdot" data-status={node.status} />
          <b>{node.name}</b>
          <span className="nd-host">{node.host}</span>
          {last && <span className="nd-load">load {last.load.join(' · ')} · {last.ncpu} cores</span>}
        </div>
      </div>

      {node.status === 'down' && <div className="nd-msg">offline — {node.lastError ?? 'no data'}</div>}
      {!last && node.status !== 'down' && <div className="nd-msg">waiting for first sample…</div>}

      {last && (
        <div className="nodedetail-charts">
          <Chart title="cpu %" value={`${last.cpu.toFixed(1)}%`} data={cpuSeries(node.samples)} yMax={100} threshold={thresholds.cpu} />
          <Chart
            title="memory %"
            value={`${memPct.toFixed(0)}% · ${gib(last.mem.used)}/${gib(last.mem.total)} GiB`}
            data={memSeries(node.samples)} yMax={100} threshold={thresholds.mem}
          />
          <Chart
            title="temp °C"
            value={last.temp === null ? 'no sensors' : `${last.temp}°C`}
            data={tempSeries(node.samples)} threshold={thresholds.temp}
          />
          {mountsOf(node).map((mt) => {
            const d = last.disk.find((x) => x.mount === mt)!;
            return (
              <Chart
                key={mt}
                title={`disk ${mt}`}
                value={`${pct(d.used, d.total).toFixed(0)}% · ${d.used}/${d.total} GiB`}
                data={diskSeries(node.samples, mt)} yMax={100} threshold={thresholds.disk}
              />
            );
          })}
          {/* du-monitored dirs — no capacity, so absolute GiB on an autoscaled axis. */}
          {pathsOf(node).map((p) => (
            <Chart
              key={p.label}
              title={`path ${p.label}`}
              value={p.used === null ? 'unreadable' : `${p.used.toFixed(1)} GiB`}
              data={pathSeries(node.samples, p.label)}
            />
          ))}
        </div>
      )}

      {(node.inspect ?? []).length > 0 && (
        <InspectPanel serverId={node.id} actions={node.inspect!} />
      )}
    </div>
  );
}
