import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import secureSession from '@fastify/secure-session';
import oauth2, { type OAuth2Namespace } from '@fastify/oauth2';
import { authConfig, type SessionUser } from './auth.config.js';

// secure-session stores the typed payload on request.session.
declare module '@fastify/secure-session' {
  interface SessionData {
    user: SessionUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    discordOAuth2: OAuth2Namespace;
  }
}

// Paths reachable without a session. Everything else (all /api/* and /ws/*) is
// gated by the onRequest hook below.
function isPublicPath(url: string): boolean {
  // Strip query string before matching.
  const path = url.split('?')[0];
  return path === '/api/health' || path.startsWith('/api/auth/');
}

export function getUser(req: FastifyRequest): SessionUser | undefined {
  return req.session.get('user');
}

// fp() breaks encapsulation so the session decorator + guard hook apply to the
// whole app, covering feature routes registered after this plugin.
export const authPlugin = fp(async (app: FastifyInstance) => {
  await app.register(cookie);

  await app.register(secureSession, {
    cookieName: 'hsm_session',
    secret: authConfig.sessionSecret,
    salt: authConfig.sessionSalt,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      // HTTPS-only in prod; allow plain HTTP on localhost for dev.
      secure: authConfig.isProd,
      // 30 days — personal tool, re-login on expiry is fine.
      maxAge: 60 * 60 * 24 * 30,
    },
  });

  await app.register(oauth2, {
    name: 'discordOAuth2',
    scope: ['identify'],
    credentials: {
      client: {
        id: authConfig.discordClientId,
        secret: authConfig.discordClientSecret,
      },
      auth: oauth2.DISCORD_CONFIGURATION,
    },
    startRedirectPath: '/api/auth/login',
    callbackUri: authConfig.callbackUri,
  });

  // Guard: require a session for everything except the public paths.
  app.addHook('onRequest', async (req, reply) => {
    if (isPublicPath(req.url)) return;
    if (getUser(req)) return;
    // Aborting here on a /ws/* upgrade returns a non-101 response, so the
    // browser WebSocket fails before any SSH connection is attempted.
    reply.code(401).send({ error: 'unauthorized' });
  });
}, { name: 'auth' });
