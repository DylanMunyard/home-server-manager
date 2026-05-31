import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { deleteFile, type FileEntry, type FilesEvent } from '../shared/api.ts';

// `measured` = the folder's recursive size has arrived (always true for files).
// `pending` = a dir still being sized (scan in flight, no size event yet).
export type BrowserEntry = FileEntry & { measured: boolean; pending: boolean };

export type FilesState = {
  path: string;
  parent: string | null;
  entries: BrowserEntry[];
  loading: boolean;     // waiting for the initial listing
  scanning: boolean;    // folder-size pass still in flight
  error: string | null;
  navigate: (path: string) => void;
  cancel: () => void;   // stop the size pass (keeps entries + sizes already in)
  refresh: () => void;
  remove: (path: string) => Promise<{ ok: boolean; error?: string }>;
};

// Streams a directory listing over /ws/files/list: the children arrive at once,
// then each folder's recursive size streams in. Sizing runs automatically on
// open; `cancel()` closes the socket (the server SIGTERMs the remote `du`),
// keeping whatever already landed. Mirrors useMetrics' WS handling.
export function useFiles(server: string, initialPath: string): FilesState {
  const [path, setPath] = useState(initialPath);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mutated as events stream in; `force` re-renders. Folder counts are small, so
  // a render per event is fine.
  const entriesRef = useRef<Map<string, FileEntry>>(new Map());
  const measuredRef = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    entriesRef.current = new Map();
    measuredRef.current = new Set();
    setParent(null);
    setLoading(true);
    setDone(false);
    setError(null);

    let closed = false;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws/files/list`
      + `?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      let e: FilesEvent;
      try { e = JSON.parse(ev.data) as FilesEvent; } catch { return; }
      switch (e.type) {
        case 'meta': setParent(e.parent); break;
        case 'entry': entriesRef.current.set(e.entry.path, e.entry); setLoading(false); force(); break;
        case 'size': {
          const cur = entriesRef.current.get(e.path);
          if (cur) entriesRef.current.set(e.path, { ...cur, size: e.size });
          measuredRef.current.add(e.path);
          force();
          break;
        }
        case 'done': setDone(true); setLoading(false); break;
        case 'error': setError(e.message); setLoading(false); setDone(true); break;
      }
    };
    ws.onclose = () => { if (!closed) setDone(true); };

    return () => { closed = true; ws.close(); };
  }, [server, path, reloadNonce]);

  const navigate = useCallback((p: string) => setPath(p), []);
  const cancel = useCallback(() => { wsRef.current?.close(); setDone(true); }, []);
  const refresh = useCallback(() => setReloadNonce((n) => n + 1), []);
  const remove = useCallback(async (target: string) => {
    const res = await deleteFile(server, target);
    if (res.ok) refresh();
    return res;
  }, [server, refresh]);

  const scanning = !done;
  const entries: BrowserEntry[] = [...entriesRef.current.values()].map((e) => {
    const measured = e.type !== 'dir' || measuredRef.current.has(e.path);
    return { ...e, measured, pending: e.type === 'dir' && scanning && !measured };
  });

  return { path, parent, entries, loading, scanning, error, navigate, cancel, refresh, remove };
}
