import type { FastifyInstance } from 'fastify';
import { loadJobs, loadJob } from './jobs.loader.js';
import { executeJob, getState } from './jobs.runner.js';
import { getHistory } from './jobs.history.js';
import { nextRuns } from './jobs.scheduler.js';
import { latestForTarget, startInvestigation } from '../ai/ai.investigate.js';
import { loadAiConfig } from '../ai/ai.config.js';
import { loadRunbook } from '../runbooks/runbooks.loader.js';
import type { JobRunState, RunResult, TargetRunState } from './jobs.types.js';

/**
 * Job state with each target's latest AI investigation (status + summary)
 * overlaid live from the ai registry — kept out of the runner's stored state so
 * a long-running investigation's status stays fresh between ticks.
 */
function stateWithInvestigations(jobId: string): JobRunState {
  const s = getState(jobId);
  const targets: Record<string, TargetRunState> = {};
  for (const [t, ts] of Object.entries(s.targets)) {
    const investigation = latestForTarget(jobId, t);
    targets[t] = investigation ? { ...ts, investigation } : ts;
  }
  return { ...s, targets };
}

export async function jobsRoutes(app: FastifyInstance) {
  // List job definitions + in-memory last-run state. This is the contract the
  // (future) jobs UI renders against.
  app.get('/api/jobs', async () => {
    const jobs = await loadJobs();
    const next = nextRuns();
    return jobs.map((job) => ({
      ...job,
      nextRunAt: next[job.id] ?? null,
      state: stateWithInvestigations(job.id),
    }));
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = await loadJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return { ...job, nextRunAt: nextRuns()[job.id] ?? null, state: stateWithInvestigations(job.id) };
  });

  // Past executions — every non-clean run (failure or triggered remediation),
  // capped per job, plus the single most recent clean run. See jobs.history.ts
  // for the retention policy; this is in-memory only, reset on restart.
  app.get<{ Params: { id: string } }>('/api/jobs/:id/history', async (req, reply) => {
    const job = await loadJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return { entries: getHistory(job.id) };
  });

  // Manual trigger — runs the job now, off-schedule. Awaits completion so the
  // caller gets the resulting state back. `force: true` ("Test fire") treats
  // the `when` gate as tripped regardless of the check's result: the real
  // `then` chain runs and the real alerts fire (titles marked "test fire").
  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/api/jobs/:id/run', async (req, reply) => {
    const job = await loadJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    await executeJob(job, { forceTrigger: req.body?.force === true });
    return { ...job, nextRunAt: nextRuns()[job.id] ?? null, state: stateWithInvestigations(job.id) };
  });

  // Manually kick off an AI investigation against the target's LAST run — a test
  // hook for iterating on the investigator prompt without waiting for a real
  // failure. Runs the same read-only probe loop as the auto-trigger, but skips
  // the follow-up ntfy (suppressAlert). Works for any job as long as AI is
  // configured — independent of the job's `investigate` opt-in (that gates the
  // automatic firing; this is an explicit user action). Returns the new
  // investigation id to stream over /ws/ai/investigate.
  app.post<{ Params: { id: string }; Body: { target?: string } }>('/api/jobs/:id/investigate', async (req, reply) => {
    const job = await loadJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    if (!loadAiConfig().enabled) return reply.code(503).send({ error: 'AI not configured — set AZURE_OPENAI_* in .env' });

    const target = req.body?.target && job.targets.includes(req.body.target) ? req.body.target : job.targets[0];
    const ts = getState(job.id).targets[target];
    const checkRunbook = await loadRunbook(job.run);

    // Use the captured last check if there is one; otherwise an empty result so
    // the loop still probes the live box (just without prior output).
    const result: RunResult = ts?.lastCheck ?? {
      connected: false, stdout: '', stderr: '', exitCode: null, durationMs: 0,
    };
    const reason = ts?.lastCheck
      ? `manual test investigation — last '${job.run}' check exited ${ts.lastCheck.exitCode}${ts.lastCheck.error ? ` (${ts.lastCheck.error})` : ''}`
      : `manual test investigation — no captured run yet for ${target}`;

    const investigationId = startInvestigation({
      jobId: job.id,
      jobName: job.name,
      jobDescription: job.description,
      target,
      runbookId: job.run,
      runbookDescription: checkRunbook?.description,
      runbookContents: checkRunbook?.contents ?? '',
      result,
      triggerReason: reason,
      hint: job.investigateHint,
      notifyPriority: job.notify?.priority,
      suppressAlert: true,
    });

    if (!investigationId) return reply.code(409).send({ error: `an investigation is already running for ${target}` });
    return { id: investigationId, target };
  });
}
