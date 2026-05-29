import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { loadServer } from '../servers/servers.loader.js';
import { loadRunbook, resolveParamValues } from '../runbooks/runbooks.loader.js';
import { runScript, type RunEvent } from './ssh.session.js';
import { exportPrelude } from './prelude.js';
import { openShell, type ShellEvent } from './ssh.shell.js';

type RunQuery = { server?: string; runbook?: string; params?: string };
type ShellQuery = { server?: string; cols?: string; rows?: string };

type ClientShellMsg =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export async function sshRoutes(app: FastifyInstance) {
  app.get<{ Querystring: RunQuery }>('/ws/run', { websocket: true }, async (socket, req) => {
    const ws = socket as unknown as WebSocket;
    const { server: serverId, runbook: runbookId, params: paramsRaw } = req.query;

    const send = (e: RunEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
    };

    if (!serverId || !runbookId) {
      send({ type: 'error', message: 'missing server or runbook query param' });
      ws.close();
      return;
    }

    const [server, runbook] = await Promise.all([loadServer(serverId), loadRunbook(runbookId)]);
    if (!server)  { send({ type: 'error', message: `unknown server: ${serverId}` });   ws.close(); return; }
    if (!runbook) { send({ type: 'error', message: `unknown runbook: ${runbookId}` }); ws.close(); return; }

    // Param values arrive as a JSON object in the query string. Resolve them
    // against the runbook's declared params (unknown keys ignored) and inject
    // as an `export` prelude — same mechanism as a job's `env:`.
    let provided: Record<string, string> = {};
    if (paramsRaw) {
      try { provided = JSON.parse(paramsRaw) as Record<string, string>; } catch { /* ignore */ }
    }
    const prelude = exportPrelude(resolveParamValues(runbook.params, provided));

    const handle = runScript(server, prelude + runbook.contents, send);
    ws.on('close', () => handle.cancel());
    await handle.done;
    ws.close();
  });

  app.get<{ Querystring: ShellQuery }>('/ws/shell', { websocket: true }, async (socket, req) => {
    const ws = socket as unknown as WebSocket;
    const serverId = req.query.server;
    const cols = Number(req.query.cols ?? 120);
    const rows = Number(req.query.rows ?? 32);

    const send = (e: ShellEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
    };

    if (!serverId) {
      send({ type: 'error', message: 'missing server query param' });
      ws.close();
      return;
    }

    const server = await loadServer(serverId);
    if (!server) {
      send({ type: 'error', message: `unknown server: ${serverId}` });
      ws.close();
      return;
    }

    const handle = openShell(server, { cols, rows }, send);

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientShellMsg;
        if (msg.type === 'input')  handle.write(msg.data);
        if (msg.type === 'resize') handle.resize(msg.cols, msg.rows);
      } catch { /* ignore malformed frames */ }
    });

    ws.on('close', () => handle.close());
    await handle.done;
    ws.close();
  });
}
