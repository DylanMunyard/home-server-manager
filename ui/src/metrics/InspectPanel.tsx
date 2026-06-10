import { useRef, useState } from 'react';
import { Terminal, type TerminalHandle } from '../terminal/Terminal.tsx';
import { useSshStream } from '../terminal/useSshStream.ts';
import type { InspectAction } from '../shared/api.ts';

// Drill-down section in the node detail: one button per configured inspect
// runbook (dashboard `inspect:`), streamed into a bounded terminal over the
// existing /ws/run path — same wiring as the mobile RunningScreen. One run at
// a time; clicking again re-runs (run() cancels + clears).
export function InspectPanel({ serverId, actions }: {
  serverId: string;
  actions: InspectAction[];
}) {
  const termRef = useRef<TerminalHandle>(null);
  const [active, setActive] = useState<string | null>(null);

  const { state, exitCode, run, cancel } = useSshStream({
    onChunk: (data) => termRef.current?.write(data.replace(/\n/g, '\r\n')),
    onClear: () => termRef.current?.clear(),
  });

  const busy = state === 'connecting' || state === 'running';
  const status = state === 'done' || state === 'failed'
    ? (exitCode !== null ? `exit ${exitCode}` : state)
    : state;

  const start = (id: string) => {
    setActive(id);
    run(serverId, id);
  };

  return (
    <section className="nd-inspect">
      <header className="nd-inspect-h">
        <span className="ndchart-title">inspect</span>
        {active && <span className="nd-inspect-status" data-state={state}>{active} · {status}</span>}
      </header>
      <div className="nd-inspect-actions">
        {actions.map((a) => (
          <button
            key={a.id}
            className="nd-inspect-btn"
            title={a.description}
            disabled={busy}
            onClick={() => start(a.id)}
          >
            {a.id}
          </button>
        ))}
        {busy && <button className="nd-inspect-btn nd-inspect-cancel" onClick={cancel}>cancel</button>}
      </div>
      {/* Mounted only once something has run — no xterm cost for every detail open. */}
      {active && <Terminal ref={termRef} />}
    </section>
  );
}
