import { useEffect, useRef, useState } from 'react';
import type {
  DashboardMeta, MetricsEvent, NodeSnapshot,
} from '../shared/api.ts';

export type MetricsState = {
  meta: DashboardMeta | null;
  nodes: NodeSnapshot[];
  connected: boolean;
};

// Subscribes to /ws/metrics, which sends a full snapshot on connect (the
// collector's in-memory ring buffers) then live `sample`/`status` deltas. We
// merge into per-node arrays and cap them to the retention window so a
// long-lived tab doesn't grow unbounded. Reconnects on close with a short
// backoff — the next snapshot re-seeds everything, so no state is lost.
export function useMetrics(): MetricsState {
  const [meta, setMeta] = useState<DashboardMeta | null>(null);
  const [nodes, setNodes] = useState<NodeSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const capRef = useRef<number>(Infinity);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const apply = (e: MetricsEvent) => {
      if (e.type === 'snapshot') {
        const { meta: m, nodes: ns } = e.snapshot;
        setMeta(m);
        capRef.current = Math.ceil(m.retentionSec / m.interval) + 2;
        setNodes(ns);
        return;
      }
      if (e.type === 'sample') {
        setNodes((prev) => prev.map((n) => {
          if (n.id !== e.id) return n;
          const samples = [...n.samples, e.sample];
          if (samples.length > capRef.current) samples.splice(0, samples.length - capRef.current);
          return { ...n, samples, status: 'live' };
        }));
        return;
      }
      // status
      setNodes((prev) => prev.map((n) =>
        n.id === e.id ? { ...n, status: e.status, lastError: e.lastError } : n));
    };

    const open = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws/metrics`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => { try { apply(JSON.parse(ev.data) as MetricsEvent); } catch { /* ignore */ } };
      ws.onclose = () => {
        setConnected(false);
        ws = null;
        if (!closed) retry = setTimeout(open, 3000);
      };
    };
    open();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { meta, nodes, connected };
}
