import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat, type ChatItem, type ChatPhase } from './useChat.ts';

function CmdBlock({ item, running }: { item: Extract<ChatItem, { kind: 'cmd' }>; running: boolean }) {
  return (
    <div className={`chat-cmd${running ? ' running' : ''}`}>
      <div className="chat-cmd-head">
        <span className="chat-cmd-name">run_command</span>
        <span className="chat-cmd-n">#{item.n}</span>
        {item.purpose && <span className="chat-cmd-purpose">{item.purpose}</span>}
        {running && <span className="chat-cmd-running">running…</span>}
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

function ChatItemRow({ item, runningN }: { item: ChatItem; runningN: number | null }) {
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
      return <CmdBlock item={item} running={item.n === runningN} />;
    case 'output':
      return <OutputBlock item={item} />;
    case 'notice':
      return <div className="chat-row notice">{item.text}</div>;
    case 'error':
      return <div className="chat-row error">{item.text}</div>;
  }
}

// What the server is doing right now, in words, for the live status line.
function phaseLabel(phase: ChatPhase): string {
  if (!phase) return 'working…';
  if (phase.phase === 'running') {
    return phase.purpose ? `running #${phase.n}: ${phase.purpose}` : `running command #${phase.n}…`;
  }
  return 'thinking…';
}

type Props = {
  target: string;
  // Optional first message to send automatically on mount (e.g. seeded from an
  // investigation). Only sent once; ignored if the chat already has history.
  seedMessage?: string;
};

export function ChatSession({ target, seedMessage }: Props) {
  const { items, busy, phase, sendMessage, cancel } = useChat(target);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);

  // The command (by n) currently executing — its cmd block shows "running…"
  // until the matching output arrives.
  const runningN = phase?.phase === 'running' ? phase.n ?? null : null;

  // Whether the in-flight phase is already represented by a visible cmd block
  // (so we don't also show a redundant standalone "thinking" line for it).
  const hasOutput = useMemo(() => {
    const s = new Set<number>();
    for (const it of items) if (it.kind === 'output') s.add(it.n);
    return s;
  }, [items]);
  const cmdRunningVisible = runningN != null && !hasOutput.has(runningN);

  // Auto-scroll to bottom on new items / status changes.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, busy, phase]);

  // Send seed message once on mount.
  useEffect(() => {
    if (seedMessage && !seededRef.current) {
      seededRef.current = true;
      sendMessage(seedMessage);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    sendMessage(text);
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
        {items.map((item, i) => <ChatItemRow key={i} item={item} runningN={runningN} />)}
        {busy && !cmdRunningVisible && (
          <div className="chat-row ai">
            <span className="chat-who">AI</span>
            <div className="chat-status">
              <span className="chat-status-dot" />
              {phaseLabel(phase)}
            </div>
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
        {busy ? (
          <button className="chat-send stop" onClick={cancel} title="Stop the AI">
            ■
          </button>
        ) : (
          <button className="chat-send" onClick={submit} disabled={!input.trim()}>
            ▶
          </button>
        )}
      </div>
    </div>
  );
}
