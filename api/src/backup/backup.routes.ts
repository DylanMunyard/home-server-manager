import type { FastifyInstance } from 'fastify';
import { loadServer } from '../servers/servers.loader.js';
import { loadRunbook, resolveParamValues } from '../runbooks/runbooks.loader.js';
import { exportPrelude } from '../ssh/prelude.js';
import { runScriptRaw } from '../ssh/ssh.session.js';

const SERVER_ID = 'hetzner/bfstats';

type BackupType = 'sqlite' | 'neo4j';

const BACKUP_CONFIG: Record<BackupType, { runbook: string; contentType: string }> = {
  sqlite: {
    runbook: 'bfstats-backup-sqlite',
    contentType: 'application/gzip',
  },
  neo4j: {
    runbook: 'bfstats-backup-neo4j',
    contentType: 'application/gzip',
  },
};

/**
 * Streaming database backup routes for the bfstats server.
 *
 * GET /api/backup/bfstats-sqlite  — stops bf42-stats, dumps SQLite → gzip → browser
 * GET /api/backup/bfstats-neo4j   — stops neo4j, tars PVC data → gzip → browser
 *
 * Both routes are pure pass-through streams: SSH stdout chunks are written
 * directly to the HTTP response. No temp file is created on the server or in
 * the API process. The browser receives a Content-Disposition attachment header
 * and saves the file as a download.
 *
 * Stderr from the script is logged server-side only (it would corrupt the
 * binary download stream). If the script exits non-zero the connection is
 * closed early; the browser will see a truncated/incomplete download.
 *
 * Long-running: SQLite ~30–90s, Neo4j ~30–120s depending on DB size. The HTTP
 * connection stays open for the duration — don't put a short read timeout in
 * front of this route.
 */
export async function backupRoutes(app: FastifyInstance) {
  for (const [type, cfg] of Object.entries(BACKUP_CONFIG) as [BackupType, typeof BACKUP_CONFIG[BackupType]][]) {
    app.get(`/api/backup/bfstats-${type}`, async (req, reply) => {
      const [server, runbook] = await Promise.all([
        loadServer(SERVER_ID),
        loadRunbook(cfg.runbook),
      ]);

      if (!server) {
        return reply.code(500).send({ error: `server '${SERVER_ID}' not found` });
      }
      if (!runbook) {
        return reply.code(500).send({ error: `runbook '${cfg.runbook}' not found` });
      }

      // Resolve declared params (all have defaults — no user-supplied values needed
      // for the default workflow; the runbook UI handles custom paths if wanted).
      const prelude = exportPrelude(resolveParamValues(runbook.params, {}));

      // Set download headers before any streaming begins.
      // Filename is computed once at request time so the date is correct.
      const filename = `bfstats-${type}-${new Date().toISOString().slice(0, 10)}${type === 'sqlite' ? '.db.gz' : '.tar.gz'}`;
      reply.raw.setHeader('Content-Type', cfg.contentType);
      reply.raw.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // Disable any buffering middleware — we need raw streaming.
      reply.raw.setHeader('Transfer-Encoding', 'chunked');
      // Signal to Fastify that we're taking over the raw response.
      reply.hijack();

      let scriptFailed = false;
      let stderrBuf = '';

      const handle = runScriptRaw(server, prelude + runbook.contents, (e) => {
        switch (e.type) {
          case 'stdout':
            // Raw Buffer — write directly to the socket without any encoding.
            if (!reply.raw.writableEnded) {
              reply.raw.write(e.chunk);
            }
            break;

          case 'stderr':
            // Collect for logging; never sent to the client (would corrupt the binary stream).
            stderrBuf += e.data;
            break;

          case 'error':
            req.log.error({ msg: 'backup SSH error', type, error: e.message });
            scriptFailed = true;
            break;

          case 'exit':
            if (e.code !== 0) {
              req.log.error({ msg: 'backup script failed', type, exitCode: e.code, stderr: stderrBuf.trim() });
              scriptFailed = true;
            } else {
              req.log.info({ msg: 'backup complete', type, filename });
            }
            break;
        }
      });

      // Await the SSH session, then close the HTTP response.
      // If the script failed, we've already written partial data — we can't
      // send an error body now. The truncated stream is the failure signal.
      await handle.done;

      if (stderrBuf.trim()) {
        req.log.warn({ msg: 'backup stderr', type, stderr: stderrBuf.trim() });
      }

      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }

      // Satisfy Fastify's return-a-value expectation when using hijack().
      return reply;
    });
  }
}
