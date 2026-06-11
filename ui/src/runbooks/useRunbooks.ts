import { useEffect, useState } from 'react';
import { fetchRunbook, fetchRunbooks, type Runbook, type RunbookSummary } from '../shared/api.ts';

export function useRunbooks() {
  const [runbooks, setRunbooks] = useState<RunbookSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRunbooks().then(setRunbooks).catch((e: Error) => setError(e.message));
  }, []);

  return { runbooks, error };
}

// Full runbooks for a list of ids (e.g. a job's `then` chain), keyed by id.
// Entries appear as they load; a missing id just stays absent (→ null).
export function useRunbookMap(ids: string[]): Record<string, Runbook | null> {
  const [map, setMap] = useState<Record<string, Runbook | null>>({});
  const key = ids.join('\n');
  useEffect(() => {
    setMap({});
    let cancelled = false;
    for (const id of key ? key.split('\n') : []) {
      fetchRunbook(id)
        .then((r) => { if (!cancelled) setMap((m) => ({ ...m, [id]: r })); })
        .catch(() => { if (!cancelled) setMap((m) => ({ ...m, [id]: null })); });
    }
    return () => { cancelled = true; };
  }, [key]);
  return map;
}

export function useRunbook(id: string | null) {
  const [runbook, setRunbook] = useState<Runbook | null>(null);

  useEffect(() => {
    if (!id) { setRunbook(null); return; }
    let cancelled = false;
    fetchRunbook(id).then((r) => { if (!cancelled) setRunbook(r); });
    return () => { cancelled = true; };
  }, [id]);

  return runbook;
}
