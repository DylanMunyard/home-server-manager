import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { loadServer } from '../servers/servers.loader.js';
import { loadDashboardConfig } from '../metrics/dashboard.loader.js';
import { createK8sSession, type K8sSession } from './k8s.client.js';
import {
  buildSnapshotFromApi, parseAlloc, parsePodsStructure,
  type MetricsPodList, type NodeList, type PodList,
} from './k8s.parse.js';
import type { K8sStreamEvent } from './k8s.types.js';

const POLL_MS = 20_000;

type WorkloadsQuery = { server?: string };

/**
 * Backs the dashboard's k3s panel. One WS per open panel holds one SSH session
 * (the expensive part — connect + kubeconfig — is paid once, not per refresh)
 * and loops a fetch cycle every ~20s: nodes/pods/metrics are requested in
 * parallel and `alloc`/`structure` events go out as each lands, so the UI
 * paints structure before the slow metrics call finishes; the authoritative
 * `snapshot` closes each cycle. Any client frame triggers an immediate cycle.
 * Connection-scoped and fully wrapped — can never take down the API. Auth is
 * the global guard (a 401 aborts the upgrade).
 */
export async function k8sRoutes(app: FastifyInstance) {
  app.get<{ Querystring: WorkloadsQuery }>('/ws/k8s/workloads', { websocket: true }, async (socket, req) => {
    const ws = socket as unknown as WebSocket;
    const send = (e: K8sStreamEvent) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); };

    const { server: serverId } = req.query;
    if (!serverId) { send({ type: 'error', message: 'missing server query param' }); ws.close(); return; }

    // Panel gate: only nodes with the k3s panel enabled in dashboard.yaml are
    // reachable — this route must not become an open k8s-API proxy. (Config is
    // re-read per connection; the collector snapshots it at boot, so a yaml
    // edit can briefly disagree until restart — harmless.)
    const cfg = await loadDashboardConfig();
    const node = cfg.nodes.find((n) => n.id === serverId);
    if (!node?.panels.includes('k3s')) {
      send({ type: 'error', message: `k3s panel not enabled for '${serverId}'` });
      ws.close();
      return;
    }

    const server = await loadServer(serverId);
    if (!server) { send({ type: 'error', message: `unknown server: ${serverId}` }); ws.close(); return; }

    let closed = false;
    let session: K8sSession | null = null;
    let wake: (() => void) | null = null;
    ws.on('close', () => { closed = true; session?.close(); wake?.(); });
    ws.on('message', () => wake?.());  // any client frame = refresh now

    try {
      session = await createK8sSession(server);  // SSH connect + kubeconfig — once
    } catch (err) {
      send({ type: 'error', message: (err as Error).message });
      ws.close();
      return;
    }
    if (closed) { session.close(); return; }

    let sentSnapshot = false;
    while (!closed) {
      const started = Date.now();
      const nodesP = session.get<NodeList>('/api/v1/nodes');
      const podsP = session.get<PodList>('/api/v1/pods');
      const metricsP = session.get<MetricsPodList>('/apis/metrics.k8s.io/v1beta1/pods');

      // Progressive: structure paints as soon as it lands; metrics is the slow
      // call. Only useful before the first full snapshot — the client ignores
      // later ones, so skip the (cheap but pointless) sends afterwards.
      if (!sentSnapshot) {
        nodesP.then((r) => { if (!closed && r.ok) send({ type: 'alloc', alloc: parseAlloc(r.data) }); });
        podsP.then((r) => {
          if (!closed && r.ok) {
            const { workloads, pods } = parsePodsStructure(r.data);
            send({ type: 'structure', workloads, pods });
          }
        });
      }

      const [nodes, pods, metrics] = await Promise.all([nodesP, podsP, metricsP]);
      if (closed) break;

      if (!nodes.ok || !pods.ok) {
        // SSH/tunnel/API failure — report and end; the client reconnects with
        // a backoff (which redoes the SSH connect, the right move for a dead
        // session).
        send({ type: 'error', message: !nodes.ok ? `nodes: ${nodes.error}` : `pods: ${(pods as { error: string }).error}` });
        break;
      }
      try {
        send({
          type: 'snapshot',
          snapshot: buildSnapshotFromApi(nodes.data, pods.data, metrics.ok ? metrics.data : null, Date.now() - started),
        });
        sentSnapshot = true;
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
        break;
      }

      // Sleep until the next cycle, a client refresh frame, or close.
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { wake = null; resolve(); }, POLL_MS);
        wake = () => { clearTimeout(t); wake = null; resolve(); };
      });
    }

    session.close();
    ws.close();
  });
}
