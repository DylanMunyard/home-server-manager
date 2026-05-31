import { useMemo, useState } from 'react';
import { useFiles, type BrowserEntry } from './useFiles.ts';

const KB = 1024;
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
function humanSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(KB)));
  const v = bytes / KB ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${UNITS[i]}`;
}

function ago(mtime: number): string {
  if (!mtime) return '';
  const days = Math.floor((Date.now() / 1000 - mtime) / 86400);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

type SortKey = 'size' | 'name' | 'mtime';

// Breadcrumb: each path segment is a button that jumps to that ancestor.
function Crumbs({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const segs = path.split('/').filter(Boolean);
  let acc = '';
  return (
    <nav className="fb-crumbs">
      <button className="fb-crumb" onClick={() => onNavigate('/')}>/</button>
      {segs.map((s, i) => {
        acc += `/${s}`;
        const target = acc;
        const last = i === segs.length - 1;
        return (
          <span key={target} className="fb-crumb-seg">
            <button className="fb-crumb" data-current={last} onClick={() => onNavigate(target)}>{s}</button>
            {!last && <span className="fb-crumb-sep">/</span>}
          </span>
        );
      })}
    </nav>
  );
}

function ConfirmDelete({ entry, busy, error, onCancel, onConfirm }: {
  entry: BrowserEntry; busy: boolean; error: string | null;
  onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="fb-modal-back" onClick={onCancel}>
      <div className="fb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fb-modal-h">delete {entry.type === 'dir' ? 'folder' : 'file'}?</div>
        <code className="fb-modal-path">{entry.path}</code>
        <div className="fb-modal-meta">{entry.type === 'dir' && entry.pending ? 'size pending' : humanSize(entry.size)}</div>
        <p className="fb-modal-warn">This runs <code>rm -rf</code> over SSH. It cannot be undone.</p>
        {error && <div className="fb-modal-err">{error}</div>}
        <div className="fb-modal-actions">
          <button className="fb-btn" onClick={onCancel} disabled={busy}>cancel</button>
          <button className="fb-btn fb-btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'deleting…' : 'delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// The size-first file browser for one server, rooted at a disk mount. Drill into
// folders, sort by size/name/age, and delete with a confirm. Folder sizes scan
// automatically on open (streamed); Cancel stops a slow scan but keeps whatever
// landed. Rendered as a sub-view of the dashboard (both shells); native scroll.
export function FileBrowser({ server, serverName, initialPath, onClose }: {
  server: string; serverName: string; initialPath: string; onClose: () => void;
}) {
  const { path, parent, entries, loading, scanning, error, navigate, cancel, remove } = useFiles(server, initialPath);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'size', desc: true });
  const [pending, setPending] = useState<BrowserEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const total = useMemo(() => entries.reduce((a, e) => a + e.size, 0), [entries]);

  const sorted = useMemo(() => {
    const arr = [...entries];
    arr.sort((a, b) => {
      let d = 0;
      if (sort.key === 'size') d = a.size - b.size;
      else if (sort.key === 'name') d = a.name.localeCompare(b.name);
      else d = a.mtime - b.mtime;
      return sort.desc ? -d : d;
    });
    return arr;
  }, [entries, sort]);

  const setSortKey = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' }));

  const confirmDelete = async () => {
    if (!pending) return;
    setDeleteBusy(true);
    setDeleteErr(null);
    const res = await remove(pending.path);
    setDeleteBusy(false);
    if (res.ok) setPending(null);
    else setDeleteErr(res.error ?? 'delete failed');
  };

  const arrow = (key: SortKey) => (sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : '');

  return (
    <div className="fbrowser">
      <div className="fb-bar">
        <button className="fb-back" onClick={onClose}>← dashboard</button>
        <div className="fb-id">
          <b>{serverName}</b>
          <Crumbs path={path} onNavigate={navigate} />
        </div>
      </div>

      <div className="fb-sort">
        <button className="fb-sortbtn" data-on={sort.key === 'size'} onClick={() => setSortKey('size')}>size{arrow('size')}</button>
        <button className="fb-sortbtn" data-on={sort.key === 'name'} onClick={() => setSortKey('name')}>name{arrow('name')}</button>
        <button className="fb-sortbtn" data-on={sort.key === 'mtime'} onClick={() => setSortKey('mtime')}>modified{arrow('mtime')}</button>
        {scanning && !loading && (
          <button className="fb-cancel" onClick={cancel} title="Stop sizing folders (keeps what's measured so far)">cancel scan</button>
        )}
        <span className="fb-total">
          {loading ? 'listing…'
            : scanning ? `sizing folders… · ${entries.length} items`
            : `${entries.length} items · ${humanSize(total)}`}
        </span>
      </div>

      {error && <div className="fb-msg fb-msg-err">{error}</div>}

      <div className="fb-list">
        {parent !== null && (
          <button className="fb-row fb-row-up" onClick={() => navigate(parent)}>
            <span className="fb-name">../</span>
          </button>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="fb-msg">empty directory</div>
        )}

        {sorted.map((e) => {
          const p = total > 0 ? (e.size / total) * 100 : 0;
          const isDir = e.type === 'dir';
          // Dir size: "…" while its du is in flight, "—" if the scan ended/was
          // cancelled before it was measured, otherwise the real figure.
          const sizeText = e.pending ? '…'
            : (isDir && !e.measured) ? '—'
            : humanSize(e.size);
          return (
            <div className="fb-row" key={e.path} data-type={e.type}>
              <button
                className="fb-row-main"
                onClick={() => isDir && navigate(e.path)}
                disabled={!isDir}
                title={isDir ? 'open folder' : e.path}
              >
                <span className="fb-name">{isDir ? `${e.name}/` : e.name}</span>
                <span className="fb-bar-track">
                  <span className="fb-bar-fill" style={{ width: `${e.measured ? Math.min(100, p) : 0}%` }} />
                </span>
                <span className="fb-size" data-dim={!e.measured}>{sizeText}</span>
                <span className="fb-age">{ago(e.mtime)}</span>
              </button>
              <button
                className="fb-del"
                title={`delete ${e.name}`}
                onClick={() => { setPending(e); setDeleteErr(null); }}
              >✕</button>
            </div>
          );
        })}
      </div>

      {pending && (
        <ConfirmDelete
          entry={pending}
          busy={deleteBusy}
          error={deleteErr}
          onCancel={() => !deleteBusy && setPending(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
