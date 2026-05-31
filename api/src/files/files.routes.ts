import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { loadServer } from '../servers/servers.loader.js';
import { loadRunbook, resolveParamValues } from '../runbooks/runbooks.loader.js';
import { exportPrelude } from '../ssh/prelude.js';
import { runScript } from '../ssh/ssh.session.js';
import { collectScript } from '../ssh/ssh.collect.js';
import { validatePath, validateDeletePath, parentOf } from './files.path.js';
import type { FileEntry, FilesEvent } from './files.types.js';

const LIST_RUNBOOK = 'fs-list';
const DELETE_RUNBOOK = 'fs-delete';

type ListQuery = { server?: string; path?: string };
type DeleteBody = { server?: string; path?: string };

/**
 * The size-first file browser. Listing is a *stream* (the dashboard's ethos): the
 * immediate children land at once, then each folder's recursive size streams in
 * as `du` finishes it — so a 27T volume is browsable instantly instead of
 * blocking on a full walk. Closing the socket SIGTERMs the remote `du` (the
 * client's Cancel). Delete is a one-shot POST. Auth is automatic (global guard).
 */
export async function filesRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListQuery }>('/ws/files/list', { websocket: true }, async (socket, req) => {
    const ws = socket as unknown as WebSocket;
    const send = (e: FilesEvent) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); };

    const { server: serverId } = req.query;
    const v = validatePath(req.query.path);
    if (!serverId) { send({ type: 'error', message: 'missing server query param' }); ws.close(); return; }
    if (!v.ok)     { send({ type: 'error', message: v.error }); ws.close(); return; }

    const [server, runbook] = await Promise.all([loadServer(serverId), loadRunbook(LIST_RUNBOOK)]);
    if (!server)  { send({ type: 'error', message: `unknown server: ${serverId}` }); ws.close(); return; }
    if (!runbook) { send({ type: 'error', message: `runbook '${LIST_RUNBOOK}' not found` }); ws.close(); return; }

    send({ type: 'meta', path: v.path, parent: parentOf(v.path) });

    const prelude = exportPrelude(resolveParamValues(runbook.params, { FB_PATH: v.path }));

    // Parse the script's NDJSON stdout line-by-line, forwarding each object as a
    // browser event. A partial trailing line is held until the next chunk.
    let buf = '';
    let stderr = '';
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let obj: { t?: string; name?: string; path?: string; type?: string; size?: number; mtime?: number };
      try { obj = JSON.parse(line); } catch { return; }
      if (obj.t === 'entry') send({ type: 'entry', entry: obj as unknown as FileEntry });
      else if (obj.t === 'size' && obj.path !== undefined) send({ type: 'size', path: obj.path, size: obj.size ?? 0 });
      // 't:done' is implicit — we send 'done' on a clean exit below.
    };

    const handle = runScript(server, prelude + runbook.contents, (e) => {
      if (e.type === 'stdout') {
        buf += e.data;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      } else if (e.type === 'stderr') {
        stderr += e.data;
      } else if (e.type === 'error') {
        send({ type: 'error', message: e.message });
      } else if (e.type === 'exit') {
        if (buf) { onLine(buf); buf = ''; }
        if (e.code === 0) send({ type: 'done' });
        else send({ type: 'error', message: stderr.trim() || `listing failed (exit ${e.code})` });
      }
    });

    ws.on('close', () => handle.cancel());
    await handle.done;
    ws.close();
  });

  // Delete a file or directory (rm -rf). Guarded here and again in the script.
  app.post<{ Body: DeleteBody }>('/api/files/delete', async (req, reply) => {
    const { server: serverId } = req.body ?? {};
    const v = validateDeletePath(req.body?.path);
    if (!serverId) return reply.code(400).send({ ok: false, error: 'missing server' });
    if (!v.ok) return reply.code(400).send({ ok: false, error: v.error });

    const [server, runbook] = await Promise.all([loadServer(serverId), loadRunbook(DELETE_RUNBOOK)]);
    if (!server)  return reply.code(404).send({ ok: false, error: `unknown server: ${serverId}` });
    if (!runbook) return reply.code(500).send({ ok: false, error: `runbook '${DELETE_RUNBOOK}' not found` });

    const prelude = exportPrelude(resolveParamValues(runbook.params, { FB_PATH: v.path }));
    const result = await collectScript(server, prelude + runbook.contents);

    if (result.error) return reply.code(502).send({ ok: false, error: result.error });
    if (result.exitCode !== 0) {
      return reply.code(400).send({ ok: false, error: result.stderr.trim() || `delete failed (exit ${result.exitCode})` });
    }
    return { ok: true };
  });
}
