import { useEffect, useRef } from 'react';
import { Terminal, type TerminalHandle } from '../terminal/Terminal.tsx';
import { useSshStream, type RunState } from '../terminal/useSshStream.ts';
import type { ServerSummary } from '../shared/api.ts';

type Props = {
  runbookId: string;
  runbookName: string;
  target: ServerSummary;
  params?: Record<string, string>;
  onBack: () => void;
};

const STATUS_LABEL: Record<RunState, string> = {
  idle:       'ready',
  connecting: 'connecting',
  running:    'running',
  done:       'done',
  failed:     'failed',
};

export function RunningScreen({ runbookId, runbookName, target, params, onBack }: Props) {
  const termRef = useRef<TerminalHandle>(null);
  const startedRef = useRef(false);

  const writeChunk = (data: string) => termRef.current?.write(data.replace(/\n/g, '\r\n'));
  const clearTerm  = () => termRef.current?.clear();

  const { state, exitCode, run, cancel } = useSshStream({ onChunk: writeChunk, onClear: clearTerm });

  // Auto-start once the terminal has mounted (one tick after first paint).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const id = requestAnimationFrame(() => run(target.id, runbookId, params));
    return () => cancelAnimationFrame(id);
  }, [runbookId, target.id, run, params]);

  const isLive = state === 'connecting' || state === 'running';
  const status = state === 'done' || state === 'failed'
    ? (exitCode !== null ? `exit ${exitCode}` : STATUS_LABEL[state])
    : STATUS_LABEL[state];

  return (
    <>
      <div className="m-runstatus">
        <span className="m-live">
          {isLive && <span className="m-blip" />}
          {status}
        </span>
        <span>{runbookName}</span>
      </div>

      <div className="m-dhead m-dhead-compact">
        <div className="m-dhead-row">
          <div className="m-dhead-ttl small">{runbookName}</div>
          <span className="m-chip"><span className="m-chip-dot" />{target.name}</span>
        </div>
      </div>

      <Terminal ref={termRef} />

      <div className="m-actionbar">
        {isLive
          ? <button className="m-run-btn outline" onClick={cancel}>ABORT</button>
          : <button className="m-run-btn outline" onClick={onBack}>BACK</button>}
      </div>
    </>
  );
}
