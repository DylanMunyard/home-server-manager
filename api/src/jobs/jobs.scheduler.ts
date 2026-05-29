import { Cron } from 'croner';
import { loadJobs } from './jobs.loader.js';
import { executeJob, getState } from './jobs.runner.js';
import type { JobConfig } from './jobs.types.js';

let crons: Cron[] = [];

/**
 * Load jobs from config/jobs and schedule each with croner. In-memory only:
 * call once at startup. A bad job file throws here (loud failure), same as the
 * server/auth loaders. Returns the loaded jobs so the caller can log them.
 */
export async function startScheduler(): Promise<JobConfig[]> {
  const jobs = await loadJobs();
  for (const job of jobs) {
    getState(job.id); // seed state so GET /api/jobs lists it before first run
    const cron = new Cron(job.schedule, { name: job.id }, () => {
      void executeJob(job);
    });
    crons.push(cron);
    console.log(`[jobs] scheduled '${job.id}' (${job.schedule}) → next ${cron.nextRun()?.toISOString() ?? 'never'}`);
  }
  return jobs;
}

export function stopScheduler(): void {
  for (const c of crons) c.stop();
  crons = [];
}

export function nextRuns(): Record<string, string | null> {
  return Object.fromEntries(crons.map((c) => [c.name ?? '', c.nextRun()?.toISOString() ?? null]));
}
