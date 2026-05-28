import type { ServerDetail as Detail } from '../shared/api.ts';

type Props = { detail: Detail | null; loading: boolean; error: string | null };

export function ServerDetail({ detail, loading, error }: Props) {
  if (error)   return <div className="detail detail-msg">error · {error}</div>;
  if (loading && !detail) return <div className="detail detail-msg">loading…</div>;
  if (!detail) return null;

  const rows: Array<[string, React.ReactNode]> = [
    ['id',       detail.id],
    ['group',    detail.groupDescription ? `${detail.groupName} — ${detail.groupDescription}` : detail.groupName],
    ['name',     detail.name],
    ['host',     `${detail.host}${detail.port !== 22 ? `:${detail.port}` : ''}`],
    ['port',     detail.port],
    ['user',     detail.user],
    ['auth',     detail.authType],
  ];
  if (detail.authType === 'key') {
    rows.push(['key',        detail.rawKeyPath ?? '—']);
    rows.push(['resolved',   detail.keyPath ?? '—']);
    rows.push(['passphrase', detail.passphraseSet ? 'set' : '—']);
  } else {
    rows.push(['password',   detail.passwordSet ? 'set' : '—']);
  }

  return (
    <dl className={`detail ${loading ? 'detail-reloading' : ''}`}>
      {rows.map(([k, v]) => (
        <div className="detail-row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
