import type { RunbookSummary } from '../shared/api.ts';

type Props = {
  runbooks: RunbookSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function RunbookList({ runbooks, selectedId, onSelect }: Props) {
  return (
    <aside className="rail-right">
      <div className="panel-h">
        <span>Runbooks</span>
        <span className="count">{runbooks.length}</span>
      </div>
      <div className="panel-body">
        {runbooks.length === 0 ? (
          <div className="empty">Drop a <code>.sh</code> file in <code>config/scripts/</code> to add a runbook.</div>
        ) : (
          <ul className="list">
            {runbooks.map((r) => (
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
