import { useCallback, useMemo, useState } from 'react';
import { useGroups } from '../servers/useServers.ts';
import { useRunbook, useRunbooks } from '../runbooks/useRunbooks.ts';
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

type View =
  | { kind: 'books' }
  | { kind: 'servers' }
  | { kind: 'jobs' }
  | { kind: 'book-detail';   bookId: string }
  | { kind: 'running';       bookId: string }
  | { kind: 'server-detail'; serverId: string }
  | { kind: 'shell';         serverId: string }
  | { kind: 'job-detail';    jobId: string };

const TAB_OF: Record<View['kind'], MobileTab> = {
  'books':         'books',
  'book-detail':   'books',
  'running':       'books',
  'servers':       'servers',
  'server-detail': 'servers',
  'shell':         'servers',
  'jobs':          'jobs',
  'job-detail':    'jobs',
};

const ROOT_OF: Record<MobileTab, View> = {
  'books':   { kind: 'books' },
  'servers': { kind: 'servers' },
  'jobs':    { kind: 'jobs' },
};

export function MobileApp() {
  const { groups, allServers } = useGroups();
  const { runbooks } = useRunbooks();
  const { jobs, run: runJobNow, runningId } = useJobs();

  const [stack, setStack] = useState<View[]>([{ kind: 'books' }]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const view = stack[stack.length - 1];
  const currentTab = TAB_OF[view.kind];

  const push = useCallback((v: View) => setStack((s) => [...s, v]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const switchTab = useCallback((t: MobileTab) => {
    setStack([ROOT_OF[t]]);
  }, []);

  // For the book-detail screen — need to know the runbook's full content
  const detailBookId = view.kind === 'book-detail' || view.kind === 'running' ? view.bookId : null;
  const runbook = useRunbook(detailBookId);

  // For the job-detail screen — the selected job + its check/remediate runbooks
  const selectedJob = useMemo(
    () => (view.kind === 'job-detail' ? jobs.find((j) => j.id === view.jobId) ?? null : null),
    [jobs, view],
  );
  const jobCheck = useRunbook(selectedJob?.run ?? null);
  const jobRemediate = useRunbook(selectedJob?.then ?? null);

  const target = useMemo(
    () => allServers.find((s) => s.id === targetId) ?? null,
    [allServers, targetId],
  );

  const selectedServer = useMemo(() => {
    if (view.kind === 'server-detail' || view.kind === 'shell') {
      return allServers.find((s) => s.id === view.serverId) ?? null;
    }
    return null;
  }, [allServers, view]);

  const handlePickTarget = useCallback(() => {
    setStack([{ kind: 'servers' }]);
  }, []);

  const handleServerPick = useCallback((id: string) => {
    setReloadKey((k) => k + 1);
    push({ kind: 'server-detail', serverId: id });
  }, [push]);

  const screen = renderScreen();

  return (
    <div className="m-app">
      {renderTopBar()}
      <div className="m-screen-body">{screen}</div>
      {showTabBar(view) && <TabBar active={currentTab} onChange={switchTab} />}
    </div>
  );

  function renderTopBar() {
    switch (view.kind) {
      case 'books':
        return <TopBar signOut meta={`${allServers.length}N · ${groups.length}G · ${runbooks.length}R`} />;
      case 'servers':
        return <TopBar signOut meta={`${allServers.length}N · ${groups.length}G`} />;
      case 'jobs':
        return <TopBar signOut meta={`${jobs.length}J`} />;
      case 'job-detail':
        return <TopBar onBack={back} backLabel="jobs" meta="JOB" />;
      case 'book-detail':
        return <TopBar onBack={back} backLabel="runbooks" meta="RUNBOOK" />;
      case 'running':
        return <TopBar onBack={back} backLabel="back" meta="LIVE" />;
      case 'server-detail':
        return <TopBar onBack={back} backLabel="servers" meta="SERVER" />;
      case 'shell':
        return <TopBar onBack={back} backLabel="back" meta="SHELL" />;
    }
  }

  function renderScreen() {
    switch (view.kind) {
      case 'books':
        return <BooksScreen
          runbooks={runbooks}
          selectedId={null}
          onPick={(id) => push({ kind: 'book-detail', bookId: id })}
        />;
      case 'servers':
        return <ServersScreen
          groups={groups}
          selectedId={targetId}
          onPick={handleServerPick}
        />;
      case 'jobs':
        return <JobsScreen
          jobs={jobs}
          selectedId={null}
          onPick={(id) => push({ kind: 'job-detail', jobId: id })}
        />;
      case 'job-detail':
        if (!selectedJob) { back(); return null; }
        return <JobDetailScreen
          job={selectedJob}
          checkRunbook={jobCheck}
          remediateRunbook={jobRemediate}
          running={selectedJob.state.running || runningId === selectedJob.id}
          onRun={() => runJobNow(selectedJob.id)}
        />;
      case 'book-detail':
        return <BookDetailScreen
          runbook={runbook}
          target={target}
          canRun={!!target && !!runbook}
          onPickTarget={handlePickTarget}
          onRun={() => push({ kind: 'running', bookId: view.bookId })}
        />;
      case 'running':
        if (!target || !runbook) {
          back();
          return null;
        }
        return <RunningScreen
          runbookId={runbook.id}
          runbookName={runbook.name}
          target={target}
          onBack={back}
        />;
      case 'server-detail':
        if (!selectedServer) { back(); return null; }
        return <ServerDetailScreen
          server={selectedServer}
          reloadKey={reloadKey}
          onSelectAsTarget={() => { setTargetId(selectedServer.id); switchTab('books'); }}
          onOpenShell={() => push({ kind: 'shell', serverId: selectedServer.id })}
        />;
      case 'shell':
        if (!selectedServer) { back(); return null; }
        return <ShellScreen target={selectedServer} onBack={back} />;
    }
  }
}

// Hide the bottom tab bar on screens that need the full vertical space —
// running scripts and interactive shells benefit from every pixel.
function showTabBar(v: View): boolean {
  return v.kind !== 'running' && v.kind !== 'shell';
}
