import { useCallback, useEffect, useState } from 'react';
import { fetchJobs, runJob, type Job } from '../shared/api.ts';

export function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null); // job id being run-now'd

  const reload = useCallback(() => {
    fetchJobs().then(setJobs).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Trigger a job off-schedule. Returns the updated job so callers can show
  // the immediate outcome (pass / failed / remediation ran) without waiting
  // for the reload's render cycle.
  const run = useCallback(async (id: string): Promise<Job | null> => {
    setRunning(id);
    try {
      const updated = await runJob(id);
      setJobs((prev) => prev.map((j) => (j.id === id ? updated : j)));
      return updated;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setRunning(null);
      reload();
    }
  }, [reload]);

  return { jobs, error, run, runningId: running, reload };
}
