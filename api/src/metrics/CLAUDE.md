# Live dashboard — engine internals

Scope: `config/dashboard.yaml`, the collector (`api/src/metrics/`), the probe
(`config/scripts/metrics-stream.sh`), and the dashboard UI (`ui/src/metrics/`).
Root `CLAUDE.md` has the summary; this is the contract. The k3s `panels:` data
path lives in `api/src/k8s/CLAUDE.md`.

```yaml
# config/dashboard.yaml — all fields optional
interval: 5                 # seconds between samples
mounts: auto                # 'auto' itemises every real FS; or pin [/, /mnt/data]
retention: 2h               # ring-buffer window (s/m/h or bare seconds)
thresholds: { cpu: 90, mem: 90, disk: 85, temp: 80 }  # tile-colour only
nodes: all                  # or a list of <group>/<server> ids
paths:                      # du-sampled dirs per node (non-mounts df can't see)
  hetzner/bfstats: { neo4j: /var/lib/rancher/k3s/storage/pvc-..._neo4j-pvc }
inspect:                    # drill-down runbooks in the node detail view
  default: [top-cpu]
  hetzner/bfstats: [top-cpu, k3s-top]
panels:                     # rich detail-view panels per node ('k3s' only today)
  hetzner/bfstats: [k3s]
```

- **Zero-install probe.** `config/scripts/metrics-stream.sh` is a normal runbook
  that *loops*, emitting one NDJSON sample per `METRICS_INTERVAL` from `/proc` +
  `/sys` + `df` — no packages/sudo/TTY, same ethos as `temp-check`. CPU% is the
  delta of `/proc/stat` over each interval; temp reuses the sysfs sweep (hottest
  °C, `null` on sensor-less LXC/VM). Disk is **itemised per filesystem** from one
  `df` pass with the same pseudo-FS exclusions as `disk-usage.sh` (so data
  volumes show up next to `/`); `METRICS_MOUNTS=auto` reports all, an explicit
  list pins specific mounts. It never exits on its own — SIGTERM on teardown.
  Don't add a param expecting a one-shot run; it's a stream.
- **Always-on, in-memory collector.** `metrics.collector.ts` starts at boot
  (isolated from the fatal `listen` path like the job scheduler — **must never
  take down the API**) and holds one `streamMetrics` SSH connection per watched
  node, pushing samples into a **per-node ring buffer capped by `retention`**.
  No persistence, no DB — a restart refills in seconds (clone-and-go). A dropped
  stream marks the node `down` and reconnects on a backoff; a per-node failure
  never affects the others or the API.
- **Browsers read the buffer, never SSH.** `GET /api/metrics` is a snapshot for
  first paint; `GET /ws/metrics` sends that snapshot then forwards live
  `sample`/`status` events. Both are auth-gated by the global guard. The UI
  (`useMetrics`) caps its own copy to the same window. One shared collector
  feeds every tab/device — opening the dashboard doesn't open new connections.
- **`paths:` = du-sampled directories** (per node, label → absolute path) for
  dirs that are *not* mounts — e.g. k3s local-path-provisioner PVCs — so the
  `df` pass can't itemise them. No capacity exists (local-path PVCs aren't
  quota'd) ⇒ samples carry **absolute GiB used only** (`paths: [{label, path,
  used}]`), charted on an autoscaled axis, no threshold. `used: null` marks a
  missing/unreadable dir (kept visible, like `temp: null`). du is expensive, so
  the probe samples paths every 12th tick (≈60 s at the default interval) —
  incl. tick 0 — and carries the cached value into the samples in between; a du
  over a huge tree can delay that one sample, never kill the stream. Labels are
  restricted to `A-Za-z0-9._-` by the loader (they travel raw inside the
  `label=path` prelude lines and the probe's printf-built JSON — that check is
  the only sanitisation, keep it). The prelude is per-node (`METRICS_PATHS`).
- **`inspect:` = drill-down runbooks** shown as buttons in a node's detail view
  ("what's eating CPU right now?"). Each id is an ordinary runbook in
  `config/scripts/` — that's the plugin system: a new probe is just a new
  script (it'll also appear in the runbook console; intended). A node's list
  **replaces** `default`; unknown runbook/node ids warn + drop (same lenient
  stance as `nodes:`). Runs go over the existing auth-gated `/ws/run` +
  `useSshStream` + `Terminal` — zero bespoke exec plumbing (`InspectPanel` in
  `ui/src/metrics/`). Ships with `top-cpu` (ps by cpu/mem) and `k3s-top`
  (kubectl top, degrades when metrics-server is absent).
- **`panels:` = rich detail-view panels** per node (map node id → panel ids,
  validated against the known set — only `k3s` exists; enable it on the node
  that holds the kubeconfig, i.e. the control plane — data is cluster-wide).
  Implementation + invariants: `api/src/k8s/CLAUDE.md`.
- **Charts are visx** (D3 scales/shapes as React primitives) styled to the
  brutalist tokens — thin ink line, flat accent fill, monospace ticks, no
  gradients/shadows. `MetricChart` has `spark` (tile) and `full` (axed detail)
  variants. Threshold colours the line/bar red; **alerting still lives in jobs**
  (a disk/temp watchdog), not here — thresholds are display-only.
- **Mobile** gets a 4th tab (`dash`); the same `Dashboard` renders single-column
  via `.m-app .dash` token remap + grid override. Detail uses native scroll.
