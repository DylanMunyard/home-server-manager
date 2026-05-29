import type { FastifyInstance } from 'fastify';
import { loadJobs, loadJob } from './jobs.loader.js';
import { executeJob, getState } from './jobs.runner.js';
import { nextRuns } from './jobs.scheduler.js';

export async function jobsRoutes(app: FastifyInstance) {
  // List job definitions + in-memory last-run state. This is the contract the
  // (future) jobs UI renders against.
  app.get('/api/jobs', async () => {
    const jobs = await loadJobs();
    const next = nextRuns();
    return jobs.map((job) => ({
      ...job,
      nextRunAt: next[job.id] ?? null,
      state: getState(job.id),
    }));
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = await loadJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return { ...job, nextRunAt: nextRuns()[job.id] ?? null, state: getState(job.id) };
  });

  // Manual trigger — runs the job now, off-schedule. Awaits completion so the
  // caller gets the resulting state back (handy for testing + a future "run
  // now" button).
  app.post<{ Params: { id: string } }>('/api/jobs/:id/run', async (req, reply) => {
    const job = await loadJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    await executeJob(job);
    return { ...job, nextRunAt: nextRuns()[job.id] ?? null, state: getState(job.id) };
  });
}
