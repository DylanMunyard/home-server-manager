import { useCallback, useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useGroups } from '../servers/useServers.ts';
import { useRunbook, useRunbooks } from '../runbooks/useRunbooks.ts';
import { useRunbookParams } from '../runbooks/useRunbookParams.ts';
import { TopBar } from './TopBar.tsx';
import { TabBar, type MobileTab } from './TabBar.tsx';
import { BooksScreen } from './BooksScreen.tsx';
import { BookDetailScreen } from './BookDetailScreen.tsx';
import { RunningScreen } from './RunningScreen.tsx';
import { ServersScreen } from './ServersScreen.tsx';
import { ServerDetailScreen } from './ServerDetailScreen.tsx';
import { ShellScreen } from './ShellScreen.tsx';
import { JobsScreen } from './JobsScreen.tsx';
import { JobDetailScreen } from './JobDetailScreen.tsx';
import { useJobs } from '../jobs/useJobs.ts';

const TARGET_KEY = 'm.targetId';

// What tab does this URL belong to? Drives the bottom TabBar highlight.
function tabFromPath(pathname: string): MobileTab {
  if (pathname.startsWith('/m/servers')) return 'servers';
  if (pathname.startsWith('/m/jobs')) return 'jobs';
  return 'books';
}

// Screens that need every pixel — hide the bottom tab bar.
function fullscreenPath(pathname: string): boolean {
  return /\/run$/.test(pathname) || /\/shell$/.test(pathname);
}

export function MobileApp() {
  const { groups, allServers } = useGroups();
  const { runbooks } = useRunbooks();
  const { jobs, run: runJobNow, runningId } = useJobs();
  const navigate = useNavigate();
  const location = useLocation();

  // Sticky "which server am I going to run a runbook against?" — survives
  // refresh via localStorage so a deep-link to /m/books/foo still has a target.
  const [targetId, setTargetIdState] = useState<string | null>(() => {
    try { return localStorage.getItem(TARGET_KEY); } catch { return null; }
  });
  const setTargetId = useCallback((id: string | null) => {
    setTargetIdState(id);
    try { id ? localStorage.setItem(TARGET_KEY, id) : localStorage.removeItem(TARGET_KEY); } catch {}
  }, []);
  const [reloadKey, setReloadKey] = useState(0);

  const target = useMemo(
    () => allServers.find((s) => s.id === targetId) ?? null,
    [allServers, targetId],
  );

  const currentTab = tabFromPath(location.pathname);
  const switchTab = useCallback((t: MobileTab) => navigate(`/m/${t}`), [navigate]);

  return (
    <div className="m-app">
      <Routes>
        <Route path="/" element={<Navigate to="/m/books" replace />} />
        <Route path="/m" element={<Navigate to="/m/books" replace />} />

        {/* BOOKS */}
        <Route path="/m/books" element={
          <Frame top={<TopBar signOut meta={`${allServers.length}N · ${groups.length}G · ${runbooks.length}R`} />}>
            <BooksScreen
              runbooks={runbooks}
              selectedId={null}
              onPick={(id) => navigate(`/m/books/${id}`)}
            />
          </Frame>
        } />
        <Route path="/m/books/:bookId" element={
          <BookDetailRoute
            target={target}
            onPickTarget={() => navigate('/m/servers')}
          />
        } />
        <Route path="/m/books/:bookId/run" element={
          <RunningRoute target={target} />
        } />

        {/* SERVERS */}
        <Route path="/m/servers" element={
          <Frame top={<TopBar signOut meta={`${allServers.length}N · ${groups.length}G`} />}>
            <ServersScreen
              groups={groups}
              selectedId={targetId}
              onPick={(id) => {
                setReloadKey((k) => k + 1);
                const [g, s] = id.split('/');
                navigate(`/m/servers/${g}/${s}`);
              }}
            />
          </Frame>
        } />
        <Route path="/m/servers/:groupId/:serverId" element={
          <ServerDetailRoute
            allServers={allServers}
            reloadKey={reloadKey}
            onSelectAsTarget={(id) => { setTargetId(id); navigate('/m/books'); }}
            onOpenShell={(g, s) => navigate(`/m/servers/${g}/${s}/shell`)}
          />
        } />
        <Route path="/m/servers/:groupId/:serverId/shell" element={
          <ShellRoute allServers={allServers} />
        } />

        {/* JOBS */}
        <Route path="/m/jobs" element={
          <Frame top={<TopBar signOut meta={`${jobs.length}J`} />}>
            <JobsScreen
              jobs={jobs}
              selectedId={null}
              onPick={(id) => navigate(`/m/jobs/${id}`)}
            />
          </Frame>
        } />
        <Route path="/m/jobs/:jobId" element={
          <JobDetailRoute jobs={jobs} runningId={runningId} runJob={runJobNow} />
        } />

        <Route path="*" element={<Navigate to="/m/books" replace />} />
      </Routes>

      {!fullscreenPath(location.pathname) && <TabBar active={currentTab} onChange={switchTab} />}
    </div>
  );
}

