import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel } from 'ssh2';
import type { ServerConfig } from '../servers/servers.types.js';
import type { MetricSample } from './metrics.types.js';

// A long-lived metrics stream: runs the probe over `bash -s` and surfaces one
// parsed sample per NDJSON line. Mirrors ssh.session/ssh.shell but line-buffers
// stdout (SSH chunks don't respect line boundaries) and parses JSON. The script
// loops forever; the stream ends when the host drops it or cancel() sends TERM,
// at which point `done` resolves and the collector reconnects.

export type MetricsHandlers = {
  onConnect?: () => void;
  onSample: (sample: MetricSample) => void;
  onError?: (message: string) => void;
};

export type MetricsHandle = { cancel: () => void; done: Promise<void> };

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

export function streamMetrics(
  server: ServerConfig,
  script: string,
  h: MetricsHandlers,
): MetricsHandle {
  const conn = new Client();
  let stream: ClientChannel | null = null;
  let settled = false;
  let buf = '';

  const done = new Promise<void>((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* ignore */ }
      resolve();
    };

    conn.on('ready', () => {
      h.onConnect?.();
      conn.exec('bash -s', (err, s) => {
        if (err) { h.onError?.(err.message); finish(); return; }
        stream = s;
        s.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { h.onSample(JSON.parse(line) as MetricSample); }
            catch { /* partial/garbage line — drop it */ }
          }
        });
        // Probe writes only JSON to stdout; stderr is bash noise — surface as a
        // non-fatal error note, the close handler drives reconnect.
        s.stderr.on('data', (chunk: Buffer) => h.onError?.(chunk.toString('utf8').trim()));
        s.on('close', () => finish());
        s.end(script);
      });
    });

    conn.on('error', (err) => { h.onError?.(err.message); finish(); });

    buildConnectOptions(server)
      .then((opts) => conn.connect(opts))
      .catch((err: Error) => { h.onError?.(err.message); finish(); });
  });

  return {
    cancel: () => {
      try { stream?.signal('TERM'); } catch { /* ignore */ }
      try { conn.end(); } catch { /* ignore */ }
    },
    done,
  };
}
