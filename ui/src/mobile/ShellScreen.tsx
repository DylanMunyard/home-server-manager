import { useCallback, useEffect, useRef } from 'react';
import { Terminal, type TerminalHandle } from '../terminal/Terminal.tsx';
import { useShellStream } from '../terminal/useShellStream.ts';
import type { ServerSummary } from '../shared/api.ts';

type Props = {
  target: ServerSummary;
  onBack: () => void;
};

export function ShellScreen({ target, onBack }: Props) {
  const termRef = useRef<TerminalHandle>(null);
  const startedRef = useRef(false);

  const onData = (data: string) => termRef.current?.write(data);
  const onClear = useCallback(() => termRef.current?.clear(), []);

  const { state, connect, disconnect, sendInput, sendResize } = useShellStream({ onData, onClear });

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const id = requestAnimationFrame(() => {
      const size = termRef.current?.fit() ?? { cols: 80, rows: 24 };
      connect(target.id, size);
    });
    return () => cancelAnimationFrame(id);
  }, [target.id, connect]);

  const onInput  = (data: string) => { if (state === 'connected') sendInput(data); };
  const onResize = (s: { cols: number; rows: number }) => { if (state === 'connected') sendResize(s.cols, s.rows); };

  const isLive = state === 'connecting' || state === 'connected';
  const status = state === 'connected' ? 'connected'
              : state === 'connecting' ? 'connecting'
              : state === 'closed'     ? 'closed'
              : state === 'failed'     ? 'failed'
              : 'idle';

  return (
    <>
      <div className="m-runstatus">
        <span className="m-live">
          {isLive && <span className="m-blip" />}
          {status}
        </span>
        <span>shell</span>
      </div>

      <div className="m-dhead m-dhead-compact">
        <div className="m-dhead-row">
          <div className="m-dhead-ttl small">shell</div>
          <span className="m-chip"><span className="m-chip-dot" />{target.name}</span>
        </div>
      </div>

      <Terminal ref={termRef} onInput={onInput} onResize={onResize} />

      <div className="m-actionbar">
        {isLive
          ? <button className="m-run-btn outline" onClick={disconnect}>DISCONNECT</button>
          : <button className="m-run-btn outline" onClick={onBack}>BACK</button>}
      </div>
    </>
  );
}
