import { useCallback, useEffect, useState } from 'react';
import { deleteReport, fetchReports, type Report } from '../shared/api.ts';

/**
 * Reports CI has pushed up for one node. A plain fetch on mount — unlike the
 * metrics/k8s panels there's nothing live here: a report only appears when a
 * CI run fails, which is minutes apart at best. `reload` covers the case where
 * you're already looking at the node when the ntfy alert lands.
 */
export function useReports(nodeId: string) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setReports(await fetchReports(nodeId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchReports(nodeId)
      .then((rs) => { if (alive) { setReports(rs); setError(null); } })
      .catch((e: Error) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [nodeId]);

  // Drop it locally rather than refetching — the row is gone either way, and
  // this keeps the list from flickering.
  const remove = useCallback(async (id: string) => {
    await deleteReport(id);
    setReports((rs) => rs.filter((r) => r.id !== id));
  }, []);

  return { reports, loading, error, reload, remove };
}
