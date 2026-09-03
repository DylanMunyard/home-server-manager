import { useMemo, useState } from 'react';
import type { GroupSummary, RunbookSummary, ServerSummary } from '../shared/api.ts';

type Props = {
  groups: GroupSummary[];
  allServers: ServerSummary[];
  selectedServerId: string | null;
  onSelectServer: (id: string) => void;
  runbooks: RunbookSummary[];
  selectedRunbookId: string | null;
  onSelectRunbook: (id: string) => void;
  activeTab: 'nodes' | 'runbooks';
  onTabChange: (tab: 'nodes' | 'runbooks') => void;
  isOpen: boolean;
  onToggleOpen: () => void;
};

export function UnifiedExplorer({
  groups,
  allServers,
  selectedServerId,
  onSelectServer,
  runbooks,
  selectedRunbookId,
  onSelectRunbook,
  activeTab,
  onTabChange,
  isOpen,
  onToggleOpen,
}: Props) {
  const [nodeSearch, setNodeSearch] = useState('');
  const [bookSearch, setBookSearch] = useState('');

  // Filter servers by query
  const filteredGroups = useMemo(() => {
    if (!nodeSearch.trim()) return groups;
    const q = nodeSearch.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        servers: g.servers.filter(
          (s) =>
            s.id.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q) ||
            s.host.toLowerCase().includes(q) ||
            s.user.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.servers.length > 0);
  }, [groups, nodeSearch]);

  const matchedServerCount = filteredGroups.reduce((n, g) => n + g.servers.length, 0);

  // Filter runbooks by query
  const filteredRunbooks = useMemo(() => {
    if (!bookSearch.trim()) return runbooks;
    const q = bookSearch.toLowerCase();
    return runbooks.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q)),
    );
  }, [runbooks, bookSearch]);

  return (
    <aside className={`unified-explorer ${isOpen ? 'open' : 'collapsed'}`}>
      <div className="explorer-header">
        <div className="explorer-tabs">
          <button
            type="button"
            className={`explorer-tab ${activeTab === 'nodes' ? 'active' : ''}`}
            onClick={() => onTabChange('nodes')}
          >
            <span className="tab-title">Nodes</span>
            <span className="tab-count">{allServers.length}</span>
          </button>
          <button
            type="button"
            className={`explorer-tab ${activeTab === 'runbooks' ? 'active' : ''}`}
            onClick={() => onTabChange('runbooks')}
          >
            <span className="tab-title">Runbooks</span>
            <span className="tab-count">{runbooks.length}</span>
          </button>
        </div>
        <button
          type="button"
          className="explorer-collapse-btn"
          onClick={onToggleOpen}
          title="Collapse Explorer (Ctrl+B)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      <div className="explorer-search">
        {activeTab === 'nodes' ? (
          <div className="search-input-wrap">
            <svg className="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Filter nodes by name, host, user..."
              value={nodeSearch}
              onChange={(e) => setNodeSearch(e.target.value)}
              autoComplete="off"
            />
            {nodeSearch && (
              <button type="button" className="search-clear-btn" onClick={() => setNodeSearch('')}>×</button>
            )}
          </div>
        ) : (
          <div className="search-input-wrap">
            <svg className="search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search scripts & tags..."
              value={bookSearch}
              onChange={(e) => setBookSearch(e.target.value)}
              autoComplete="off"
            />
            {bookSearch && (
              <button type="button" className="search-clear-btn" onClick={() => setBookSearch('')}>×</button>
            )}
          </div>
        )}
      </div>

      <div className="explorer-body">
        {activeTab === 'nodes' ? (
          groups.length === 0 ? (
            <div className="empty">Drop a YAML file in <code>config/servers/</code> to add a group.</div>
          ) : filteredGroups.length === 0 ? (
            <div className="empty">No nodes match "{nodeSearch}"</div>
          ) : (
            filteredGroups.map((g) => (
              <section key={g.id} className="explorer-group">
                <header className="explorer-group-head">
                  <span className="explorer-group-name">{g.name}</span>
                  <span className="explorer-group-badge">{g.servers.length}</span>
                </header>
                <ul className="explorer-list">
                  {g.servers.map((s) => {
                    const isSelected = s.id === selectedServerId;
                    return (
                      <li
                        key={s.id}
                        className={`explorer-row ${isSelected ? 'active' : ''}`}
                        onClick={() => onSelectServer(s.id)}
                      >
                        <span className="node-dot" />
                        <div className="row-content">
                          <div className="node-name">{s.name}</div>
                          <div className="node-target">
                            {s.user}@{s.host}{s.port !== 22 ? `:${s.port}` : ''}
                          </div>
                        </div>
                        <span className="node-auth-tag">{s.authType}</span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )
        ) : (
          runbooks.length === 0 ? (
            <div className="empty">Drop a <code>.sh</code> file in <code>config/scripts/</code> to add a runbook.</div>
          ) : filteredRunbooks.length === 0 ? (
            <div className="empty">No runbooks match "{bookSearch}"</div>
          ) : (
            <ul className="explorer-list">
              {filteredRunbooks.map((r) => {
                const isSelected = r.id === selectedRunbookId;
                return (
                  <li
                    key={r.id}
                    className={`explorer-row ${isSelected ? 'active' : ''}`}
                    onClick={() => onSelectRunbook(r.id)}
                  >
                    <span className="runbook-glyph">$</span>
                    <div className="row-content">
                      <div className="runbook-name">{r.name}</div>
                      {r.description && <div className="runbook-desc">{r.description}</div>}
                    </div>
                    <span className="runbook-filename">{r.filename}</span>
                  </li>
                );
              })}
            </ul>
          )
        )}
      </div>

      <div className="explorer-footer">
        <span className="explorer-footer-text">
          {activeTab === 'nodes'
            ? `${matchedServerCount} of ${allServers.length} nodes active`
            : `${filteredRunbooks.length} of ${runbooks.length} scripts available`}
        </span>
      </div>
    </aside>
  );
}
