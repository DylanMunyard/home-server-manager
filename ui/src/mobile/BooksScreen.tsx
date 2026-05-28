import { useMemo, useState } from 'react';
import type { RunbookSummary } from '../shared/api.ts';

type Props = {
  runbooks: RunbookSummary[];
  selectedId: string | null;
  onPick: (id: string) => void;
};

export function BooksScreen({ runbooks, selectedId, onPick }: Props) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return runbooks;
    return runbooks.filter((r) =>
      r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
    );
  }, [runbooks, query]);

  return (
    <>
      <div className="m-search">
        <span className="m-search-icon">/</span>
        <input
          placeholder="search runbooks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="m-section">
        <span>runbooks</span>
        <span className="m-count">{filtered.length}</span>
      </div>
      <div className="m-content">
        {filtered.length === 0 ? (
          <div className="m-empty">
            {runbooks.length === 0
              ? <>Drop a <code>.sh</code> file in <code>config/scripts/</code></>
              : <>No runbooks match "{query}"</>}
          </div>
        ) : filtered.map((r) => (
          <button
            key={r.id}
            className={`m-row ${r.id === selectedId ? 'selected' : 'unsel'}`}
            onClick={() => onPick(r.id)}
          >
            <span className="m-sq" />
            <span className="m-row-body">
              <span className="m-row-nm">{r.name}</span>
              {r.description && <span className="m-row-sub">{r.description}</span>}
            </span>
            <span className="m-row-tag">SH</span>
          </button>
        ))}
      </div>
    </>
  );
}
