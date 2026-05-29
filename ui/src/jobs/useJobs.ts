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

  // Trigger a job off-schedule, then refresh the list so last-run state updates.
  const run = useCallback(async (id: string) => {
    setRunning(id);
    try {
      await runJob(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
      reload();
    }
  }, [reload]);

  return { jobs, error, run, runningId: running, reload };
}
