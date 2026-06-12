import type { FastifyInstance } from 'fastify';
import { loadMediaConfig } from './media.config.js';
import { applyDelete, getSnapshot } from './media.aggregate.js';
import { deleteMovie } from './radarr.client.js';
import { deleteSeason, deleteSeries } from './sonarr.client.js';
import type { MediaStatus } from './media.types.js';

// Deletes require an explicit `confirm: true` in the JSON body — a server-side
// backstop behind the UI's confirm dialog so nothing destructive can happen
// from a stray fetch or a mistyped curl.
type ConfirmBody = { confirm?: boolean; addImportExclusion?: boolean };

export async function mediaRoutes(app: FastifyInstance) {
  // Cheap config-only gate for UI affordance visibility (no library fetch).
  app.get('/api/media/status', async (): Promise<MediaStatus> => {
    const cfg = await loadMediaConfig();
    return {
      enabled: cfg.enabled,
      services: { radarr: !!cfg.radarr, sonarr: !!cfg.sonarr, plex: !!cfg.plex },
    };
  });

  // Aggregated snapshot — serves the cache; first hit / TTL expiry pulls live.
  app.get('/api/media', async (req, reply) => {
    const cfg = await loadMediaConfig();
    if (!cfg.enabled) return reply.code(503).send({ error: 'media view not configured (see config/media.yaml)' });
    return getSnapshot();
  });

  app.post('/api/media/refresh', async (req, reply) => {
    const cfg = await loadMediaConfig();
    if (!cfg.enabled) return reply.code(503).send({ error: 'media view not configured (see config/media.yaml)' });
    return getSnapshot({ force: true });
  });

  app.delete<{ Params: { id: string }; Body: ConfirmBody }>(
    '/api/media/movie/:id', async (req, reply) => {
      const cfg = await loadMediaConfig();
      if (!cfg.radarr) return reply.code(503).send({ ok: false, error: 'radarr not configured' });
      if (req.body?.confirm !== true) return reply.code(400).send({ ok: false, error: 'missing confirm: true' });
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ ok: false, error: 'bad movie id' });

      try {
        await deleteMovie(cfg.radarr, id, req.body?.addImportExclusion === true);
      } catch (err) {
        return reply.code(502).send({ ok: false, error: (err as Error).message });
      }
      applyDelete({ kind: 'movie', id });
      return { ok: true };
    });

  app.delete<{ Params: { id: string }; Body: ConfirmBody }>(
    '/api/media/series/:id', async (req, reply) => {
      const cfg = await loadMediaConfig();
      if (!cfg.sonarr) return reply.code(503).send({ ok: false, error: 'sonarr not configured' });
      if (req.body?.confirm !== true) return reply.code(400).send({ ok: false, error: 'missing confirm: true' });
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ ok: false, error: 'bad series id' });

      try {
        await deleteSeries(cfg.sonarr, id);
      } catch (err) {
        return reply.code(502).send({ ok: false, error: (err as Error).message });
      }
      applyDelete({ kind: 'series', id });
      return { ok: true };
    });

  app.delete<{ Params: { id: string; n: string }; Body: ConfirmBody }>(
    '/api/media/series/:id/season/:n', async (req, reply) => {
      const cfg = await loadMediaConfig();
      if (!cfg.sonarr) return reply.code(503).send({ ok: false, error: 'sonarr not configured' });
      if (req.body?.confirm !== true) return reply.code(400).send({ ok: false, error: 'missing confirm: true' });
      const seriesId = Number(req.params.id);
      const seasonNumber = Number(req.params.n);
      if (!Number.isInteger(seriesId) || !Number.isInteger(seasonNumber)) {
        return reply.code(400).send({ ok: false, error: 'bad series/season id' });
      }

      try {
        await deleteSeason(cfg.sonarr, seriesId, seasonNumber);
      } catch (err) {
        return reply.code(502).send({ ok: false, error: (err as Error).message });
      }
      applyDelete({ kind: 'season', seriesId, seasonNumber });
      return { ok: true };
    });
}
