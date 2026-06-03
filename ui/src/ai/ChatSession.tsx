import { useEffect, useRef, useState } from 'react';
import { useChat, type ChatItem } from './useChat.ts';

function CmdBlock({ item }: { item: Extract<ChatItem, { kind: 'cmd' }> }) {
  return (
    <div className="chat-cmd">
      <div className="chat-cmd-head">
        <span className="chat-cmd-name">run_command</span>
        <span className="chat-cmd-n">#{item.n}</span>
        {item.purpose && <span className="chat-cmd-purpose">{item.purpose}</span>}
      </div>
      <pre className="chat-bash"><code>{item.bash}</code></pre>
    </div>
  );
}

function OutputBlock({ item }: { item: Extract<ChatItem, { kind: 'output' }> }) {
  if (item.rejected) {
    return <div className="chat-out rejected">⛔ blocked — {item.rejected}</div>;
  }
  return (
    <div className="chat-out">
      <span className={`chat-exit ${item.exitCode === 0 ? 'ok' : 'err'}`}>
        exit {item.exitCode ?? '—'}
      </span>
      {(item.stdout?.trim() || item.stderr?.trim())
        ? <pre className="chat-out-pre">{[item.stdout, item.stderr].filter((s) => s?.trim()).join('\n')}</pre>
        : <pre className="chat-out-pre dim">(no output)</pre>}
    </div>
  );
}

function ChatItemRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="chat-row user">
          <div className="chat-bubble user">{item.text}</div>
        </div>
      );
    case 'text':
      return (
        <div className="chat-row ai">
          <span className="chat-who">AI</span>
          <div className="chat-bubble ai">{item.content}</div>
        </div>
      );
    case 'cmd':
      return <CmdBlock item={item} />;
    case 'output':
      return <OutputBlock item={item} />;
    case 'error':
      return <div className="chat-row error">{item.text}</div>;
  }
}

type Props = {
  target: string;
  // Optional first message to send automatically on mount (e.g. seeded from an
  // investigation). Only sent once; ignored if the chat already has history.
  seedMessage?: string;
};

export function ChatSession({ target, seedMessage }: Props) {
  const { items, busy, sendMessage, reset } = useChat(target);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);

  // Auto-scroll to bottom on new items.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, busy]);

  // Send seed message once on mount.
  useEffect(() => {
    if (seedMessage && !seededRef.current) {
      seededRef.current = true;
      void sendMessage(seedMessage);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset history when the target changes.
  useEffect(() => {
    seededRef.current = false;
    reset();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    void sendMessage(text);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat-session">
      <div className="chat-log">
        {items.length === 0 && !busy && (
          <div className="chat-empty">
            Ask the AI to diagnose or fix something on <b>{target.split('/')[1]}</b>.
            It can run commands on the server.
          </div>
        )}
        {items.map((item, i) => <ChatItemRow key={i} item={item} />)}
        {busy && (
          <div className="chat-row ai">
            <span className="chat-who">AI</span>
            <div className="chat-bubble ai thinking">thinking…</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          rows={2}
          placeholder={`Message AI about ${target.split('/')[1]}… (Enter to send, Shift+Enter for newline)`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={busy}
        />
        <button
          className="chat-send"
          onClick={submit}
          disabled={!input.trim() || busy}
        >
          {busy ? '…' : '▶'}
        </button>
      </div>
    </div>
  );
}
