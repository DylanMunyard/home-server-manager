import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import * as tar from 'tar';
import { loadReportsConfig } from './reports.config.js';
import type { ReportMeta } from './reports.types.js';

/**
 * The filesystem is the database. Layout:
 *
 *   <REPORTS_DIR>/<id>/meta.json     provenance (node, PR, sha, run URL…)
 *   <REPORTS_DIR>/<id>/report/…      the extracted Playwright HTML report
 *
 * There is no index file. Retention keeps this to a handful of directories, so
 * scanning them is cheaper than keeping a second copy of the truth in sync —
 * and it means a report can be removed with `rm -rf` and nothing else breaks.
 */

/** `YYYYMMDD-HHMMSS-<6 hex>` — URL-safe, and lexical order IS chronological. */
const ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

/** Where the extracted report lands inside a report dir; also the URL segment. */
export const REPORT_SUBDIR = 'report';

export function newId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  // UTC so ids sort chronologically regardless of the process TZ (which the
  // pod pins to Australia/Brisbane for cron — see deploy/k8s/api-deployment.yaml).
  const d = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const t = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${d}-${t}-${randomBytes(3).toString('hex')}`;
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * Every path-forming call goes through here, so a caller-supplied `:id` can
 * never contain a separator or `..` — the shape check IS the traversal defence.
 */
function dirFor(id: string): string {
  if (!isValidId(id)) throw new Error(`invalid report id: ${id}`);
  return join(loadReportsConfig().dir, id);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += await stat(p).then((s) => s.size, () => 0);
  }
  return total;
}

/**
 * Stream a gzipped tarball into `<id>/report/`, never buffering it in memory.
 *
 * The tarball arrives from CI over the internet, so extraction is treated as
 * untrusted input:
 *   - `strict` turns node-tar's warnings into errors, so an absolute path or a
 *     `..` segment aborts the whole extraction instead of being skipped;
 *   - the `filter` accepts only plain files and directories. Links are the real
 *     danger here: a symlink to /etc/passwd inside the report dir would be
 *     happily followed by the static file route that serves it back.
 *
 * `strip: 1` drops the archive's top-level `playwright-report/` wrapper so the
 * report always lands at `<id>/report/index.html` whatever CI named the dir.
 */
export async function extract(id: string, body: Readable): Promise<number> {
  const dest = join(dirFor(id), REPORT_SUBDIR);
  await mkdir(dest, { recursive: true });

  await pipeline(
    body,
    createGunzip(),
    tar.x({
      cwd: dest,
      strip: 1,
      strict: true,
      // `filter` is typed for both create (Stats) and extract (ReadEntry); on
      // this path it's always a ReadEntry, and anything else is not a tarball
      // we want to unpack.
      filter: (_path, entry) =>
        'type' in entry && (entry.type === 'File' || entry.type === 'Directory'),
    }),
  );

  return dirSize(dest);
}

export async function writeMeta(meta: ReportMeta): Promise<void> {
  await writeFile(join(dirFor(meta.id), 'meta.json'), JSON.stringify(meta, null, 2));
}

export async function get(id: string): Promise<ReportMeta | null> {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await readFile(join(dirFor(id), 'meta.json'), 'utf8')) as ReportMeta;
  } catch {
    return null;
  }
}

/** Newest first. A directory without readable meta.json is skipped, not fatal. */
export async function list(node?: string): Promise<ReportMeta[]> {
  const { dir } = loadReportsConfig();
  const names = await readdir(dir).catch(() => [] as string[]);
  const ids = names.filter(isValidId).sort().reverse();
  const metas = await Promise.all(ids.map((id) => get(id)));
  return metas.filter((m): m is ReportMeta => !!m && (!node || m.node === node));
}

export async function remove(id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  const dir = dirFor(id);
  if (!(await stat(dir).then(() => true, () => false))) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Keep the `keep` newest reports PER NODE. Per-node rather than global so a
 * chatty repo can't evict the one report you were about to look at on another
 * box. Returns the ids it deleted.
 */
export async function prune(keep: number): Promise<string[]> {
  const all = await list();
  const seen = new Map<string, number>();
  const dropped: string[] = [];

  for (const m of all) {
    const n = (seen.get(m.node) ?? 0) + 1;
    seen.set(m.node, n);
    if (n > keep && (await remove(m.id))) dropped.push(m.id);
  }
  return dropped;
}
