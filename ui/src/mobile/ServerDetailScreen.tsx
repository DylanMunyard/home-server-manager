import { useServerDetail } from '../servers/useServers.ts';
import type { ServerSummary } from '../shared/api.ts';

type Props = {
  server: ServerSummary;
  reloadKey: number;
  onOpenShell: () => void;
  onSelectAsTarget: () => void;
};

export function ServerDetailScreen({ server, reloadKey, onOpenShell, onSelectAsTarget }: Props) {
  const { detail, loading, error } = useServerDetail(server.id, reloadKey);

  const rows: Array<[string, string]> = [
    ['id',     server.id],
    ['name',   server.name],
    ['host',   `${server.host}${server.port !== 22 ? `:${server.port}` : ''}`],
    ['user',   server.user],
    ['auth',   server.authType],
  ];
  if (detail) {
    if (detail.authType === 'key') {
      rows.push(['key',        detail.rawKeyPath ?? '—']);
      rows.push(['resolved',   detail.keyPath ?? '—']);
      rows.push(['passphrase', detail.passphraseSet ? 'set' : '—']);
    } else {
      rows.push(['password',   detail.passwordSet ? 'set' : '—']);
    }
    if (detail.groupDescription) rows.push(['group', `${detail.groupName} — ${detail.groupDescription}`]);
    else rows.push(['group', detail.groupName]);
  }

  return (
    <>
      <div className="m-dhead">
        <div className="m-dhead-ttl">{server.name}</div>
        <div className="m-dhead-desc">{server.user}@{server.host}</div>
        <div className="m-dhead-target">
          <span className="m-chip key">{server.authType}</span>
        </div>
      </div>

      <div className="m-content">
        {error && <div className="m-empty">error · {error}</div>}
        {!error && loading && !detail && <div className="m-empty">loading…</div>}
        {!error && (
          <div className={loading ? 'm-props reloading' : 'm-props'}>
            {rows.map(([k, v]) => (
              <div className="m-prop" key={k}>
                <span className="m-prop-k">{k}</span>
                <span className="m-prop-v">{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="m-actionbar two">
        <button className="m-run-btn outline small" onClick={onSelectAsTarget}>USE AS TARGET</button>
        <button className="m-run-btn" onClick={onOpenShell}>SHELL ▸</button>
      </div>
    </>
  );
}
