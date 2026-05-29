import type { FastifyInstance } from 'fastify';
import { authConfig } from './auth.config.js';
import { getUser } from './auth.plugin.js';

// /api/auth/login is registered automatically by @fastify/oauth2
// (startRedirectPath in auth.plugin.ts) — it 302s to Discord.
export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/callback', async (req, reply) => {
    const { token } = await app.discordOAuth2.getAccessTokenFromAuthorizationCodeFlow(req);

    const res = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!res.ok) {
      reply.code(502);
      return { error: 'failed to fetch Discord profile' };
    }
    const profile = (await res.json()) as { id: string; username: string };

    if (!authConfig.allowedDiscordIds.has(profile.id)) {
      req.session.delete();
      reply.code(403).type('text/html');
      return `<!doctype html><meta charset=utf-8><title>Not authorised</title>
<body style="font-family:monospace;padding:2rem">
<h1>Not authorised</h1>
<p>Discord account <code>${profile.username}</code> (id ${profile.id}) is not on the allowlist.</p>
<p><a href="/api/auth/logout">try another account</a></p>`;
    }

    req.session.set('user', { id: profile.id, username: profile.username });
    reply.redirect('/');
  });

  app.get('/api/auth/logout', async (req, reply) => {
    req.session.delete();
    reply.redirect('/');
  });

  app.get('/api/auth/me', async (req, reply) => {
    const user = getUser(req);
    if (!user) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    return user;
  });
}
