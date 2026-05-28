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
