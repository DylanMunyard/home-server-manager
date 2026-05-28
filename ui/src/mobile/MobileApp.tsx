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

type View =
  | { kind: 'books' }
  | { kind: 'servers' }
  | { kind: 'book-detail';   bookId: string }
  | { kind: 'running';       bookId: string }
  | { kind: 'server-detail'; serverId: string }
  | { kind: 'shell';         serverId: string };

const TAB_OF: Record<View['kind'], MobileTab> = {
  'books':         'books',
  'book-detail':   'books',
  'running':       'books',
  'servers':       'servers',
  'server-detail': 'servers',
  'shell':         'servers',
};

export function MobileApp() {
  const { groups, allServers } = useGroups();
  const { runbooks } = useRunbooks();

  const [stack, setStack] = useState<View[]>([{ kind: 'books' }]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const view = stack[stack.length - 1];
  const currentTab = TAB_OF[view.kind];

  const push = useCallback((v: View) => setStack((s) => [...s, v]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const switchTab = useCallback((t: MobileTab) => {
    setStack([{ kind: t === 'books' ? 'books' : 'servers' }]);
  }, []);

  // For the book-detail screen — need to know the runbook's full content
  const detailBookId = view.kind === 'book-detail' || view.kind === 'running' ? view.bookId : null;
  const runbook = useRunbook(detailBookId);

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
        return <TopBar meta={`${allServers.length}N · ${groups.length}G · ${runbooks.length}R`} />;
      case 'servers':
        return <TopBar meta={`${allServers.length}N · ${groups.length}G`} />;
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
