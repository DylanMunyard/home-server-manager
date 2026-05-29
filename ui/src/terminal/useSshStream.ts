import { useCallback, useEffect, useRef, useState } from 'react';

export type RunState = 'idle' | 'connecting' | 'running' | 'done' | 'failed';

export type RunEvent =
  | { type: 'connect' }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number | null; signal?: string | null }
  | { type: 'error'; message: string };

export type StreamHandlers = {
  onChunk: (data: string, kind: 'stdout' | 'stderr') => void;
  onClear?: () => void;
};

export function useSshStream({ onChunk, onClear }: StreamHandlers) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<RunState>('idle');
  const [exitCode, setExitCode] = useState<number | null>(null);

  const cancel = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  const run = useCallback((serverId: string, runbookId: string, params?: Record<string, string>) => {
    cancel();
    onClear?.();
    setExitCode(null);
    setState('connecting');

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const paramsQuery = params && Object.keys(params).length > 0
      ? `&params=${encodeURIComponent(JSON.stringify(params))}`
      : '';
    const url = `${proto}://${window.location.host}/ws/run?server=${encodeURIComponent(serverId)}&runbook=${encodeURIComponent(runbookId)}${paramsQuery}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      const event = JSON.parse(ev.data) as RunEvent;
      switch (event.type) {
        case 'connect': setState('running'); break;
        case 'stdout': onChunk(event.data, 'stdout'); break;
        case 'stderr': onChunk(event.data, 'stderr'); break;
        case 'exit':
          setExitCode(event.code);
          setState(event.code === 0 ? 'done' : 'failed');
          break;
        case 'error':
          onChunk(`\r\n[error] ${event.message}\r\n`, 'stderr');
          setState('failed');
          break;
      }
    };
    ws.onclose = () => {
      wsRef.current = null;
      setState((s) => (s === 'connecting' || s === 'running' ? 'failed' : s));
    };
  }, [cancel, onChunk, onClear]);

  return { state, exitCode, run, cancel };
}
