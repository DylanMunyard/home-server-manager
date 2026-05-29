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
