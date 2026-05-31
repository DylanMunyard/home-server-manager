import { useMemo, useState } from 'react';
import { useMetrics } from './useMetrics.ts';
import { MetricTile } from './MetricTile.tsx';
import { NodeDetail } from './NodeDetail.tsx';
import { FileBrowser } from '../files/FileBrowser.tsx';
import type { NodeSnapshot } from '../shared/api.ts';

// The whole live dashboard — shared by both shells (desktop renders it in the
// workspace, mobile in a screen body). Visualisations are grouped by node
// (one tile per server, charts grouped inside it); tiles are further grouped
// under their server-group heading to match the rest of the app. Click a tile
// to expand into the fully-axed NodeDetail. All data comes from useMetrics →
// the always-on collector, so there's nothing to "start".
export function Dashboard() {
  const { meta, nodes, connected } = useMetrics();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [browse, setBrowse] = useState<{ id: string; name: string; path: string } | null>(null);

  const groups = useMemo(() => {
    const by = new Map<string, NodeSnapshot[]>();
    for (const n of nodes) {
      const arr = by.get(n.group) ?? [];
      arr.push(n);
      by.set(n.group, arr);
    }
    return [...by.entries()];
  }, [nodes]);

  const thresholds = meta?.thresholds ?? { cpu: 90, mem: 90, disk: 85, temp: 80 };
  const expandedNode = expanded ? nodes.find((n) => n.id === expanded) ?? null : null;

  const openBrowse = (id: string, mount: string) => {
    const node = nodes.find((n) => n.id === id);
    setBrowse({ id, name: node?.name ?? id, path: mount });
  };

  if (browse) {
    return (
      <div className="dash">
        <FileBrowser
          server={browse.id}
          serverName={browse.name}
          initialPath={browse.path}
          onClose={() => setBrowse(null)}
        />
      </div>
    );
  }

  if (expandedNode) {
    return (
      <div className="dash">
        <NodeDetail node={expandedNode} thresholds={thresholds} onClose={() => setExpanded(null)} />
      </div>
    );
  }

  return (
    <div className="dash">
      <div className="dash-head">
        <h2>dashboard</h2>
        <span className="dash-meta" data-live={connected}>
          {connected ? 'live' : 'reconnecting…'}
          {meta && ` · ${meta.interval}s`}
          {` · ${nodes.length} node${nodes.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {nodes.length === 0 && (
        <div className="dash-empty">
          No nodes configured. Add servers under <code>config/servers/</code> or set
          <code> nodes:</code> in <code>config/dashboard.yaml</code>.
        </div>
      )}

      {groups.map(([group, gnodes]) => (
        <section className="dash-group" key={group}>
          <h3 className="dash-group-h">{group}</h3>
          <div className="dash-grid">
            {gnodes.map((n) => (
              <MetricTile key={n.id} node={n} thresholds={thresholds} onExpand={setExpanded} onBrowse={openBrowse} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
