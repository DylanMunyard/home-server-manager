import type { NodeSnapshot, Thresholds } from '../shared/api.ts';
import { MetricChart } from './MetricChart.tsx';
import { cpuSeries, memSeries, tempSeries, latest, mountsOf, pct } from './series.ts';

const SPARK_H = 34;

function StatusDot({ status }: { status: NodeSnapshot['status'] }) {
  return <span className="mdot" data-status={status} title={status} />;
}

// One metric's compact view: label + current value, then a sparkline.
function Spark({ label, value, data, yMax, threshold }: {
  label: string; value: string; data: { x: number; y: number }[]; yMax?: number; threshold?: number;
}) {
  return (
    <div className="mspark">
      <div className="mspark-h">
        <span className="mspark-label">{label}</span>
        <span className="mspark-val">{value}</span>
      </div>
      <MetricChart data={data} height={SPARK_H} yMax={yMax} threshold={threshold} />
    </div>
  );
}

export function MetricTile({ node, thresholds, onExpand }: {
  node: NodeSnapshot;
  thresholds: Thresholds;
  onExpand: (id: string) => void;
}) {
  const last = latest(node);
  const memPct = last ? pct(last.mem.used, last.mem.total) : 0;
  const mounts = mountsOf(node);

  return (
    <button className="mtile" onClick={() => onExpand(node.id)} title="Open node detail">
      <div className="mtile-head">
        <div className="mtile-id">
          <StatusDot status={node.status} />
          <b>{node.name}</b>
        </div>
        <span className="mtile-host">{node.host}</span>
      </div>

      {node.status === 'down' && <div className="mtile-down">offline — {node.lastError ?? 'no data'}</div>}

      {!last && node.status !== 'down' && <div className="mtile-wait">waiting for first sample…</div>}

      {last && (
        <div className="mtile-sparks">
          <Spark
            label="cpu"
            value={`${last.cpu.toFixed(0)}%`}
            data={cpuSeries(node.samples)}
            yMax={100}
            threshold={thresholds.cpu}
          />
          <Spark
            label="mem"
            value={`${memPct.toFixed(0)}%`}
            data={memSeries(node.samples)}
            yMax={100}
            threshold={thresholds.mem}
          />
          <Spark
            label="temp"
            value={last.temp === null ? '—' : `${last.temp}°`}
            data={tempSeries(node.samples)}
            threshold={thresholds.temp}
          />
        </div>
      )}

      {last && mounts.length > 0 && (
        <div className="mtile-disks">
          {mounts.map((mt) => {
            const d = last.disk.find((x) => x.mount === mt)!;
            const p = pct(d.used, d.total);
            return (
              <div className="mbar-row" key={mt}>
                <span className="mbar-label">{mt}</span>
                <span className="mbar-track">
                  <span
                    className="mbar-fill"
                    data-over={p >= thresholds.disk}
                    style={{ width: `${Math.min(100, p)}%` }}
                  />
                </span>
                <span className="mbar-val">{p.toFixed(0)}%</span>
              </div>
            );
          })}
        </div>
      )}
    </button>
  );
}
