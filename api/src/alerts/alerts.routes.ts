import type { FastifyInstance } from 'fastify';
import { sendAlert } from './ntfy.js';

type TestBody = { runbook?: string; target?: string };

export async function alertsRoutes(app: FastifyInstance) {
  // Fire a synthetic "script failed" alert — lets the runbook page verify the
  // ntfy path end to end (incl. phone delivery) without running anything. No
  // script executes and no remediation is triggered; it just exercises notify.
  app.post<{ Body: TestBody }>('/api/alerts/test', async (req, reply) => {
    const { runbook, target } = req.body ?? {};
    const name = runbook ?? 'manual test';
    const result = await sendAlert({
      title: `TEST — ${name} failed${target ? ` on ${target}` : ''}`,
      body: [
        `target:  ${target ?? '(none)'}`,
        `runbook: ${name}`,
        'result:  simulated failure (test alert)',
        '',
        'Test from the runbook page — no script ran, no remediation triggered.',
      ].join('\n'),
      priority: 'high',
      tags: ['test_tube'],
    });

    if (result.skipped) return reply.code(503).send({ sent: false, reason: 'ntfy not configured — set NTFY_TOPIC' });
    if (!result.ok)     return reply.code(502).send({ sent: false, reason: result.error ?? `ntfy error ${result.status}` });
    return { sent: true };
  });
}
