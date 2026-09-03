import { useCallback, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ServerRail } from '../servers/ServerRail.tsx';
import { ServerDetail } from '../servers/ServerDetail.tsx';
import { RunbookList } from '../runbooks/RunbookList.tsx';
import { RunbookParams } from '../runbooks/RunbookParams.tsx';
import { ScriptViewer } from '../runbooks/ScriptViewer.tsx';
import { Terminal, type TerminalHandle } from '../terminal/Terminal.tsx';
import { JobsView } from '../jobs/JobsView.tsx';
import { Dashboard } from '../metrics/Dashboard.tsx';
import { ConfirmDialog } from '../shared/ConfirmDialog.tsx';
import { ChatSession } from '../ai/ChatSession.tsx';
import { testAlert } from '../shared/api.ts';
import { useGroups, useServerDetail } from '../servers/useServers.ts';
import { useRunbook, useRunbooks } from '../runbooks/useRunbooks.ts';
import { useRunbookParams } from '../runbooks/useRunbookParams.ts';
import { useSshStream } from '../terminal/useSshStream.ts';
import { useShellStream } from '../terminal/useShellStream.ts';
import { useAiStatus } from '../jobs/useAiStatus.ts';
import { MediaView } from '../media/MediaView.tsx';
import { useMediaStatus } from '../media/useMediaStatus.ts';

