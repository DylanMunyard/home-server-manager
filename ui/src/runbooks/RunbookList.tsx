import { useMemo, useState } from 'react';
import type { RunbookSummary } from '../shared/api.ts';

type Props = {
  runbooks: RunbookSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function RunbookList({ runbooks, selectedId, onSelect }: Props) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return runbooks;
    const q = search.toLowerCase();
    return runbooks.filter((r) => 
      r.id.toLowerCase().includes(q) || 
      r.name.toLowerCase().includes(q) || 
      (r.description && r.description.toLowerCase().includes(q))
    );
  }, [runbooks, search]);

  return (
    <aside className="rail-right">
      <div className="panel-h">
        <span>Runbooks</span>
        <span className="count">{filtered.length}</span>
      </div>
      <div className="panel-search">
        <input 
          type="text" 
          placeholder="Search runbooks..." 
          value={search} 
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="panel-body">
        {runbooks.length === 0 ? (
          <div className="empty">Drop a <code>.sh</code> file in <code>config/scripts/</code> to add a runbook.</div>
        ) : filtered.length === 0 ? (
          <div className="empty">No runbooks match "{search}"</div>
        ) : (
          <ul className="list">
            {filtered.map((r) => (
              <li
                key={r.id}
                className={`list-row ${r.id === selectedId ? 'active' : ''}`}
                onClick={() => onSelect(r.id)}
              >
                <span className="dot" />
                <span>
                  <div className="name">{r.name}</div>
                  {r.description && <div className="sub">{r.description}</div>}
                </span>
                <span className="right">{r.filename}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
