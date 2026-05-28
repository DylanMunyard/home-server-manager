import { useCallback, useMemo, useRef, useState } from 'react';
import { ServerRail } from '../servers/ServerRail.tsx';
import { ServerDetail } from '../servers/ServerDetail.tsx';
import { RunbookList } from '../runbooks/RunbookList.tsx';
import { ScriptViewer } from '../runbooks/ScriptViewer.tsx';
import { Terminal, type TerminalHandle } from '../terminal/Terminal.tsx';
import { useGroups, useServerDetail } from '../servers/useServers.ts';
import { useRunbook, useRunbooks } from '../runbooks/useRunbooks.ts';
import { useSshStream } from '../terminal/useSshStream.ts';
import { useShellStream } from '../terminal/useShellStream.ts';

type Mode = 'runbook' | 'shell';

const RUN_STATUS_LABEL: Record<string, string> = {
  idle:       'ready',
  connecting: 'connecting',
  running:    'running',
  done:       'exit 0',
  failed:     'failed',
};

const SHELL_STATUS_LABEL: Record<string, string> = {
  idle:       'disconnected',
  connecting: 'connecting',
  connected:  'connected',
  closed:     'closed',
  failed:     'failed',
};

export function DesktopApp() {
  const { groups, allServers } = useGroups();
  const { runbooks } = useRunbooks();
  const [mode, setMode] = useState<Mode>('runbook');
  const [serverId, setServerId] = useState<string | null>(null);
  const [runbookId, setRunbookId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { detail: serverDetail, loading: detailLoading, error: detailError } = useServerDetail(serverId, reloadKey);
  const runbook = useRunbook(runbookId);
  const termRef = useRef<TerminalHandle>(null);

  const writeRunChunk = useCallback((data: string) => {
    termRef.current?.write(data.replace(/\n/g, '\r\n'));
  }, []);
  const writeShellChunk = useCallback((data: string) => {
    termRef.current?.write(data);
  }, []);
  const clearTerm = useCallback(() => termRef.current?.clear(), []);

  const { state: runState, exitCode, run, cancel: cancelRun } = useSshStream({
    onChunk: writeRunChunk,
    onClear: clearTerm,
  });
  const { state: shellState, connect: connectShell, disconnect: disconnectShell, sendInput, sendResize } =
    useShellStream({ onData: writeShellChunk, onClear: clearTerm });

  const selectServer = useCallback((id: string) => {
    setServerId(id);
    setReloadKey((k) => k + 1);
  }, []);

  const selectedServer = useMemo(
    () => allServers.find((s) => s.id === serverId) ?? null,
    [allServers, serverId],
  );

  const switchMode = useCallback((next: Mode) => {
    if (next === mode) return;
    cancelRun();
    disconnectShell();
    setMode(next);
  }, [mode, cancelRun, disconnectShell]);

  const canRun = mode === 'runbook' && !!serverId && !!runbookId
    && runState !== 'connecting' && runState !== 'running';
  const isRunLive = runState === 'connecting' || runState === 'running';
  const runStatusLabel = (runState === 'done' || runState === 'failed') && exitCode !== null
    ? `exit ${exitCode}`
    : RUN_STATUS_LABEL[runState];

  const canConnect = mode === 'shell' && !!serverId
    && shellState !== 'connecting' && shellState !== 'connected';
  const isShellLive = shellState === 'connecting' || shellState === 'connected';
  const shellStatusLabel = SHELL_STATUS_LABEL[shellState];

  const connectShellNow = useCallback(() => {
    if (!serverId) return;
    const size = termRef.current?.fit() ?? { cols: 120, rows: 32 };
    connectShell(serverId, size);
  }, [serverId, connectShell]);

  const onTerminalInput = useCallback((data: string) => {
    if (mode === 'shell' && shellState === 'connected') sendInput(data);
  }, [mode, shellState, sendInput]);

  const onTerminalResize = useCallback((size: { cols: number; rows: number }) => {
    if (mode === 'shell' && shellState === 'connected') sendResize(size.cols, size.rows);
  }, [mode, shellState, sendResize]);

  return (
    <div className="app">
      <header className="masthead">
        <h1>home-lab</h1>
        <span className="meta">{allServers.length} nodes · {groups.length} groups · {runbooks.length} runbooks</span>
      </header>

      <div className="workspace">
        <ServerRail groups={groups} selectedId={serverId} onSelect={selectServer} />

        <main className="stage">
          <nav className="mode-tabs">
            <button data-active={mode === 'runbook'} onClick={() => switchMode('runbook')}>Runbook</button>
            <button data-active={mode === 'shell'}   onClick={() => switchMode('shell')}>Shell</button>
          </nav>

          {mode === 'runbook' ? (
            <>
              <div className="stage-head">
                <h2>{runbook?.name ?? 'Select a runbook'}</h2>
                <div className="target">
                  target: <b>{selectedServer ? `${selectedServer.user}@${selectedServer.host}` : '—'}</b>
                </div>
                {runbook?.description && <div className="desc">{runbook.description}</div>}
              </div>

              {serverId && (
                <ServerDetail detail={serverDetail} loading={detailLoading} error={detailError} />
              )}

              <div className="stage-actions">
                <button
                  data-variant="run"
                  disabled={!canRun}
                  onClick={() => { if (serverId && runbookId) run(serverId, runbookId); }}
                >
                  Run
                </button>
                {isRunLive && <button onClick={cancelRun}>Cancel</button>}
                <div className="spacer" />
                <span className="status" data-state={runState}>{runStatusLabel}</span>
              </div>

              {runbook
                ? <ScriptViewer contents={runbook.contents} />
                : <div className="empty">Choose a runbook on the right to preview its script.</div>}
            </>
          ) : (
            <>
              <div className="stage-head">
                <h2>Shell</h2>
                <div className="target">
                  target: <b>{selectedServer ? `${selectedServer.user}@${selectedServer.host}` : '—'}</b>
                </div>
              </div>

              {serverId && (
                <ServerDetail detail={serverDetail} loading={detailLoading} error={detailError} />
              )}

              <div className="stage-actions">
                <button data-variant="run" disabled={!canConnect} onClick={connectShellNow}>Connect</button>
                {isShellLive && <button onClick={disconnectShell}>Disconnect</button>}
                <div className="spacer" />
                <span className="status" data-state={shellState}>{shellStatusLabel}</span>
              </div>
            </>
          )}

          <Terminal ref={termRef} onInput={onTerminalInput} onResize={onTerminalResize} />
        </main>

        <RunbookList runbooks={runbooks} selectedId={runbookId} onSelect={setRunbookId} />
      </div>
    </div>
  );
}
