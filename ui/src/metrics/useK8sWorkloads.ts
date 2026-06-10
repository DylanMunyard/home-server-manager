import { useCallback, useEffect, useRef, useState } from 'react';
import type { K8sSnapshot, K8sStreamEvent } from '../shared/api.ts';

const RECONNECT_MS = 10_000;

/**
 * Live feed for the k3s panel over /ws/k8s/workloads. The server holds one SSH
 * session per connection and pushes cycles of progressive events:
 * `alloc`/`structure` assemble a partial snapshot for fast first paint (only
 * honoured before the first full snapshot — applying them later would blank
 * the usage every cycle), then `snapshot` is authoritative. `refresh()` asks
 * the server for an immediate cycle. A dropped socket reconnects on a backoff
 * while the panel stays mounted; the last good snapshot is kept throughout.
 */
export function useK8sWorkloads(serverId: string) {
  const [snapshot, setSnapshot] = useState<K8sSnapshot | null>(null);
  const [partial, setPartial] = useState(false);  // structure only — usage still loading
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    const haveFull = { current: false };
    const alloc = { current: null as K8sSnapshot['alloc'] };
    setSnapshot(null);
    setPartial(false);
    setError(null);
    setLive(false);
    setFetchedAt(null);

    const connect = () => {
      if (!alive) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws/k8s/workloads?server=${encodeURIComponent(serverId)}`);
      wsRef.current = ws;

      ws.onopen = () => setLive(true);
      ws.onmessage = (ev) => {
        const e = JSON.parse(ev.data) as K8sStreamEvent;
        if (e.type === 'alloc') {
          alloc.current = e.alloc;
          if (!haveFull.current) {
            setSnapshot((s) => (s ? { ...s, alloc: e.alloc } : s));
          }
        } else if (e.type === 'structure') {
          if (!haveFull.current) {
            setSnapshot({
              fetchedAt: Date.now(), durationMs: 0, alloc: alloc.current,
              metricsAvailable: false, workloads: e.workloads, pods: e.pods,
            });
            setPartial(true);
          }
        } else if (e.type === 'snapshot') {
          haveFull.current = true;
          setSnapshot(e.snapshot);
          setPartial(false);
          setFetchedAt(Date.now());
          setError(null);
        } else if (e.type === 'error') {
          setError(e.message);
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        wsRef.current = null;
        setLive(false);
        timer = window.setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [serverId]);

  // Ask the server for an immediate fetch cycle (any frame works).
  const refresh = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send('refresh');
  }, []);

  return { snapshot, partial, error, live, fetchedAt, refresh };
}
