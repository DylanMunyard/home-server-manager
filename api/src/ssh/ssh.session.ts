import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel } from 'ssh2';
import type { ServerConfig } from '../servers/servers.types.js';

export type RunEvent =
  | { type: 'connect' }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number | null; signal?: string | null }
  | { type: 'error'; message: string };

export type RunHandle = {
  cancel: () => void;
  done: Promise<void>;
};

async function buildConnectOptions(server: ServerConfig) {
  const base = {
    host: server.host,
    port: server.port,
    username: server.user,
    readyTimeout: 15_000,
  };
  if (server.auth.type === 'password') {
    return { ...base, password: server.auth.password };
  }
  const privateKey = await readFile(server.auth.privateKey);
  return { ...base, privateKey, passphrase: server.auth.passphrase };
}

export function runScript(
  server: ServerConfig,
  script: string,
  onEvent: (e: RunEvent) => void,
): RunHandle {
  const conn = new Client();
  let stream: ClientChannel | null = null;
  let settled = false;

  const done = new Promise<void>((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* ignore */ }
      resolve();
    };

    conn.on('ready', () => {
      onEvent({ type: 'connect' });
      conn.exec('bash -s', (err, s) => {
        if (err) {
          onEvent({ type: 'error', message: err.message });
          finish();
          return;
        }
        stream = s;
        s.on('data', (chunk: Buffer) => onEvent({ type: 'stdout', data: chunk.toString('utf8') }));
        s.stderr.on('data', (chunk: Buffer) => onEvent({ type: 'stderr', data: chunk.toString('utf8') }));
        s.on('close', (code: number | null, signal: string | null) => {
          onEvent({ type: 'exit', code, signal });
          finish();
        });
        s.end(script);
      });
    });

    conn.on('error', (err) => {
      onEvent({ type: 'error', message: err.message });
      finish();
    });

    buildConnectOptions(server)
      .then((opts) => conn.connect(opts))
      .catch((err: Error) => {
        onEvent({ type: 'error', message: err.message });
        finish();
      });
  });

  return {
    cancel: () => {
      try { stream?.signal('TERM'); } catch { /* ignore */ }
      try { conn.end(); } catch { /* ignore */ }
    },
    done,
  };
}