function Frame({ top, children }: { top: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      {top}
      <div className="m-screen-body">{children}</div>
    </>
  );
}

function BookDetailRoute({ target, onPickTarget }: { target: ReturnType<typeof useGroups>['allServers'][number] | null; onPickTarget: () => void }) {
  const { bookId } = useParams();
  const navigate = useNavigate();
  const runbook = useRunbook(bookId ?? null);
  const { params, values, setValue, complete } = useRunbookParams(runbook);
  return (
    <>
      <TopBar onBack={() => navigate('/m/books')} backLabel="runbooks" meta="RUNBOOK" />
      <div className="m-screen-body">
        <BookDetailScreen
          runbook={runbook}
          target={target}
          params={params}
          values={values}
          onParamChange={setValue}
          canRun={!!target && !!runbook && complete}
          onPickTarget={onPickTarget}
          // Carry the filled values to the run screen via router state (no global
          // store). A refresh on /run loses them and falls back to declared defaults.
          onRun={() => navigate(`/m/books/${bookId}/run`, { state: { params: values } })}
        />
      </div>
    </>
  );
}

function RunningRoute({ target }: { target: ReturnType<typeof useGroups>['allServers'][number] | null }) {
  const { bookId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const runbook = useRunbook(bookId ?? null);
  const params = (location.state as { params?: Record<string, string> } | null)?.params;
  // Guard: a refresh on /run with no sticky target → bounce to detail screen
  // (which prompts the user to pick one). Same idea for an unknown runbook.
  useEffect(() => {
    if (!runbook && bookId) { /* still loading */ return; }
    if (!target) navigate(`/m/books/${bookId}`, { replace: true });
  }, [target, runbook, bookId, navigate]);
  if (!target || !runbook) return null;
  return (
    <>
      <TopBar onBack={() => navigate(-1)} backLabel="back" meta="LIVE" />
      <div className="m-screen-body">
        <RunningScreen
          runbookId={runbook.id}
          runbookName={runbook.name}
          target={target}
          params={params}
          onBack={() => navigate(-1)}
        />
      </div>
    </>
  );
}

function ServerDetailRoute({ allServers, reloadKey, onSelectAsTarget, onOpenShell }: {
  allServers: ReturnType<typeof useGroups>['allServers'];
  reloadKey: number;
  onSelectAsTarget: (id: string) => void;
  onOpenShell: (g: string, s: string) => void;
}) {
  const { groupId, serverId } = useParams();
  const navigate = useNavigate();
  const id = `${groupId}/${serverId}`;
  const server = allServers.find((s) => s.id === id) ?? null;
  if (!server) return <Navigate to="/m/servers" replace />;
  return (
    <>
      <TopBar onBack={() => navigate('/m/servers')} backLabel="servers" meta="SERVER" />
      <div className="m-screen-body">
        <ServerDetailScreen
          server={server}
          reloadKey={reloadKey}
          onSelectAsTarget={() => onSelectAsTarget(server.id)}
          onOpenShell={() => onOpenShell(groupId!, serverId!)}
        />
      </div>
    </>
  );
}

function ShellRoute({ allServers }: { allServers: ReturnType<typeof useGroups>['allServers'] }) {
  const { groupId, serverId } = useParams();
  const navigate = useNavigate();
  const id = `${groupId}/${serverId}`;
  const server = allServers.find((s) => s.id === id) ?? null;
  if (!server) return <Navigate to="/m/servers" replace />;
  return (
    <>
      <TopBar onBack={() => navigate(-1)} backLabel="back" meta="SHELL" />
      <div className="m-screen-body">
        <ShellScreen target={server} onBack={() => navigate(-1)} />
      </div>
    </>
  );
}

function JobDetailRoute({ jobs, runningId, runJob }: {
  jobs: ReturnType<typeof useJobs>['jobs'];
  runningId: string | null;
  runJob: (id: string) => Promise<unknown>;
}) {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const job = jobs.find((j) => j.id === jobId) ?? null;
  const jobCheck = useRunbook(job?.run ?? null);
  const jobRemediate = useRunbook(job?.then ?? null);
  if (!job) return <Navigate to="/m/jobs" replace />;
  return (
    <>
      <TopBar onBack={() => navigate('/m/jobs')} backLabel="jobs" meta="JOB" />
      <div className="m-screen-body">
        <JobDetailScreen
          job={job}
          checkRunbook={jobCheck}
          remediateRunbook={jobRemediate}
          running={job.state.running || runningId === job.id}
          onRun={() => runJob(job.id)}
        />
      </div>
    </>
  );
}
