import { useEffect, useMemo, useState } from 'react';
import {
  fetchGroups,
  fetchServerDetail,
  type GroupSummary,
  type ServerDetail,
  type ServerSummary,
} from '../shared/api.ts';

export function useGroups() {
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGroups().then(setGroups).catch((e: Error) => setError(e.message));
  }, []);

  const allServers = useMemo<ServerSummary[]>(
    () => groups.flatMap((g) => g.servers),
    [groups],
  );

  return { groups, allServers, error };
}

/**
 * Fetches server detail when either `id` or `reloadKey` changes. Bumping
 * `reloadKey` on every click — even re-clicks of the same row — triggers a
 * fresh read of the YAML from disk, which is the hot-reload behaviour.
 */
export function useServerDetail(id: string | null, reloadKey: number) {
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) { setDetail(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchServerDetail(id)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, reloadKey]);

  return { detail, loading, error };
}
