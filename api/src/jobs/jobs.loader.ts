import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import YAML from 'yaml';
import { Cron } from 'croner';
import { paths } from '../config.js';
import { loadAll as loadAllServers } from '../servers/servers.loader.js';
import { loadRunbooks } from '../runbooks/runbooks.loader.js';
import type { JobConfig, NotifyEvent, NotifyRule, Trigger } from './jobs.types.js';

type RawJob = {
  name?: string;
  description?: string;
  schedule?: string;
  target?: string;
  run?: string;
  when?: { exit?: unknown; stdout_contains?: unknown };
  then?: string;
  notify?: { on?: unknown; priority?: unknown };
  env?: unknown;
};

const NOTIFY_EVENTS: NotifyEvent[] = ['action', 'error'];
const PRIORITIES = new Set(['min', 'low', 'default', 'high', 'max']);

function parseTrigger(raw: RawJob['when'], ctx: string): Trigger | undefined {
  if (raw === undefined) return undefined;
  const t: Trigger = {};
  if (raw.exit !== undefined) {
    if (raw.exit === 'nonzero' || raw.exit === 'zero') t.exit = raw.exit;
    else if (typeof raw.exit === 'number') t.exit = raw.exit;
    else throw new Error(`${ctx}: when.exit must be 'nonzero', 'zero', or an integer`);
  }
  if (raw.stdout_contains !== undefined) {
    if (typeof raw.stdout_contains !== 'string') throw new Error(`${ctx}: when.stdout_contains must be a string`);
    t.stdoutContains = raw.stdout_contains;
  }
  return t;
}

function parseNotify(raw: RawJob['notify'], ctx: string): NotifyRule | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw.on)) throw new Error(`${ctx}: notify.on must be a list of events`);
  const on = raw.on.map((e) => {
    if (!NOTIFY_EVENTS.includes(e as NotifyEvent)) {
      throw new Error(`${ctx}: notify.on has unknown event '${e}' (allowed: ${NOTIFY_EVENTS.join(', ')})`);
    }
    return e as NotifyEvent;
  });
  let priority: NotifyRule['priority'];
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== 'string' || !PRIORITIES.has(raw.priority)) {
      throw new Error(`${ctx}: notify.priority must be one of ${[...PRIORITIES].join(', ')}`);
    }
    priority = raw.priority as NotifyRule['priority'];
  }
  return { on, priority };
}

function parseEnv(raw: unknown, ctx: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${ctx}: env must be a map of NAME: value`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`${ctx}: env.${k} must be a string`);
    // Store RAW (the ${VAR} ref, not the value): keeps secrets out of GET
    // /api/jobs AND defers resolution to run time (jobs.runner), so an unset
    // secret surfaces as a per-run error — never a failed boot.
    out[k] = v;
  }
  return out;
}

function buildJob(
  id: string,
  raw: RawJob,
  serverIds: Set<string>,
  runbookIds: Set<string>,
): JobConfig {
  const ctx = `job ${id}`;
  if (!raw.schedule) throw new Error(`${ctx}: missing 'schedule'`);
  if (!raw.target) throw new Error(`${ctx}: missing 'target'`);
  if (!raw.run) throw new Error(`${ctx}: missing 'run'`);

  // Validate cron up front so a typo fails at startup, not at the first tick.
  try {
    new Cron(raw.schedule, { paused: true }).stop();
  } catch (err) {
    throw new Error(`${ctx}: invalid schedule '${raw.schedule}' — ${(err as Error).message}`);
  }

  if (!serverIds.has(raw.target)) throw new Error(`${ctx}: unknown target '${raw.target}'`);
  if (!runbookIds.has(raw.run)) throw new Error(`${ctx}: unknown run runbook '${raw.run}'`);
  if (raw.then !== undefined && !runbookIds.has(raw.then)) {
    throw new Error(`${ctx}: unknown then runbook '${raw.then}'`);
  }

  const when = parseTrigger(raw.when, ctx);
  if (raw.then !== undefined && when === undefined) {
    throw new Error(`${ctx}: 'then' requires a 'when' condition`);
  }

  return {
    id,
    name: raw.name ?? id,
    description: raw.description,
    schedule: raw.schedule,
    target: raw.target,
    run: raw.run,
    when,
    then: raw.then,
    notify: parseNotify(raw.notify, ctx),
    env: parseEnv(raw.env, ctx),
  };
}

export async function loadJobs(): Promise<JobConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.jobs);
  } catch {
    return []; // no jobs dir → no jobs, that's fine
  }
  const files = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  if (files.length === 0) return [];

  // Cross-check references against real servers + runbooks (loud failure).
  const [{ servers }, runbooks] = await Promise.all([loadAllServers(), loadRunbooks()]);
  const serverIds = new Set(servers.map((s) => s.id));
  const runbookIds = new Set(runbooks.map((r) => r.id));

  const jobs: JobConfig[] = [];
  for (const f of files) {
    const id = basename(f, extname(f));
    try {
      const text = await readFile(join(paths.jobs, f), 'utf8');
      const raw = (YAML.parse(text) ?? {}) as RawJob;
      jobs.push(buildJob(id, raw, serverIds, runbookIds));
    } catch (err) {
      // Jobs are auxiliary — one malformed file must never break the others,
      // the /api/jobs list, or (via the scheduler) the whole API. Log loudly
      // and skip it; fix the file and it loads on next read.
      console.error(`[jobs] skipping '${id}': ${(err as Error).message}`);
    }
  }
  return jobs;
}

export async function loadJob(id: string): Promise<JobConfig | null> {
  const all = await loadJobs();
  return all.find((j) => j.id === id) ?? null;
}
