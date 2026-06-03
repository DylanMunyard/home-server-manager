import { useCallback, useRef, useState } from 'react';
import { chatSession, type ChatEvent, type ConvoMessage } from '../shared/api.ts';

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'text'; content: string }
  | { kind: 'cmd'; n: number; purpose: string; bash: string }
  | { kind: 'output'; n: number; exitCode: number | null; stdout: string; stderr: string; rejected?: string }
  | { kind: 'error'; text: string };

function eventsToItems(events: ChatEvent[]): ChatItem[] {
  return events.map((e): ChatItem => {
    if (e.type === 'text') return { kind: 'text', content: e.content };
    if (e.type === 'cmd') return { kind: 'cmd', n: e.n, purpose: e.purpose, bash: e.bash };
    return { kind: 'output', n: e.n, exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr, rejected: e.rejected };
  });
}

export function useChat(target: string) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  // History is stored in a ref so sendMessage always sees the latest version
  // without needing to be re-created on every render.
  const historyRef = useRef<ConvoMessage[]>([]);

  const sendMessage = useCallback(async (text: string) => {
    if (busy) return;
    setBusy(true);
    setItems((prev) => [...prev, { kind: 'user', text }]);

    const result = await chatSession(target, historyRef.current, text);

    if (result.ok) {
      historyRef.current = [...historyRef.current, ...result.messages];
      setItems((prev) => [...prev, ...eventsToItems(result.events)]);
    } else {
      setItems((prev) => [
        ...prev,
        { kind: 'error', text: result.error ?? 'AI request failed' },
      ]);
    }

    setBusy(false);
  }, [target, busy]);

  const reset = useCallback(() => {
    historyRef.current = [];
    setItems([]);
  }, []);

  return { items, busy, sendMessage, reset };
}
