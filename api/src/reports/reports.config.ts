import { resolve } from 'node:path';
import { paths } from '../config.js';

/**
 * E2E report hosting config — read from env, never hard-fail.
 *
 * Same stance as alerts/ntfy.config.ts: this is optional infra. A checkout with
 * no CI pointed at it should still boot, so nothing here throws — an unset
 * REPORTS_INGEST_TOKEN just closes the ingest route (503) while viewing and
 * listing keep working on whatever is already on disk.
 *
 * The report volume is the ONE piece of persistent state the app keeps outside
 * config/ (see the root CLAUDE.md) — disposable CI output under a retention
 * cap, not application state. An empty/missing dir is a valid cold start.
 */
export type ReportsConfig = {
  dir: string;
  /** Ingest is disabled (503) when this is unset — the token IS the auth. */
  token?: string;
  keep: number;
  maxBytes: number;
};

// Cloudflare's free plan rejects request bodies over 100MB, and the tunnel is
// how CI reaches us — so accepting more here would only fail further out.
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadReportsConfig(): ReportsConfig {
  // Prod mounts the PVC and sets REPORTS_DIR=/data/reports. The dev default is
  // a gitignored dir in the repo, so a clone needs no setup to try this out.
  const dir = process.env.REPORTS_DIR?.trim() || resolve(paths.repoRoot, '.reports');
  return {
    dir,
    token: process.env.REPORTS_INGEST_TOKEN?.trim() || undefined,
    keep: num(process.env.REPORTS_KEEP, 10),
    maxBytes: num(process.env.REPORTS_MAX_BYTES, DEFAULT_MAX_BYTES),
  };
}