type Mode = 'runbook' | 'shell' | 'chat';
type TopView = 'console' | 'jobs' | 'dashboard' | 'media';

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
  const aiStatus = useAiStatus();
  const aiEnabled = aiStatus?.enabled ?? false;
  const mediaStatus = useMediaStatus();
  const mediaEnabled = mediaStatus?.enabled ?? false;
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Top view = pathname. `/` and `/console` show the console; `/jobs` the jobs
  // view; `/dashboard` the live metrics. Anything else falls back to console so
  // a bookmarked /m/... URL (mobile) doesn't render blank when the desktop
  // layout takes over.
  const topView: TopView = location.pathname.startsWith('/jobs') ? 'jobs'
    : location.pathname.startsWith('/dashboard') ? 'dashboard'
    : location.pathname.startsWith('/media') ? 'media'
    : 'console';

  // Selections live in the query string so refresh + share + back-button work.
  const serverId = searchParams.get('server');
  const runbookId = searchParams.get('runbook');
  const rawMode = searchParams.get('mode') as Mode | null;
  const mode: Mode = rawMode === 'shell' ? 'shell' : rawMode === 'chat' ? 'chat' : 'runbook';

  const setTopView = useCallback((v: TopView) => {
    if (v === 'jobs') navigate('/jobs');
    else if (v === 'dashboard') navigate('/dashboard');
    else if (v === 'media') navigate('/media');
    else navigate({ pathname: '/console', search: location.search });
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
  const [confirmRun, setConfirmRun] = useState(false);
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

  const filteredRunbooks = useMemo(() => {
    return runbooks.filter((rb) => {
      // Global runbooks (no nodes specified) are always shown.
      if (!rb.nodes || rb.nodes.length === 0) return true;
      
      // Node-specific runbooks are hidden unless a server is selected.
      if (!serverId) return false;

      return rb.nodes.some((pattern) => {
        if (pattern === serverId) return true;
        if (pattern.includes('*')) {
          const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          return re.test(serverId);
        }
        return false;
      });
    });
  }, [runbooks, serverId]);

  const switchMode = useCallback((next: Mode) => {
    if (next === mode) return;
    cancelRun();
    disconnectShell();
    updateParams({ mode: next === 'runbook' ? null : next });
  }, [mode, cancelRun, disconnectShell, updateParams]);

  // Seed message from ?seed= param (set by the jobs view "Chat" button).
  const seedMessage = searchParams.get('seed') ?? undefined;

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

  const doRun = useCallback(() => {
    if (serverId && runbookId) run(serverId, runbookId, paramValues);
  }, [serverId, runbookId, paramValues, run]);

  // Manual-run guard: a runbook flagged `confirm:` opens the dialog first;
  // everything else runs immediately.
  const startRun = useCallback(() => {
    if (runbook?.confirm) setConfirmRun(true);
    else doRun();
  }, [runbook, doRun]);

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
        <div className="brand-group">
          <div className="brand-logo">
            <span className="brand-pulse" />
            <h1>home-lab</h1>
          </div>
          <span className="telemetry-badge">
            <span className="telemetry-dot" />
            <span>ONLINE · {allServers.length} NODES</span>
          </span>
        </div>
        <nav className="top-nav">
          <button data-active={topView === 'console'} onClick={() => setTopView('console')}>console</button>
          <button data-active={topView === 'dashboard'} onClick={() => setTopView('dashboard')}>dashboard</button>
          {mediaEnabled && (
            <button data-active={topView === 'media'} onClick={() => setTopView('media')}>media</button>
          )}
          <button data-active={topView === 'jobs'} onClick={() => setTopView('jobs')}>jobs</button>
        </nav>
        <div className="masthead-right">
          <span className="meta">{allServers.length} nodes · {groups.length} groups · {runbooks.length} runbooks</span>
          <a className="signout" href="/api/auth/logout">sign out</a>
        </div>
      </header>

      {topView === 'jobs' ? <JobsView /> : topView === 'dashboard' ? <Dashboard />
        : topView === 'media' ? (
          <MediaView
            // Drill-down lives in the URL query (?movie=/?series=) so refresh +
            // back-button keep the open title — same pattern as server/runbook.
            openMovieId={searchParams.get('movie') ? Number(searchParams.get('movie')) : null}
            openSeriesId={searchParams.get('series') ? Number(searchParams.get('series')) : null}
            onOpenMovie={(id) => updateParams({ movie: String(id), series: null })}
            onOpenSeries={(id) => updateParams({ series: String(id), movie: null })}
            onCloseDetail={() => updateParams({ movie: null, series: null })}
          />
        ) : (
      <div className={`workspace${mode === 'chat' ? ' no-rail' : ''}`}>
        <ServerRail groups={groups} selectedId={serverId} onSelect={selectServer} />

        <main className="stage">
          <nav className="mode-tabs">
            <button data-active={mode === 'runbook'} onClick={() => switchMode('runbook')}>Runbook</button>
            <button data-active={mode === 'shell'}   onClick={() => switchMode('shell')}>Shell</button>
            {aiEnabled && (
              <button data-active={mode === 'chat'} onClick={() => switchMode('chat')}>AI Chat</button>
            )}
          </nav>

          {mode === 'chat' ? (
            serverId ? (
              <ChatSession
                key={serverId}
                target={serverId}
                seedMessage={seedMessage}
              />
            ) : (
              <div className="empty">Select a server to start an AI chat session.</div>
            )
          ) : mode === 'runbook' ? (
            <>
              <div className="stage-head">
                <h2>{runbook?.name ?? 'Select a runbook'}</h2>
                <div className="target">
                  <span className="target-label">target:</span>
                  <b>{selectedServer ? `${selectedServer.user}@${selectedServer.host}` : '—'}</b>
                  {selectedServer && (
                    <button
                      type="button"
                      className="target-copy-btn"
                      onClick={() => navigator.clipboard.writeText(`${selectedServer.user}@${selectedServer.host}`)}
                      title="Copy SSH target"
                    >
                      copy
                    </button>
                  )}
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
                  data-running={isRunLive}
                  disabled={!canRun}
                  onClick={startRun}
                >
                  {isRunLive ? (
                    <span className="run-inner"><span className="run-spinner" /> RUNNING</span>
                  ) : (
                    'RUN'
                  )}
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
                ? <ScriptViewer contents={runbook.contents} title={runbook.name} />
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

          {mode !== 'chat' && (
            <Terminal ref={termRef} onInput={onTerminalInput} onResize={onTerminalResize} />
          )}
        </main>

        {mode !== 'chat' && (
          <RunbookList runbooks={filteredRunbooks} selectedId={runbookId} onSelect={(id) => updateParams({ runbook: id })} />
        )}
      </div>
      )}

      {confirmRun && runbook?.confirm && (
        <ConfirmDialog
          title={`Run ${runbook.name}?`}
          message={runbook.confirm}
          confirmLabel="Run anyway"
          danger
          onCancel={() => setConfirmRun(false)}
          onConfirm={() => { setConfirmRun(false); doRun(); }}
        />
      )}
    </div>
  );
}
