import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { getSnapshot, subscribe } from './metrics.collector.js';
import type { MetricsEvent } from './metrics.types.js';

// Both endpoints read the collector's in-memory buffers — neither opens its own
// SSH connection (the always-on collector owns those). Auth is handled by the
// global onRequest guard, which covers /api/* and /ws/* alike.
export async function metricsRoutes(app: FastifyInstance) {
  // Snapshot for first paint / debugging / the verify loop.
  app.get('/api/metrics', async () => getSnapshot());

  // Live: send the current snapshot, then forward every collector event until
  // the socket closes. No client→server messages — it's a pure push stream.
  app.get('/ws/metrics', { websocket: true }, (socket) => {
    const ws = socket as unknown as WebSocket;
    const send = (e: MetricsEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
    };

    send({ type: 'snapshot', snapshot: getSnapshot() });
    const unsubscribe = subscribe(send);
    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  });
}
