import type { FastifyInstance } from 'fastify';
import { loadGroupSummaries, loadServerDetail } from './servers.loader.js';

export async function serversRoutes(app: FastifyInstance) {
  app.get('/api/groups', async () => loadGroupSummaries());

  app.get<{ Params: { group: string; server: string } }>(
    '/api/servers/:group/:server',
    async (req, reply) => {
      const id = `${req.params.group}/${req.params.server}`;
      const detail = await loadServerDetail(id);
      if (!detail) return reply.code(404).send({ error: 'not found' });
      return detail;
    },
  );
}
