import type { FastifyInstance } from 'fastify';
import { loadRunbooks, loadRunbook } from './runbooks.loader.js';

export async function runbooksRoutes(app: FastifyInstance) {
  app.get('/api/runbooks', async () => {
    const books = await loadRunbooks();
    return books.map(({ id, name, description, params, filename }) => ({ id, name, description, params, filename }));
  });

  app.get<{ Params: { id: string } }>('/api/runbooks/:id', async (req, reply) => {
    const book = await loadRunbook(req.params.id);
    if (!book) return reply.code(404).send({ error: 'not found' });
    return book;
  });
}
