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
import { runChatTurn } from './ai.chat.js';

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

  // Interactive chat session — one turn at a time. The client owns the message
  // history (stateless server), passing its full ConvoMessage[] back each call.
  // The server prepends the system message and runs the tool loop. Returns the
  // new turns to append (events for rendering + messages for the next request).
  app.post<{ Body: { target: string; history: ConvoMessage[]; userMessage: string } }>(
    '/api/ai/chat-session',
    async (req, reply) => {
      const { target, history, userMessage } = req.body ?? {};
      if (!target || !userMessage) {
        return reply.code(400).send({ error: 'provide `target` and `userMessage`' });
      }
      if (!loadAiConfig().enabled) {
        return reply.code(503).send({ ok: false, error: 'AI not configured — set AZURE_OPENAI_* in .env' });
      }
      const result = await runChatTurn(target, history ?? [], userMessage);
      if (!result.ok) return reply.code(result.skipped ? 503 : 502).send(result);
      return result;
    },
  );

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
