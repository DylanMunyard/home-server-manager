import { useMemo, useState } from 'react';
import type { GroupSummary } from '../shared/api.ts';

type Props = {
  groups: GroupSummary[];
  selectedId: string | null;
  onPick: (id: string) => void;
};

export function ServersScreen({ groups, selectedId, onPick }: Props) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        servers: g.servers.filter((s) =>
          s.name.toLowerCase().includes(q) ||
          s.host.toLowerCase().includes(q) ||
          s.user.toLowerCase().includes(q) ||
          g.name.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.servers.length > 0);
  }, [groups, query]);

  const totalServers = filtered.reduce((n, g) => n + g.servers.length, 0);

  return (
    <>
      <div className="m-search">
        <span className="m-search-icon">/</span>
        <input
          placeholder="search servers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="m-section">
        <span>servers</span>
        <span className="m-count">{totalServers}</span>
      </div>
      <div className="m-content">
        {filtered.length === 0 ? (
          <div className="m-empty">No servers match "{query}"</div>
        ) : filtered.map((g) => (
          <div key={g.id}>
            <div className="m-group">
              <span>
                {g.name.toUpperCase()}
                {g.description && <span className="m-group-sub"> {g.description}</span>}
              </span>
              <span className="m-count">{g.servers.length}</span>
            </div>
            {g.servers.map((s) => (
              <button
                key={s.id}
                className={`m-row ${s.id === selectedId ? 'selected' : 'unsel'}`}
                onClick={() => onPick(s.id)}
              >
                <span className="m-sq" />
                <span className="m-row-body">
                  <span className="m-row-nm">{s.name}</span>
                  <span className="m-row-sub">{s.user}@{s.host}{s.port !== 22 ? `:${s.port}` : ''}</span>
                </span>
                <span className="m-row-tag">{s.authType.toUpperCase()}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
