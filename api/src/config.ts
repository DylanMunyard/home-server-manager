import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));

export const paths = {
  repoRoot:   resolve(here, '../..'),
  configRoot: resolve(here, '../../config'),
  servers:    resolve(here, '../../config/servers'),
  scripts:    resolve(here, '../../config/scripts'),
  jobs:       resolve(here, '../../config/jobs'),
  envFile:    resolve(here, '../../.env'),
};

// Load .env from repo root before any module reads process.env.
// Shell-set vars win over .env (override: false is the default).
dotenv.config({ path: paths.envFile });

export const PORT = Number(process.env.PORT ?? 5781);

/**
 * Substitutes ${VAR} references with values from process.env. Throws if any
 * referenced variable is unset — easier to debug than a silent empty string
 * that becomes a failed SSH auth ten seconds later.
 */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`env var \${${name}} is not set — define it in .env or the shell environment`);
    }
    return v;
  });
}
