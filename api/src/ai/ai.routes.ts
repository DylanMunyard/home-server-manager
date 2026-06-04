import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { loadAiConfig } from './ai.config.js';
import { chat, type ChatMessage, type ConvoMessage } from './ai.client.js';
import { APP_CONTEXT, RUNBOOK_AUTHORING } from './ai.prompts.js';
import {
  getInvestigation,
  subscribeInvestigation,
  type InvestigationEvent,
} from './ai.investigate.js';
import { runChatTurn, type ChatEvent } from './ai.chat.js';

type ChatBody = {
  // Either a one-shot prompt or a full message history (without the system
  // message — we prepend that based on `mode`).
  prompt?: string;
  messages?: ChatMessage[];
  // 'runbook' appends the script-authoring guide; 'chat' (default) doesn't.
  mode?: 'chat' | 'runbook';
};

export async function aiRoutes(app: FastifyInstance) {
  // Lets the UI know whether to show AI affordances at all (clone-and-go: a
  // checkout without a deployment configured just hides them).
  app.get('/api/ai/status', async () => {
    const cfg = loadAiConfig();
    return {
      enabled: cfg.enabled,
      deployment: cfg.enabled ? cfg.deployment : null,
      apiVersion: cfg.apiVersion,
    };
  });

  // Generic chat entrypoint — the plumbing the concrete features (runbook
  // generation, live troubleshooting, alert investigation) will build on.
  app.post<{ Body: ChatBody }>('/api/ai/chat', async (req, reply) => {
    const { prompt, messages, mode } = req.body ?? {};

    const system =
      mode === 'runbook' ? `${APP_CONTEXT}\n\n${RUNBOOK_AUTHORING}` : APP_CONTEXT;

    const convo: ChatMessage[] = [{ role: 'system', content: system }];
    if (messages?.length) convo.push(...messages);
    else if (prompt) convo.push({ role: 'user', content: prompt });
    else return reply.code(400).send({ error: 'provide `prompt` or `messages`' });

    const result = await chat(convo);
    if (result.skipped) {
      return reply.code(503).send({
        ok: false,
        reason: 'AI not configured — set AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT',
      });
    }
    if (!result.ok) return reply.code(502).send({ ok: false, reason: result.error });
    return { ok: true, content: result.content };
  });

  // Buffered transcript of one investigation (first paint / polling / verify
  // loop). The WS below is the live counterpart.
  app.get<{ Params: { id: string } }>('/api/ai/investigations/:id', async (req, reply) => {
    const inv = getInvestigation(req.params.id);
    if (!inv) return reply.code(404).send({ error: 'not found' });
    const { id, jobId, target, status, startedAt, summary, error, events } = inv;
    return { id, jobId, target, status, startedAt, summary, error, events };
  });

  // Interactive chat session — a live tool-calling loop streamed turn by turn.
  // The client owns the history (stateless server, same as the rest): it sends
  // `{ history, userMessage }` frames; the server streams `status`/`text`/`cmd`/
  // `output` events as the loop runs (so the UI shows real progress, not a static
  // "thinking…"), then a terminal `done` carrying the new turns to append. Client
  // ownership keeps the conversation resilient across socket drops/API restarts.
  // Mirrors /ws/shell (interactive) + /ws/ai/investigate (event stream).
  app.get<{ Querystring: { target?: string } }>('/ws/ai/chat', { websocket: true }, (socket, req) => {
    const ws = socket as unknown as WebSocket;
    type DoneEvent = { type: 'done'; ok: boolean; error?: string; messages: ConvoMessage[] };
    const send = (e: ChatEvent | DoneEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
    };

    const target = req.query.target;
    if (!target) {
      send({ type: 'done', ok: false, error: 'missing `target` query param', messages: [] });
      ws.close();
      return;
    }
    if (!loadAiConfig().enabled) {
      send({ type: 'done', ok: false, error: 'AI not configured — set AZURE_OPENAI_* in .env', messages: [] });
      ws.close();
      return;
    }

    let busy = false;

    ws.on('message', (raw: Buffer) => {
      if (busy) return; // one turn at a time; ignore frames sent mid-turn
      let history: ConvoMessage[];
      let userMessage: string;
      try {
        const b = JSON.parse(raw.toString()) as { history?: ConvoMessage[]; userMessage?: unknown };
        history = Array.isArray(b.history) ? b.history : [];
        userMessage = String(b.userMessage ?? '');
      } catch {
        return; // ignore malformed frames
      }
      if (!userMessage.trim()) return;

      busy = true;
      // Auxiliary feature — must never throw into the connection. runChatTurn
      // returns errors; this catch is the belt-and-braces backstop.
      void runChatTurn(target, history, userMessage, send)
        .then((result) => {
          send({ type: 'done', ok: result.ok, error: result.error, messages: result.ok ? result.messages : [] });
        })
        .catch((err: unknown) => {
          send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err), messages: [] });
        })
        .finally(() => { busy = false; });
    });
  });

  // Live investigation stream: replay the buffered transcript, then forward new
  // events until the loop is done (then close). Mirrors /ws/metrics; auth is the
  // global onRequest guard. Pure push — no client→server messages.
  app.get<{ Querystring: { id?: string } }>('/ws/ai/investigate', { websocket: true }, (socket, req) => {
    const ws = socket as unknown as WebSocket;
    const send = (e: InvestigationEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
    };

    const id = req.query.id;
    const inv = id ? getInvestigation(id) : undefined;
    if (!inv) {
      send({ type: 'done', status: 'error', error: 'unknown investigation id' });
      ws.close();
      return;
    }

    // Replay what's already happened, then attach for the rest.
    for (const e of inv.events) send(e);
    if (inv.status !== 'running') {
      ws.close(); // already finished — the replay above included `done`
      return;
    }

    const unsubscribe = subscribeInvestigation(id!, send);
    ws.on('close', () => unsubscribe?.());
    ws.on('error', () => unsubscribe?.());
  });
}
