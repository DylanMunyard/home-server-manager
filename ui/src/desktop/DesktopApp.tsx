import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { UnifiedExplorer } from './UnifiedExplorer.tsx';
import { ServerDetail } from '../servers/ServerDetail.tsx';
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
type LayoutMode = 'split' | 'stacked' | 'focus';

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

  // Top view = pathname
  const topView: TopView = location.pathname.startsWith('/jobs') ? 'jobs'
    : location.pathname.startsWith('/dashboard') ? 'dashboard'
    : location.pathname.startsWith('/media') ? 'media'
    : 'console';

  // Selections in query string
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

  // UI state for the new layout
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerTab, setExplorerTab] = useState<'nodes' | 'runbooks'>('nodes');
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('split');
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState(false);
  const [showSpecs, setShowSpecs] = useState(false);

  // Keyboard shortcut: Ctrl+B or Cmd+B toggles explorer
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setExplorerOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  const selectedGroup = useMemo(() => {
    if (!selectedServer) return null;
    return groups.find((g) => g.id === selectedServer.groupId) ?? null;
  }, [groups, selectedServer]);

  const filteredRunbooks = useMemo(() => {
    return runbooks.filter((rb) => {
      if (!rb.nodes || rb.nodes.length === 0) return true;
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

  const copySshTarget = useCallback(() => {
    if (!selectedServer) return;
    const target = `${selectedServer.user}@${selectedServer.host}${selectedServer.port !== 22 ? ` -p ${selectedServer.port}` : ''}`;
    navigator.clipboard.writeText(target);
    setCopiedTarget(true);
    setTimeout(() => setCopiedTarget(false), 2000);
  }, [selectedServer]);

  // Overall status badge for flight deck
  const currentStatusBadge = useMemo(() => {
    if (mode === 'runbook') {
      return {
        label: runStatusLabel,
        state: runState,
        isLive: isRunLive,
      };
    }
    if (mode === 'shell') {
      return {
        label: shellStatusLabel,
        state: shellState,
        isLive: isShellLive,
      };
    }
    return {
      label: 'ai agent active',
      state: 'idle',
      isLive: false,
    };
  }, [mode, runStatusLabel, runState, isRunLive, shellStatusLabel, shellState, isShellLive]);

  return (
    <div className="cyber-app">
      {/* ── Left Activity Dock (Slim Navigation Rail) ── */}
      <aside className="activity-dock">
        <div className="dock-top">
          <div className="dock-brand" title="home-server-mgr">
            <span className="dock-brand-pulse" />
            <span className="dock-brand-glyph">⬡</span>
          </div>

          <nav className="dock-nav">
            <button
              type="button"
              className={`dock-btn ${topView === 'console' ? 'active' : ''}`}
              onClick={() => setTopView('console')}
              title="Target Operations & Console"
            >
              <span className="dock-icon">&gt;_</span>
              <span className="dock-label">CONSOLE</span>
            </button>

            <button
              type="button"
              className={`dock-btn ${topView === 'dashboard' ? 'active' : ''}`}
              onClick={() => setTopView('dashboard')}
              title="Live Cluster Telemetry"
            >
              <span className="dock-icon">∿</span>
              <span className="dock-label">METRICS</span>
            </button>

            <button
              type="button"
              className={`dock-btn ${topView === 'jobs' ? 'active' : ''}`}
              onClick={() => setTopView('jobs')}
              title="Recurring Jobs & Watchdogs"
            >
              <span className="dock-icon">⟳</span>
              <span className="dock-label">JOBS</span>
            </button>

            {mediaEnabled && (
              <button
                type="button"
                className={`dock-btn ${topView === 'media' ? 'active' : ''}`}
                onClick={() => setTopView('media')}
                title="Media Disk Triage"
              >
                <span className="dock-icon">▷</span>
                <span className="dock-label">MEDIA</span>
              </button>
            )}
          </nav>
        </div>

        <div className="dock-bottom">
          <div className="dock-telemetry" title={`${allServers.length} nodes connected`}>
            <span className="telemetry-core-dot" />
            <span className="telemetry-core-text">{allServers.length}N</span>
          </div>

          {topView === 'console' && (
            <button
              type="button"
              className="dock-toggle-btn"
              onClick={() => setExplorerOpen((prev) => !prev)}
              title={explorerOpen ? 'Hide Explorer (Ctrl+B)' : 'Show Explorer (Ctrl+B)'}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {explorerOpen ? (
                  <path d="M18 6L6 12L18 18" />
                ) : (
                  <path d="M6 6L18 12L6 18" />
                )}
              </svg>
            </button>
          )}

          <a className="dock-signout" href="/api/auth/logout" title="Sign out of command session">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </a>
        </div>
      </aside>

      {/* ── Main Viewport ── */}
      <div className="deck-viewport">
        {topView === 'jobs' ? (
          <div className="fullscreen-view">
            <header className="view-subhead">
              <div className="subhead-left">
                <span className="subhead-badge">AUTOMATION ENGINE</span>
                <h1 className="subhead-title">Recurring Jobs &amp; Watchdogs</h1>
              </div>
              <div className="subhead-meta">
                <span>In-memory scheduler</span>
                <span className="meta-sep">/</span>
                <span>ntfy alert integrations</span>
              </div>
            </header>
            <JobsView />
          </div>
        ) : topView === 'dashboard' ? (
          <div className="fullscreen-view">
            <header className="view-subhead">
              <div className="subhead-left">
                <span className="subhead-badge">LIVE TELEMETRY</span>
                <h1 className="subhead-title">Node Performance &amp; Metrics</h1>
              </div>
              <div className="subhead-meta">
                <span>{allServers.length} monitored nodes</span>
                <span className="meta-sep">/</span>
                <span>Zero-install streaming probe</span>
              </div>
            </header>
            <Dashboard />
          </div>
        ) : topView === 'media' ? (
          <div className="fullscreen-view">
            <header className="view-subhead">
              <div className="subhead-left">
                <span className="subhead-badge">STORAGE TRIAGE</span>
                <h1 className="subhead-title">Media Disk Cleanup</h1>
              </div>
              <div className="subhead-meta">
                <span>Radarr · Sonarr · Plex</span>
              </div>
            </header>
            <MediaView
              openMovieId={searchParams.get('movie') ? Number(searchParams.get('movie')) : null}
              openSeriesId={searchParams.get('series') ? Number(searchParams.get('series')) : null}
              onOpenMovie={(id) => updateParams({ movie: String(id), series: null })}
              onOpenSeries={(id) => updateParams({ series: String(id), movie: null })}
              onCloseDetail={() => updateParams({ movie: null, series: null })}
            />
          </div>
        ) : (
          /* ── CONSOLE WORKSPACE (Dual-Deck / Multi-Pane) ── */
          <div className={`console-workspace ${explorerOpen ? 'with-explorer' : 'no-explorer'}`}>
            {/* Unified Explorer Panel */}
            <UnifiedExplorer
              groups={groups}
              allServers={allServers}
              selectedServerId={serverId}
              onSelectServer={selectServer}
              runbooks={filteredRunbooks}
              selectedRunbookId={runbookId}
              onSelectRunbook={(id) => updateParams({ runbook: id })}
              activeTab={explorerTab}
              onTabChange={setExplorerTab}
              isOpen={explorerOpen}
              onToggleOpen={() => setExplorerOpen((prev) => !prev)}
            />

            {/* Stage Workstation */}
            <main className="deck-stage">
              {/* Flight Deck Header & Quick Control HUD */}
              <header className="flight-deck">
                <div className="flight-left">
                  {/* Server Breadcrumbs & Quick Dropdown Switcher */}
                  <div className="server-crumb-wrap">
                    <button
                      type="button"
                      className="crumb-btn"
                      onClick={() => setQuickSwitcherOpen((prev) => !prev)}
                      title="Click to quickly switch target node"
                    >
                      <span className="crumb-group">{selectedGroup?.name ?? 'group'}</span>
                      <span className="crumb-sep">›</span>
                      <span className="crumb-node">{selectedServer?.name ?? 'select-node'}</span>
                      <span className="crumb-arrow">▼</span>
                    </button>

                    {quickSwitcherOpen && (
                      <div className="quick-switcher-menu">
                        <div className="switcher-head">Switch Target Node</div>
                        <ul className="switcher-list">
                          {allServers.map((s) => (
                            <li
                              key={s.id}
                              className={`switcher-item ${s.id === serverId ? 'active' : ''}`}
                              onClick={() => {
                                selectServer(s.id);
                                setQuickSwitcherOpen(false);
                              }}
                            >
                              <span className="switcher-dot" />
                              <span className="switcher-name">{s.name}</span>
                              <span className="switcher-host">{s.user}@{s.host}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* SSH Target Chip with Copy Button */}
                  {selectedServer && (
                    <div className="target-chip">
                      <span className="target-chip-val">
                        {selectedServer.user}@{selectedServer.host}{selectedServer.port !== 22 ? `:${selectedServer.port}` : ''}
                      </span>
                      <button
                        type="button"
                        className="target-chip-copy"
                        onClick={copySshTarget}
                        title="Copy SSH target command"
                      >
                        {copiedTarget ? '✓' : 'copy'}
                      </button>
                    </div>
                  )}

                  {/* Active Runbook Chip */}
                  {runbook && (
                    <div className="runbook-chip" title={runbook.description || runbook.name}>
                      <span className="chip-glyph">$</span>
                      <span className="chip-name">{runbook.name}</span>
                      <span className="chip-file">{runbook.filename}</span>
                    </div>
                  )}
                </div>

                <div className="flight-right">
                  {/* Live Status Radar */}
                  <div className="radar-status-badge" data-state={currentStatusBadge.state}>
                    <span className={`radar-dot ${currentStatusBadge.isLive ? 'pulse' : ''}`} />
                    <span className="radar-text">{currentStatusBadge.label}</span>
                  </div>

                  {/* Layout Mode Switcher */}
                  <div className="layout-modes">
                    <button
                      type="button"
                      className={`layout-btn ${layoutMode === 'split' ? 'active' : ''}`}
                      onClick={() => setLayoutMode('split')}
                      title="Dual-Deck Split (Side-by-side execution & live terminal)"
                    >
                      <span>◫</span>
                      <span className="layout-tip">SPLIT</span>
                    </button>
                    <button
                      type="button"
                      className={`layout-btn ${layoutMode === 'stacked' ? 'active' : ''}`}
                      onClick={() => setLayoutMode('stacked')}
                      title="Stacked Layout (Studio on top, Terminal below)"
                    >
                      <span>⬒</span>
                      <span className="layout-tip">STACK</span>
                    </button>
                    <button
                      type="button"
                      className={`layout-btn ${layoutMode === 'focus' ? 'active' : ''}`}
                      onClick={() => setLayoutMode('focus')}
                      title="Focus Mode (Full-width Live Terminal)"
                    >
                      <span>⛶</span>
                      <span className="layout-tip">FOCUS</span>
                    </button>
                  </div>
                </div>
              </header>

              {/* Mode ribbon bar */}
              <div className="deck-mode-bar">
                <nav className="mode-ribbon">
                  <button
                    type="button"
                    className={`mode-btn ${mode === 'runbook' ? 'active' : ''}`}
                    onClick={() => switchMode('runbook')}
                  >
                    Runbook Studio
                  </button>
                  <button
                    type="button"
                    className={`mode-btn ${mode === 'shell' ? 'active' : ''}`}
                    onClick={() => switchMode('shell')}
                  >
                    Interactive Shell
                  </button>
                  {aiEnabled && (
                    <button
                      type="button"
                      className={`mode-btn ${mode === 'chat' ? 'active' : ''}`}
                      onClick={() => switchMode('chat')}
                    >
                      AI Copilot
                    </button>
                  )}
                </nav>

                {serverId && (
                  <button
                    type="button"
                    className="specs-toggle-btn"
                    onClick={() => setShowSpecs((prev) => !prev)}
                  >
                    {showSpecs ? 'Hide Node Specs ▲' : 'Node Specs ▼'}
                  </button>
                )}
              </div>

              {/* Collapsible server specs details */}
              {serverId && showSpecs && (
                <div className="specs-drawer">
                  <ServerDetail detail={serverDetail} loading={detailLoading} error={detailError} />
                </div>
              )}

              {/* Workstation Deck Body */}
              <div className={`dual-deck ${layoutMode === 'split' ? 'layout-split' : layoutMode === 'stacked' ? 'layout-stacked' : 'layout-focus'}`}>
                {mode === 'chat' ? (
                  <div className="chat-fullscreen-wrap">
                    {serverId ? (
                      <ChatSession
                        key={serverId}
                        target={serverId}
                        seedMessage={seedMessage}
                      />
                    ) : (
                      <div className="empty">Select a server to start an AI chat session.</div>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Control Deck (Studio / Params / Scripts) */}
                    {layoutMode !== 'focus' && (
                      <div className="control-deck">
                        {mode === 'runbook' ? (
                          <div className="runbook-studio">
                            <div className="studio-card-head">
                              <div className="studio-title-row">
                                <h2>{runbook?.name ?? 'Select a runbook script'}</h2>
                                {runbook && (
                                  <span className="studio-filename-tag">{runbook.filename}</span>
                                )}
                              </div>
                              {runbook?.description && (
                                <p className="studio-desc">{runbook.description}</p>
                              )}
                            </div>

                            {/* Runbook parameter inputs */}
                            <RunbookParams params={params} values={paramValues} onChange={setParamValue} />

                            {/* High-Impact Action Deck */}
                            <div className="studio-actions-bar">
                              <button
                                type="button"
                                data-variant="run"
                                data-running={isRunLive}
                                disabled={!canRun}
                                onClick={startRun}
                              >
                                {isRunLive ? (
                                  <span className="run-inner">
                                    <span className="run-spinner" /> RUNNING
                                  </span>
                                ) : (
                                  'RUN'
                                )}
                              </button>

                              {isRunLive && (
                                <button type="button" className="btn-cancel" onClick={cancelRun}>
                                  Cancel
                                </button>
                              )}

                              <button
                                type="button"
                                className="btn-test-alert"
                                disabled={!runbookId || alertBusy}
                                onClick={sendTestAlert}
                                title="Send a test ntfy alert that simulates this script failing"
                              >
                                {alertBusy ? 'Sending…' : 'Test Alert'}
                              </button>

                              <div className="spacer" />

                              {alertMsg && <span className="action-msg">{alertMsg}</span>}
                            </div>

                            {/* Script Inspection Preview */}
                            {runbook ? (
                              <ScriptViewer contents={runbook.contents} title={runbook.name} />
                            ) : (
                              <div className="empty studio-empty">
                                Select a runbook from the left explorer to configure parameters and preview bash code.
                              </div>
                            )}
                          </div>
                        ) : (
                          /* Shell Mode Controls */
                          <div className="shell-studio">
                            <div className="studio-card-head">
                              <h2>Direct Interactive SSH Terminal</h2>
                              <p className="studio-desc">
                                Full bidirectional TTY session to{' '}
                                <b>{selectedServer ? `${selectedServer.user}@${selectedServer.host}` : 'target host'}</b>.
                              </p>
                            </div>

                            <div className="studio-actions-bar">
                              <button
                                type="button"
                                data-variant="run"
                                disabled={!canConnect}
                                onClick={connectShellNow}
                              >
                                {shellState === 'connected' ? 'Connected' : 'Connect Shell'}
                              </button>
                              {isShellLive && (
                                <button type="button" onClick={disconnectShell}>
                                  Disconnect
                                </button>
                              )}
                              <div className="spacer" />
                              <span className="status" data-state={shellState}>
                                {shellStatusLabel}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Live Terminal Deck */}
                    <div className="terminal-deck">
                      <div className="terminal-deck-header">
                        <div className="term-deck-title">
                          <span className="term-deck-dot" data-state={currentStatusBadge.state} />
                          <span className="term-deck-label">
                            {mode === 'shell' ? 'INTERACTIVE SSH STREAM' : 'RUNBOOK OUTPUT STREAM'}
                          </span>
                          <span className="term-deck-target">
                            {selectedServer ? `${selectedServer.user}@${selectedServer.host}` : 'no target'}
                          </span>
                        </div>

                        <div className="term-deck-controls">
                          <button
                            type="button"
                            className="term-deck-btn"
                            onClick={clearTerm}
                            title="Clear Terminal Buffer"
                          >
                            Clear
                          </button>
                          <button
                            type="button"
                            className="term-deck-btn"
                            onClick={() => termRef.current?.fit()}
                            title="Fit Terminal"
                          >
                            Fit
                          </button>
                          <button
                            type="button"
                            className="term-deck-btn"
                            onClick={() => setLayoutMode((prev) => (prev === 'focus' ? 'split' : 'focus'))}
                            title={layoutMode === 'focus' ? 'Restore Split View' : 'Maximize Terminal'}
                          >
                            {layoutMode === 'focus' ? 'Restore ◫' : 'Maximize ⛶'}
                          </button>
                        </div>
                      </div>

                      <div className="terminal-deck-canvas">
                        <Terminal
                          ref={termRef}
                          onInput={onTerminalInput}
                          onResize={onTerminalResize}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </main>
          </div>
        )}
      </div>

      {confirmRun && runbook?.confirm && (
        <ConfirmDialog
          title={`Run ${runbook.name}?`}
          message={runbook.confirm}
          confirmLabel="Run anyway"
          danger
          onCancel={() => setConfirmRun(false)}
          onConfirm={() => {
            setConfirmRun(false);
            doRun();
          }}
        />
      )}
    </div>
  );
}
