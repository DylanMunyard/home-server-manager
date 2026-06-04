import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatEvent, ConvoMessage } from '../shared/api.ts';

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; content: string }
  | { kind: 'cmd'; n: number; purpose: string; bash: string }
  | { kind: 'output'; n: number; exitCode: number | null; stdout: string; stderr: string; rejected?: string }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string };

// Current phase of the in-flight turn, surfaced so the UI can show *what the
// server is doing right now* (waiting on the model vs running a command N).
export type ChatPhase = { phase: 'thinking' | 'running'; n?: number; purpose?: string } | null;

// Drives the chat over a persistent /ws/ai/chat connection. We own the
// conversation history (stateless server) and send `{ history, userMessage }`
// per turn, folding the streamed events into renderable items + a live phase;
// the turn's `done` carries the new turns to append. The socket reopens when
// `target` changes (fresh conversation).
export function useChat(target: string) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ChatPhase>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const busyRef = useRef(false);
  // History is held in a ref so sendMessage always sees the latest without being
  // re-created each render; the server replays it on every turn.
  const historyRef = useRef<ConvoMessage[]>([]);
  // Frames typed before the socket is open are queued and flushed on connect
  // (covers the seed-message-on-mount race).
  const queueRef = useRef<string[]>([]);

  useEffect(() => {
    setItems([]);
    setBusy(false);
    setPhase(null);
    historyRef.current = [];
    queueRef.current = [];
    let tornDown = false;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/ai/chat?target=${encodeURIComponent(target)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      readyRef.current = true;
      for (const frame of queueRef.current) ws.send(frame);
      queueRef.current = [];
    };
    ws.onmessage = (ev) => {
      let e: ChatEvent;
      try { e = JSON.parse(ev.data) as ChatEvent; } catch { return; }
      switch (e.type) {
        case 'status':
          setPhase({ phase: e.phase, n: e.n, purpose: e.purpose });
          break;
        case 'text':
          setItems((p) => [...p, { kind: 'text', content: e.content }]);
          break;
        case 'cmd':
          setItems((p) => [...p, { kind: 'cmd', n: e.n, purpose: e.purpose, bash: e.bash }]);
          break;
        case 'output':
          setItems((p) => [...p, { kind: 'output', n: e.n, exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr, rejected: e.rejected }]);
          break;
        case 'done':
          if (e.ok) historyRef.current = [...historyRef.current, ...e.messages];
          if (e.cancelled) setItems((p) => [...p, { kind: 'notice', text: 'stopped' }]);
          else if (!e.ok) setItems((p) => [...p, { kind: 'error', text: e.error ?? 'AI request failed' }]);
          busyRef.current = false;
          setBusy(false);
          setPhase(null);
          break;
      }
    };
    ws.onclose = () => {
      readyRef.current = false;
      // An unexpected drop *mid-turn* (e.g. API restart) would otherwise leave
      // the UI stuck on `busy`. Surface it and re-enable input. Idle drops are
      // silent; the socket re-establishes when `target` changes (effect re-run).
      if (!tornDown && busyRef.current) {
        setItems((p) => [...p, { kind: 'error', text: 'connection lost' }]);
        busyRef.current = false;
        setBusy(false);
        setPhase(null);
      }
    };

    return () => {
      tornDown = true;
      readyRef.current = false;
      ws.close();
      wsRef.current = null;
    };
  }, [target]);

  const sendMessage = useCallback((text: string) => {
    const msg = text.trim();
    if (!msg || busy) return;
    setItems((p) => [...p, { kind: 'user', text: msg }]);
    busyRef.current = true;
    setBusy(true);
    setPhase({ phase: 'thinking' });
    const frame = JSON.stringify({ history: historyRef.current, userMessage: msg });
    const ws = wsRef.current;
    if (ws && readyRef.current && ws.readyState === ws.OPEN) ws.send(frame);
    else queueRef.current.push(frame);
  }, [busy]);

  // Stop the in-flight turn. The server aborts the model call / ends the loop at
  // the next boundary and replies with a `done` (cancelled), which clears busy.
  const cancel = useCallback(() => {
    if (!busyRef.current) return;
    const ws = wsRef.current;
    if (ws && readyRef.current && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'cancel' }));
  }, []);

  return { items, busy, phase, sendMessage, cancel };
}
