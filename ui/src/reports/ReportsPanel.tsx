import { useState } from 'react';
import { reportUrl, type Report } from '../shared/api.ts';
import { useReports } from './useReports.ts';

function ago(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 90) return `${Math.round(secs)}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function size(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** repo #pr · branch · sha — whatever CI actually sent, in one line. */
function provenance(r: Report): string {
  return [
    r.repo && r.pr ? `${r.repo} #${r.pr}` : r.repo,
    r.branch,
    r.sha?.slice(0, 7),
  ].filter(Boolean).join(' · ');
}

/**
 * E2E reports CI has pushed up for this node (dashboard node detail).
 *
 * Renders nothing at all when the node has none — most nodes never receive a
 * report, and an empty "reports" heading on every detail view is just noise.
 *
 * The report opens in a new tab straight at the API's static route rather than
 * in an iframe: it's a full-page app that wants the whole viewport, and being
 * same-origin means the session cookie authenticates it with no extra work.
 */
export function ReportsPanel({ serverId }: { serverId: string }) {
  const { reports, loading, error, remove } = useReports(serverId);
  const [busy, setBusy] = useState<string | null>(null);

  if (loading || (!reports.length && !error)) return null;

  const drop = async (id: string) => {
    setBusy(id);
    try {
      await remove(id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="nd-reports">
      <header className="nd-inspect-h">
        <span className="ndchart-title">e2e reports</span>
        {error && <span className="nd-reports-err">{error}</span>}
      </header>

      {reports.map((r) => (
        <div className="nd-report" key={r.id}>
          <span className="nd-report-status" data-status={r.status}>{r.status}</span>
          <div className="nd-report-meta">
            <a className="nd-report-open" href={reportUrl(r.id)} target="_blank" rel="noreferrer">
              {provenance(r) || r.id}
            </a>
            <span className="nd-report-sub">
              {ago(r.createdAt)} · {size(r.bytes)}
              {r.runUrl && <> · <a className="nd-report-ci" href={r.runUrl} target="_blank" rel="noreferrer">ci run</a></>}
            </span>
          </div>
          <button
            className="nd-inspect-btn"
            disabled={busy === r.id}
            onClick={() => void drop(r.id)}
            title="delete this report"
          >
            {busy === r.id ? '…' : 'delete'}
          </button>
        </div>
      ))}
    </section>
  );
}
