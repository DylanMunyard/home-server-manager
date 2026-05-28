import { useCallback, useEffect, useRef, useState } from 'react';

export type ShellState = 'idle' | 'connecting' | 'connected' | 'closed' | 'failed';

export type ShellEvent =
  | { type: 'connect' }
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null; signal?: string | null }
  | { type: 'error'; message: string };

export type ShellHandlers = {
  onData:  (data: string) => void;
  onClear?: () => void;
};

export function useShellStream({ onData, onClear }: ShellHandlers) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ShellState>('idle');

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  const connect = useCallback((serverId: string, initialSize: { cols: number; rows: number }) => {
    disconnect();
    onClear?.();
    setState('connecting');

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams({
      server: serverId,
      cols: String(initialSize.cols),
      rows: String(initialSize.rows),
    });
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/shell?${qs}`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      const event = JSON.parse(ev.data) as ShellEvent;
      switch (event.type) {
        case 'connect': setState('connected'); break;
        case 'data':    onData(event.data); break;
        case 'exit':    setState('closed'); break;
        case 'error':
          onData(`\r\n[error] ${event.message}\r\n`);
          setState('failed');
          break;
      }
    };
    ws.onclose = () => {
      wsRef.current = null;
      setState((s) => (s === 'connecting' || s === 'connected' ? 'closed' : s));
    };
  }, [disconnect, onData, onClear]);

  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }, []);

  return { state, connect, disconnect, sendInput, sendResize };
}
