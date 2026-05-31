import { dirname } from 'node:path';

/**
 * Reject obviously-dangerous targets before a path ever reaches `bash -s`. The
 * browser only ever feeds absolute paths it got from a prior listing, so this is
 * fat-finger / malformed-request protection, not an authz boundary (the session
 * already has full SSH). The bash scripts re-check defensively.
 */
export function validatePath(path: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string' || path === '') return { ok: false, error: 'path is required' };
  if (!path.startsWith('/')) return { ok: false, error: 'path must be absolute' };
  if (path.includes('\0')) return { ok: false, error: 'path contains a null byte' };
  return { ok: true, path };
}

/** Same as validatePath but additionally refuses the filesystem root for deletes. */
export function validateDeletePath(path: unknown): { ok: true; path: string } | { ok: false; error: string } {
  const v = validatePath(path);
  if (!v.ok) return v;
  if (v.path === '/') return { ok: false, error: 'refusing to delete /' };
  return v;
}

/** Parent directory for breadcrumb up-nav; null at the filesystem root. */
export function parentOf(path: string): string | null {
  if (path === '/') return null;
  const p = dirname(path.replace(/\/+$/, '') || '/');
  return p;
}
