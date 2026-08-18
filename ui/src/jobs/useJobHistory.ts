import { useCallback, useEffect, useState } from 'react';
import { fetchJobHistory, type JobHistoryEntry } from '../shared/api.ts';

// Fetched on demand (History tab only) — not part of the polled Job payload,
// since most sessions never open it and entries can carry full stdout/stderr.
export function useJobHistory(jobId: string | null) {
  const [entries, setEntries] = useState<JobHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!jobId) { setEntries([]); return; }
    setLoading(true);
    setError(null);
    fetchJobHistory(jobId)
      .then(setEntries)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [jobId]);

  useEffect(() => { reload(); }, [reload]);

  return { entries, loading, error, reload };
}
