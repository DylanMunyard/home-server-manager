import { useCallback, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ServerRail } from '../servers/ServerRail.tsx';
import { ServerDetail } from '../servers/ServerDetail.tsx';
import { RunbookList } from '../runbooks/RunbookList.tsx';
import { RunbookParams } from '../runbooks/RunbookParams.tsx';
import { ScriptViewer } from '../runbooks/ScriptViewer.tsx';
import { Terminal, type TerminalHandle } from '../terminal/Terminal.tsx';
import { JobsView } from '../jobs/JobsView.tsx';
import { testAlert } from '../shared/api.ts';
import { useGroups, useServerDetail } from '../servers/useServers.ts';
import { useRunbook, useRunbooks } from '../runbooks/useRunbooks.ts';
import { useRunbookParams } from '../runbooks/useRunbookParams.ts';
import { useSshStream } from '../terminal/useSshStream.ts';
import { useShellStream } from '../terminal/useShellStream.ts';

type Mode = 'runbook' | 'shell';
type TopView = 'console' | 'jobs';

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
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Top view = pathname. `/` and `/console` show the console; `/jobs` shows
  // the jobs view. Anything else falls back to console so a bookmarked /m/...
  // URL (mobile) doesn't render blank when the desktop layout takes over.
  const topView: TopView = location.pathname.startsWith('/jobs') ? 'jobs' : 'console';

  // Selections live in the query string so refresh + share + back-button work.
  const serverId = searchParams.get('server');
  const runbookId = searchParams.get('runbook');
  const mode: Mode = (searchParams.get('mode') as Mode) === 'shell' ? 'shell' : 'runbook';

  const setTopView = useCallback((v: TopView) => {
    navigate(v === 'jobs' ? '/jobs' : { pathname: '/console', search: location.search });
  }, [navigate, location.search]);

  const updateParams = useCallback((patch: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace: false });
  }, [setSearchParams]);

  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [alertBusy, setAlertBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { detail: serverDetail, loading: detailLoading, error: detailError } = useServerDetail(serverId, reloadKey);
  const runbook = useRunbook(runbookId);
  const { params, values: paramValues, setValue: setParamValue, complete: paramsComplete } = useRunbookParams(runbook);
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
    updateParams({ server: id });
    setReloadKey((k) => k + 1);
  }, [updateParams]);

  const selectedServer = useMemo(
    () => allServers.find((s) => s.id === serverId) ?? null,
    [allServers, serverId],
  );

  const switchMode = useCallback((next: Mode) => {
    if (next === mode) return;
    cancelRun();
    disconnectShell();
    updateParams({ mode: next === 'runbook' ? null : next });
  }, [mode, cancelRun, disconnectShell, updateParams]);

  const canRun = mode === 'runbook' && !!serverId && !!runbookId && paramsComplete
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

  const sendTestAlert = useCallback(async () => {
    setAlertBusy(true);
    setAlertMsg(null);
    const r = await testAlert(runbookId, serverId);
    setAlertBusy(false);
    setAlertMsg(r.sent ? 'test alert sent ✓' : `alert failed: ${r.reason ?? 'unknown'}`);
  }, [runbookId, serverId]);

  return (
    <div className="app">
      <header className="masthead">
        <h1>home-lab</h1>
        <nav className="top-nav">
          <button data-active={topView === 'console'} onClick={() => setTopView('console')}>console</button>
          <button data-active={topView === 'jobs'} onClick={() => setTopView('jobs')}>jobs</button>
        </nav>
        <span className="meta">{allServers.length} nodes · {groups.length} groups · {runbooks.length} runbooks</span>
        <a className="signout" href="/api/auth/logout">sign out</a>
      </header>

      {topView === 'jobs' ? <JobsView /> : (
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

              <RunbookParams params={params} values={paramValues} onChange={setParamValue} />

              <div className="stage-actions">
                <button
                  data-variant="run"
                  disabled={!canRun}
                  onClick={() => { if (serverId && runbookId) run(serverId, runbookId, paramValues); }}
                >
                  Run
                </button>
                {isRunLive && <button onClick={cancelRun}>Cancel</button>}
                <button
                  disabled={!runbookId || alertBusy}
                  onClick={sendTestAlert}
                  title="Send a test ntfy alert that simulates this script failing — nothing runs, no remediation"
                >
                  {alertBusy ? 'Sending…' : 'Test alert'}
                </button>
                <div className="spacer" />
                {alertMsg && <span className="status">{alertMsg}</span>}
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

        <RunbookList runbooks={runbooks} selectedId={runbookId} onSelect={(id) => updateParams({ runbook: id })} />
      </div>
      )}
    </div>
  );
}
