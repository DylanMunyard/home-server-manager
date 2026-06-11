# k3s dashboard panel — data path + invariants

Scope: `api/src/k8s/` (`k8s.client.ts`, `k8s.parse.ts`, the `/ws/k8s/workloads`
route) and the panel UI in `ui/src/metrics/`. Enabled per node via `panels:` in
`config/dashboard.yaml` (see `api/src/metrics/CLAUDE.md`).

The k3s panel is the "what's eating CPU" workload visualisation: per-workload
CPU/mem (prominent values + comparator bars scaled to the biggest consumer in
view; red when hot vs node allocatable × the dashboard thresholds) with an
in-place click-through to a per-namespace pods table (a client-side filter of
the same payload — zero extra fetches).

- **Data path: no kubectl.** `k8s.client.ts` SSHes in, reads the kubeconfig
  (k3s/kubectl/kubeadm/microk8s paths), then port-forwards through the same SSH
  connection to the cluster API and speaks HTTPS+mTLS directly.
- **Streaming, panel-scoped:** one `/ws/k8s/workloads` connection per open
  panel holds one SSH session (connect + kubeconfig paid once, NOT per refresh
  — load-bearing for distant hosts) and loops ~20 s cycles: nodes/pods/metrics
  fetched in parallel, `alloc` + `structure` events emitted as each lands (fast
  first paint), then the authoritative `snapshot`; any client frame forces an
  immediate cycle; the UI reconnects on a backoff and keeps the last good
  snapshot through errors.
- **Parsing/aggregation is `k8s.parse.ts`** (pure, fixture-testable): pods
  grouped by top-level owner (ReplicaSet→Deployment via pod-template-hash
  strip; `name-<epoch>` Jobs→CronJob — documented heuristics) with an exact
  pod→workload index for the metrics overlay (don't regress to name-prefix
  matching).
- The route **403s for nodes without the panel** (not an open k8s-API proxy),
  is connection-scoped and fully wrapped (can't take down the API), and
  degrades: metrics API absent ⇒ structure renders with `—` usage; cluster
  down ⇒ inline error. No history/ring buffer by design.
- (A future SSH/kubectl fallback may return for hosts where the
  kubeconfig/API path doesn't work.)
