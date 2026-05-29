import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { PORT } from './config.js';
import { authPlugin } from './auth/auth.plugin.js';
import { authRoutes } from './auth/auth.routes.js';
import { serversRoutes } from './servers/servers.routes.js';
import { runbooksRoutes } from './runbooks/runbooks.routes.js';
import { sshRoutes } from './ssh/ssh.routes.js';

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

app.get('/api/health', async () => ({ ok: true }));

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
