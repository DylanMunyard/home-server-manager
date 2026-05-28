import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel } from 'ssh2';
import type { ServerConfig } from '../servers/servers.types.js';

export type ShellEvent =
  | { type: 'connect' }
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null; signal?: string | null }
  | { type: 'error'; message: string };

export type ShellHandle = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
  done: Promise<void>;
};

async function buildConnectOptions(server: ServerConfig) {
  const base = {
    host: server.host,
    port: server.port,
    username: server.user,
    readyTimeout: 15_000,
    keepaliveInterval: 30_000,
  };
  if (server.auth.type === 'password') {
    return { ...base, password: server.auth.password };
  }
  const privateKey = await readFile(server.auth.privateKey);
  return { ...base, privateKey, passphrase: server.auth.passphrase };
}

export function openShell(
  server: ServerConfig,
  size: { cols: number; rows: number },
  onEvent: (e: ShellEvent) => void,
): ShellHandle {
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
      conn.shell(
        { term: 'xterm-256color', cols: size.cols, rows: size.rows },
        (err, s) => {
          if (err) { onEvent({ type: 'error', message: err.message }); finish(); return; }
          stream = s;
          s.on('data', (chunk: Buffer) => onEvent({ type: 'data', data: chunk.toString('utf8') }));
          s.stderr.on('data', (chunk: Buffer) => onEvent({ type: 'data', data: chunk.toString('utf8') }));
          s.on('close', (code: number | null, signal: string | null) => {
            onEvent({ type: 'exit', code, signal });
            finish();
          });
        },
      );
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
    write: (data) => { try { stream?.write(data); } catch { /* ignore */ } },
    resize: (cols, rows) => { try { stream?.setWindow(rows, cols, 0, 0); } catch { /* ignore */ } },
    close: () => {
      try { stream?.end(); } catch { /* ignore */ }
      try { conn.end(); } catch { /* ignore */ }
    },
    done,
  };
}
