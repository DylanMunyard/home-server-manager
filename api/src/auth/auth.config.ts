// Auth configuration, read + validated once at startup. Fails loud on missing
// values — mirrors the throw-on-missing philosophy of expandEnv in config.ts.
// All values come from env: .env locally, the home-server-mgr-secrets k8s
// Secret in prod. No secrets file, no secrets manager (see CLAUDE.md).

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`env var ${name} is not set — define it in .env or the shell environment`);
  }
  return v;
}

const sessionSecret = required('SESSION_SECRET');
if (sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters');
}

const sessionSalt = required('SESSION_SALT');
if (sessionSalt.length !== 16) {
  throw new Error('SESSION_SALT must be exactly 16 characters');
}

const publicUrl = required('PUBLIC_URL').replace(/\/$/, '');

export const authConfig = {
  discordClientId:     required('DISCORD_CLIENT_ID'),
  discordClientSecret: required('DISCORD_CLIENT_SECRET'),
  // Comma-separated Discord user ids allowed to sign in. Single-user app, but
  // a list keeps it trivial to grant a second identity without code changes.
  allowedDiscordIds: new Set(
    required('ALLOWED_DISCORD_IDS').split(',').map((s) => s.trim()).filter(Boolean),
  ),
  publicUrl,
  callbackUri: `${publicUrl}/api/auth/callback`,
  sessionSecret,
  sessionSalt,
  isProd: process.env.NODE_ENV === 'production',
};

export type SessionUser = { id: string; username: string };
