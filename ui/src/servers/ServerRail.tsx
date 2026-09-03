import { useMemo, useState } from 'react';
import type { GroupSummary } from '../shared/api.ts';

type Props = {
  groups: GroupSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function ServerRail({ groups, selectedId, onSelect }: Props) {
  const [search, setSearch] = useState('');
  const totalServers = groups.reduce((n, g) => n + g.servers.length, 0);

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
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
  }, [groups, search]);

  const matchedCount = filteredGroups.reduce((n, g) => n + g.servers.length, 0);

  return (
    <aside className="rail-left">
      <div className="panel-h">
        <span>Servers</span>
        <span className="count">{search.trim() ? `${matchedCount}/${totalServers}` : totalServers}</span>
      </div>
      <div className="panel-search">
        <input
          type="text"
          placeholder="Filter nodes..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="panel-body">
        {groups.length === 0 ? (
          <div className="empty">Drop a YAML file in <code>config/servers/</code> to add a group.</div>
        ) : filteredGroups.length === 0 ? (
          <div className="empty">No nodes match "{search}"</div>
        ) : (
          filteredGroups.map((g) => (
            <section key={g.id} className="group">
              <header className="group-h">
                <span className="group-name">{g.name}</span>
                <span className="group-count">{g.servers.length}</span>
              </header>
              <ul className="list">
                {g.servers.map((s) => (
                  <li
                    key={s.id}
                    className={`list-row ${s.id === selectedId ? 'active' : ''}`}
                    onClick={() => onSelect(s.id)}
                  >
                    <span className="dot" />
                    <span>
                      <div className="name">{s.name}</div>
                      <div className="sub">{s.user}@{s.host}{s.port !== 22 ? `:${s.port}` : ''}</div>
                    </span>
                    <span className="right">{s.authType}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
