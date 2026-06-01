import { useEffect, useState } from 'react';
import type { InvestigationEvent, InvestigationStatus } from '../shared/api.ts';

export type InvestigationState = {
  events: InvestigationEvent[];
  status: InvestigationStatus | null;
  connected: boolean;
};

// Subscribes to /ws/ai/investigate?id=…, which replays the buffered transcript
// on connect then forwards live events until the loop is done (server closes the
// socket). We just accumulate events in order — the component folds them into
// chat / tool-call / output blocks. Reconnects only if the socket drops *before*
// a `done` (an unfinished investigation), matching useMetrics' backoff style;
// once done we stay closed (nothing more is coming).
export function useInvestigation(id: string | null): InvestigationState {
  const [events, setEvents] = useState<InvestigationEvent[]>([]);
  const [status, setStatus] = useState<InvestigationStatus | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setEvents([]);
    setStatus(null);
    setConnected(false);
    if (!id) return;

    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let done = false;

    const open = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws/ai/investigate?id=${encodeURIComponent(id)}`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data) as InvestigationEvent;
          setEvents((prev) => [...prev, e]);
          if (e.type === 'start') setStatus('running');
          if (e.type === 'done') { done = true; setStatus(e.status); }
        } catch { /* ignore malformed frame */ }
      };
      ws.onclose = () => {
        setConnected(false);
        ws = null;
        if (!closed && !done) retry = setTimeout(open, 3000);
      };
    };
    open();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [id]);

  return { events, status, connected };
}
