import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { PORT } from './config.js';
import { authPlugin } from './auth/auth.plugin.js';
import { authRoutes } from './auth/auth.routes.js';
import { serversRoutes } from './servers/servers.routes.js';
import { runbooksRoutes } from './runbooks/runbooks.routes.js';
import { sshRoutes } from './ssh/ssh.routes.js';
import { jobsRoutes } from './jobs/jobs.routes.js';
import { startScheduler } from './jobs/jobs.scheduler.js';
import { alertsRoutes } from './alerts/alerts.routes.js';
import { metricsRoutes } from './metrics/metrics.routes.js';
import { startCollector } from './metrics/metrics.collector.js';
import { filesRoutes } from './files/files.routes.js';
import { aiRoutes } from './ai/ai.routes.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, credentials: true });
await app.register(websocket);

// Auth must be registered before the feature routes so its onRequest guard
// covers them (and /ws/*). Health stays public for k8s liveness + verify loop.
await app.register(authPlugin);
await app.register(authRoutes);

await app.register(serversRoutes);
await app.register(runbooksRoutes);
await app.register(sshRoutes);
await app.register(jobsRoutes);
await app.register(alertsRoutes);
await app.register(metricsRoutes);
await app.register(filesRoutes);
await app.register(aiRoutes);

app.get('/api/health', async () => ({ ok: true }));

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Start the in-memory job scheduler after the server is up. Jobs are an
// auxiliary feature — a bad job file (or unset job env var) must never take
// down the API, so this is isolated from the fatal listen path and logs
// instead of exiting. loadJobs already skips malformed files individually.
try {
  await startScheduler();
} catch (err) {
  app.log.error({ err }, 'job scheduler failed to start — API continuing without it');
}

// Start the always-on metrics collector. Like the scheduler it's auxiliary —
// a bad dashboard config or unreachable node must never take down the API, so
// it logs instead of exiting. loadDashboardConfig already falls back to
// defaults, and per-node stream failures reconnect on a backoff.
try {
  await startCollector();
} catch (err) {
  app.log.error({ err }, 'metrics collector failed to start — API continuing without it');
}
