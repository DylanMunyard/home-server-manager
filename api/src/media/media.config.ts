import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { expandEnv, paths } from '../config.js';
import type { MediaServiceId } from './media.types.js';

/**
 * config/media.yaml loader — lenient like dashboard.loader.ts, with one
 * deliberate divergence from servers.loader: an unset ${VAR} does NOT throw.
 * expandEnv's throw is caught per service and disables just that service with
 * a warning, because media is auxiliary (a clone-and-go checkout shouldn't
 * need Radarr to run runbooks) — whereas a server's missing secret must fail
 * loudly at boot. Each service is independently optional; `enabled` needs at
 * least one arr (Plex alone has nothing to list).
 */
export type MediaServiceConfig = { url: string; apiKey: string }; // apiKey doubles as the Plex token

export type MediaConfig = {
  radarr: MediaServiceConfig | null;
  sonarr: MediaServiceConfig | null;
  plex: MediaServiceConfig | null;
  enabled: boolean;
  // Human reason per disabled service, for the snapshot's `services` map.
  disabledReason: Partial<Record<MediaServiceId, string>>;
};

const FILE = resolve(paths.configRoot, 'media.yaml');

type RawService = { url?: unknown; apiKey?: unknown; token?: unknown };
type RawMedia = Partial<Record<MediaServiceId, RawService>>;

const DISABLED: MediaConfig = {
  radarr: null, sonarr: null, plex: null, enabled: false,
  disabledReason: { radarr: 'not configured', sonarr: 'not configured', plex: 'not configured' },
};

// The config re-loads per request, so repeat the same warning only once —
// the disabled state is already visible in /api/media's `services` map.
const warned = new Set<string>();
function warnOnce(msg: string) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

function resolveService(id: MediaServiceId, raw: RawService | undefined):
  { cfg: MediaServiceConfig | null; reason?: string } {
  if (!raw || typeof raw !== 'object') return { cfg: null, reason: 'not configured' };

  const url = String(raw.url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) {
    warnOnce(`[media] ${id} disabled: url missing or not http(s)`);
    return { cfg: null, reason: 'invalid url' };
  }

  const rawKey = String((id === 'plex' ? raw.token : raw.apiKey) ?? '').trim();
  try {
    const apiKey = expandEnv(rawKey).trim();
    if (!apiKey) {
      warnOnce(`[media] ${id} disabled: ${id === 'plex' ? 'token' : 'apiKey'} is empty`);
      return { cfg: null, reason: 'no api key' };
    }
    return { cfg: { url, apiKey } };
  } catch (err) {
    // The deliberate divergence: catch expandEnv's unset-var throw and degrade.
    warnOnce(`[media] ${id} disabled: ${(err as Error).message}`);
    return { cfg: null, reason: (err as Error).message };
  }
}

/** Re-read per request (cheap, like loadAiConfig) — a .env/yaml edit takes
 *  effect on the next refresh without a restart. Never throws. */
export async function loadMediaConfig(): Promise<MediaConfig> {
  let raw: RawMedia;
  try {
    raw = (YAML.parse(await readFile(FILE, 'utf8')) ?? {}) as RawMedia;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      warnOnce('[media] config/media.yaml missing — media view disabled');
    } else {
      warnOnce(`[media] config/media.yaml unreadable — media view disabled: ${(err as Error).message}`);
    }
    return DISABLED;
  }

  const disabledReason: MediaConfig['disabledReason'] = {};
  const services = {} as Record<MediaServiceId, MediaServiceConfig | null>;
  for (const id of ['radarr', 'sonarr', 'plex'] as const) {
    const { cfg, reason } = resolveService(id, raw[id]);
    services[id] = cfg;
    if (reason) disabledReason[id] = reason;
  }

  return {
    ...services,
    enabled: !!(services.radarr || services.sonarr),
    disabledReason,
  };
}
