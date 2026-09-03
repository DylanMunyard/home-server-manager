// Direct K8s REST client that fetches data through an SSH tunnel.
// No kubectl dependency — extracts creds from kubeconfig on the remote host,
// sets up an SSH port forward to the cluster API, and makes HTTPS calls with mTLS.

import { readFile } from 'node:fs/promises';
import { Client } from 'ssh2';
import { parse as parseYaml } from 'yaml';
import type { ServerConfig } from '../servers/servers.types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Kubeconfig parsing (minimal slices we care about)
// ─────────────────────────────────────────────────────────────────────────────

type KubeConfig = {
  clusters?: { name: string; cluster: { server?: string; 'certificate-authority-data'?: string } }[];
  contexts?: { name: string; context: { cluster?: string; user?: string } }[];
  users?: { name: string; user: { 'client-certificate-data'?: string; 'client-key-data'?: string; token?: string } }[];
  'current-context'?: string;
};

type ClusterAuth = {
  host: string;   // e.g., "127.0.0.1"
  port: number;   // e.g., 6443
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
};

/** Parse kubeconfig YAML and extract auth material for the current context. */
function parseKubeconfig(yaml: string): ClusterAuth {
  const cfg = parseYaml(yaml) as KubeConfig;
  const ctxName = cfg['current-context'];
  const ctx = cfg.contexts?.find((c) => c.name === ctxName)?.context;
  if (!ctx) throw new Error(`kubeconfig: no context '${ctxName}'`);

  const cluster = cfg.clusters?.find((c) => c.name === ctx.cluster)?.cluster;
  const user = cfg.users?.find((u) => u.name === ctx.user)?.user;
  if (!cluster?.server) throw new Error('kubeconfig: cluster server URL missing');
  if (!user) throw new Error('kubeconfig: user credentials missing');

  // Parse server URL (e.g., "https://127.0.0.1:6443")
  const url = new URL(cluster.server);
  const host = url.hostname;
  const port = url.port ? parseInt(url.port, 10) : 6443;

  // Decode base64 certs
  const ca = cluster['certificate-authority-data'];
  const cert = user['client-certificate-data'];
  const key = user['client-key-data'];
  if (!ca || !cert || !key) throw new Error('kubeconfig: missing CA or client cert/key');

  return {
    host,
    port,
    ca: Buffer.from(ca, 'base64'),
    cert: Buffer.from(cert, 'base64'),
    key: Buffer.from(key, 'base64'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SSH tunnel + HTTPS agent
// ─────────────────────────────────────────────────────────────────────────────

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

// Common kubeconfig locations to try in order
const KUBECONFIG_PATHS = [
  '/etc/rancher/k3s/k3s.yaml',           // k3s default
  '$HOME/.kube/config',                   // standard kubectl
  '/etc/kubernetes/admin.conf',           // kubeadm
  '/var/snap/microk8s/current/credentials/client.config', // microk8s
];

/** Fetch kubeconfig from remote server via SSH exec, trying multiple paths. */
async function fetchKubeconfig(conn: Client): Promise<string> {
  // Build a script that tries each path in order
  const script = `
    for f in ${KUBECONFIG_PATHS.join(' ')}; do
      f=$(eval echo "$f")  # expand $HOME
      if [ -r "$f" ]; then
        cat "$f"
        exit 0
      fi
    done
    echo "kubeconfig not found at any of: ${KUBECONFIG_PATHS.join(', ')}" >&2
    exit 1
  `;

  return new Promise((resolve, reject) => {
    conn.exec(`bash -c '${script.replace(/'/g, "'\\''")}'`, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      stream.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      stream.on('close', (code: number) => {
        if (code !== 0) return reject(new Error(`failed to read kubeconfig: ${stderr.trim() || `exit ${code}`}`));
        resolve(stdout);
      });
    });
  });
}

const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');

/** Decode HTTP chunked transfer encoding on raw byte buffers. */
function decodeChunked(buf: Buffer): string {
  const chunks: Buffer[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const lineEnd = buf.indexOf(CRLF, pos);
    if (lineEnd === -1) break;
    const sizeLine = buf.subarray(pos, lineEnd).toString('latin1').trim();
    const sizeHex = sizeLine.split(';')[0].trim();
    const size = parseInt(sizeHex, 16);
    if (isNaN(size) || size === 0) break;
    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + size;
    if (chunkEnd > buf.length) break;
    chunks.push(buf.subarray(chunkStart, chunkEnd));
    pos = chunkEnd + 2; // skip trailing \r\n
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Make an HTTPS request through an SSH tunnel with mTLS. */
function tunnelRequest(
  conn: Client,
  auth: ClusterAuth,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // SSH forwardOut: opens a channel to the remote host:port
    conn.forwardOut('127.0.0.1', 0, auth.host, auth.port, (err, channel) => {
      if (err) {
        console.error('[k8s] forwardOut failed:', err.message);
        return reject(err);
      }

      // Use TLS over the SSH channel for mTLS to the k8s API
      import('node:tls').then(({ connect }) => {
        const tlsSocket = connect({
          socket: channel as unknown as import('node:net').Socket,
          ca: auth.ca,
          cert: auth.cert,
          key: auth.key,
          // Don't set servername for IP addresses (deprecated in Node)
          servername: /^\d+\.\d+\.\d+\.\d+$/.test(auth.host) ? undefined : auth.host,
          rejectUnauthorized: true,
        });

        tlsSocket.on('error', (e) => {
          console.error('[k8s] TLS error:', e.message);
          reject(e);
        });

        tlsSocket.on('secureConnect', () => {
          // Write HTTP request
          const req = [
            `${method} ${path} HTTP/1.1`,
            `Host: ${auth.host}:${auth.port}`,
            'Accept: application/json',
            'Connection: close',
            '',
            '',
          ].join('\r\n');
          tlsSocket.write(req);
        });

        const chunks: Buffer[] = [];
        tlsSocket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        tlsSocket.on('end', () => {
          const raw = Buffer.concat(chunks);
          // Parse HTTP response - handle chunked encoding
          const headerEnd = raw.indexOf(DOUBLE_CRLF);
          if (headerEnd === -1) {
            console.error('[k8s] No HTTP headers in response, raw:', raw.subarray(0, 200).toString('latin1'));
            return reject(new Error('invalid HTTP response: no headers'));
          }

          const head = raw.subarray(0, headerEnd).toString('latin1');
          const bodyBuf = raw.subarray(headerEnd + 4);

          const statusLine = head.split('\r\n')[0];
          const statusMatch = /HTTP\/\d\.\d (\d+)/.exec(statusLine);
          const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

          // Handle chunked transfer encoding or raw UTF-8 body
          let body = '';
          if (/transfer-encoding:\s*chunked/i.test(head)) {
            body = decodeChunked(bodyBuf);
          } else {
            body = bodyBuf.toString('utf8');
          }

          if (status === 0) {
            console.error('[k8s] Failed to parse status line:', statusLine);
          }

          resolve({ status, body });
        });
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export type K8sApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type K8sSession = {
  /** GET a K8s API path (e.g., "/api/v1/nodes"). */
  get: <T>(path: string) => Promise<K8sApiResult<T>>;
  /** Close the SSH connection. */
  close: () => void;
};

/**
 * Establish an SSH connection to the server, fetch its kubeconfig, and return
 * a session that can make authenticated K8s API calls through the tunnel.
 */
export async function createK8sSession(server: ServerConfig): Promise<K8sSession> {
  const conn = new Client();

  await new Promise<void>((resolve, reject) => {
    conn.on('ready', resolve);
    conn.on('error', reject);
    buildConnectOptions(server)
      .then((opts) => conn.connect(opts))
      .catch(reject);
  });

  // Fetch and parse kubeconfig
  const kubeconfigYaml = await fetchKubeconfig(conn);
  const auth = parseKubeconfig(kubeconfigYaml);

  return {
    get: async <T>(path: string): Promise<K8sApiResult<T>> => {
      try {
        const { status, body } = await tunnelRequest(conn, auth, 'GET', path);
        if (status >= 200 && status < 300) {
          return { ok: true, data: JSON.parse(body) as T };
        }
        return { ok: false, error: `HTTP ${status}: ${body.slice(0, 200)}` };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    close: () => {
      try { conn.end(); } catch { /* ignore */ }
    },
  };
}

/**
 * One-shot: connect, fetch all K8s data, close. Returns nodes, pods, and
 * optionally metrics (if metrics-server is available).
 */
export async function fetchK8sSnapshot(
  server: ServerConfig,
  onProgress?: (phase: 'connecting' | 'kubeconfig' | 'nodes' | 'pods' | 'metrics') => void,
): Promise<K8sApiResult<{
  nodes: unknown;
  pods: unknown;
  metrics: unknown | null;
  durationMs: number;
}>> {
  const start = Date.now();
  const conn = new Client();

  try {
    onProgress?.('connecting');
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', resolve);
      conn.on('error', reject);
      buildConnectOptions(server)
        .then((opts) => conn.connect(opts))
        .catch(reject);
    });

    onProgress?.('kubeconfig');
    const kubeconfigYaml = await fetchKubeconfig(conn);
    const auth = parseKubeconfig(kubeconfigYaml);

    // Fetch nodes and pods in parallel
    onProgress?.('nodes');
    const nodesPromise = tunnelRequest(conn, auth, 'GET', '/api/v1/nodes');

    onProgress?.('pods');
    const podsPromise = tunnelRequest(conn, auth, 'GET', '/api/v1/pods');

    const [nodesRes, podsRes] = await Promise.all([nodesPromise, podsPromise]);

    if (nodesRes.status !== 200) {
      return { ok: false, error: `nodes: HTTP ${nodesRes.status}` };
    }
    if (podsRes.status !== 200) {
      return { ok: false, error: `pods: HTTP ${podsRes.status}` };
    }

    // Metrics may not be available
    onProgress?.('metrics');
    let metrics: unknown | null = null;
    try {
      const metricsRes = await tunnelRequest(conn, auth, 'GET', '/apis/metrics.k8s.io/v1beta1/pods');
      if (metricsRes.status === 200) {
        metrics = JSON.parse(metricsRes.body);
      }
    } catch {
      // Metrics unavailable — that's fine
    }

    return {
      ok: true,
      data: {
        nodes: JSON.parse(nodesRes.body),
        pods: JSON.parse(podsRes.body),
        metrics,
        durationMs: Date.now() - start,
      },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    try { conn.end(); } catch { /* ignore */ }
  }
}
