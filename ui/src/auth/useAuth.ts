import { useEffect, useState } from 'react';

export type AuthUser = { id: string; username: string };
export type AuthStatus = 'loading' | 'authed' | 'anon';

// Fetches /api/auth/me once on mount. A 401 means "not signed in" (expected,
// not an error) — so this calls fetch directly rather than the shared api.ts
// helpers, which redirect to login on 401 and would loop here.
export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((u: AuthUser | null) => {
        if (cancelled) return;
        if (u) { setUser(u); setStatus('authed'); }
        else   { setUser(null); setStatus('anon'); }
      })
      .catch(() => { if (!cancelled) setStatus('anon'); });
    return () => { cancelled = true; };
  }, []);

  return { status, user };
}
