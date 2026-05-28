import type { GroupSummary } from '../shared/api.ts';

type Props = {
  groups: GroupSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function ServerRail({ groups, selectedId, onSelect }: Props) {
  const totalServers = groups.reduce((n, g) => n + g.servers.length, 0);

  return (
    <aside className="rail-left">
      <div className="panel-h">
        <span>Servers</span>
        <span className="count">{totalServers}</span>
      </div>
      <div className="panel-body">
        {groups.length === 0 ? (
          <div className="empty">Drop a YAML file in <code>config/servers/</code> to add a group.</div>
        ) : (
          groups.map((g) => (
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
