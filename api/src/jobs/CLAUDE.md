# Recurring jobs — engine internals

Scope: `config/jobs/*.yaml`, the engine (`api/src/jobs/`), alerts
(`api/src/alerts/`), and the jobs UI (`ui/src/jobs/`). Root `CLAUDE.md` has the
summary; this is the contract — read before changing the loader, scheduler, or
notify semantics.

```yaml
# config/jobs/vpn-watchdog.yaml
name: VPN watchdog
schedule: "*/5 * * * *"      # 5-field cron, evaluated in the API process TZ
target: bethany/proxmox      # global server id, OR a list (see multi-target below)
run: vpn-check               # runbook executed each tick — the "check"
when: { exit: nonzero }      # OPTIONAL: when does the check mean "remediate"?
then: pia-vpn-reset          # OPTIONAL: runbook (or list) run when `when` matches
params: { PKG: htop }        # OPTIONAL: values for the runbook's `# params:`
notify: { on: [action, error], priority: high }   # OPTIONAL: ntfy alerts
```

- **In-memory scheduler, no persistence by design.** The scheduler lives in the
  API process (`jobs.scheduler.ts`, croner); on restart, schedules start fresh.
  No DB, no run history, no state file — same clone-and-go property as the rest.
  Holds last-run state in a `Map` only (surfaced read-only at `GET /api/jobs`).
- **Multi-target fan-out.** `target` accepts a single `<group>/<server>` string
  *or* a YAML list. The engine normalises to `targets[]` and runs the check (+
  `then` + alerts) against each host **in parallel**, with independent results.
  Per-target outcomes are surfaced under `state.targets` (keyed by server id) at
  `GET /api/jobs`. `params`/`env` are job-wide — group hosts that share a
  threshold/config in one job; split when they differ (e.g. x86 vs Pi temps).
- **Runbooks signal via exit code.** A check exits nonzero to mean "act". The
  engine stays dumb; put the logic in bash (curl + `jq` + compare → exit 0/1).
- **`when.exit`** ∈ `nonzero` (default) | `zero` | `<int>`; optional
  `stdout_contains` is ANDed. `then` requires a `when`.
- **`then` is a chain.** A single runbook id or a YAML list (normalised to
  `then: string[]`, same pattern as `target` → `targets`). On trigger the chain
  runs **sequentially in declared order** — entries often sample the same
  resources (perf, nsenter) and their alert sections should read in order — and
  one entry failing does NOT stop the rest (a later diagnostic may still carry
  the signal). Per-runbook results land in `state.targets[t].lastActions[]`
  (run order, surfaced by `GET /api/jobs` and the Last-run tab). Use a single
  entry for classic remediation; a list for diagnostics whose combined output
  IS the alert (e.g. dotnet-hot-threads + dotnet-cpu-profile).
- **"Test fire" = forced manual run.** `POST /api/jobs/:id/run` with
  `{ force: true }` (the Test fire button) treats the `when` gate as tripped:
  the check still runs (its output is the alert's "reason" section), the `then`
  chain executes FOR REAL, and the real `action`/`error` alerts fire with
  titles marked "(test fire)". This is the way to test the alert pipeline —
  `/api/alerts/test` ("Test alert") is a synthetic push, nothing runs. Mind
  jobs whose `then` has side effects (vpn-watchdog resets the tunnel).
- **Sustained/consecutive thresholds live in the check script, not here.** The
  engine has no debounce concept on purpose. Each check keeps a tiny state file
  on the target and exits nonzero exactly once per incident:
  `temp-check` (time-based sustain + hysteresis), `node-health` (per-signal —
  BREACH_COUNT consecutive **OR** WINDOW_BREACHES-of-WINDOW_SIZE bursty, and it
  re-arms only on a fully clean window), and `oom-check` (edge-triggered: a
  timestamp watermark, so it reports each kernel OOM kill exactly once).
- **Level vs edge checks.** Threshold checks (`node-health`, `temp-check`) watch
  a value and can miss a problem that keeps *resolving itself* — an OOM kill
  frees the memory that would have tripped the threshold, so a node being eaten
  alive reads healthy between kills. Edge checks (`oom-check`) report events the
  kernel already recorded, so they fire on the first occurrence. The two are
  complementary; `bfstats-watchdog` and `oom-watchdog` run both against the same
  host deliberately.
- **Notify semantics:** `action` fires whenever the `then` chain runs
  (informational) — ONE combined push per target: the check's output (the
  trigger reason) plus a section per `then` runbook, each clipped so the body
  stays under ntfy's ~4 KB inline limit (full output in the jobs UI). `error`
  fires when the *effective work runbook* fails — any `then` entry if the chain
  ran (the push carries the first failure's output), else `run` when the job
  has no `when` (a check's nonzero exit is a signal, not a failure), or any
  SSH-level error. ntfy is env-driven (`NTFY_URL`/`NTFY_TOPIC`/`NTFY_TOKEN`);
  unset topic ⇒ alerting disabled (no-op, not a startup failure).
- **Jobs are auxiliary — they must never take down the API.** `loadJobs`
  (`jobs.loader.ts`) validates each file independently (cron parses;
  `target`/`run`/`then` resolve to real servers/runbooks) and *skips + logs* a
  malformed one rather than throwing, so the other jobs (and the API) survive.
  `startScheduler` is isolated from the fatal `listen` path in `server.ts` and
  logs on failure instead of `process.exit`. Contrast `auth.config.ts`, which
  *does* fail boot — but auth gates every route, so it's load-bearing; jobs
  aren't. (A script failing at run time is likewise caught in the runner.)
- **`env:` injects secrets into runbooks.** Runbooks execute remotely via
  `bash -s`, so the API process env does *not* reach them. A job's optional
  `env: { NAME: ${VAR} }` is resolved from process env (`.env`/k8s secret) and
  prepended as `export NAME=…` to the job's runbooks before they're sent over
  SSH — the script reads `$NAME` normally. Do **not** try to `${VAR}`-expand
  script *text*: bash uses `${...}` itself and it would collide. Values are
  stored RAW in `JobConfig` (resolved only at run time) so `GET /api/jobs` never
  leaks the secret; an unset `${VAR}` surfaces as a per-run error (in the job's
  last-run state + logs), never a failed boot.
- **`params:` supplies a runbook's declared inputs.** Optional
  `params: { NAME: value }` — *literal* values for the target runbook's
  `# params:` (see `api/src/runbooks/CLAUDE.md`). Resolved per-runbook at run
  time via the same path as a manual run: the runbook's declared defaults fill
  in for anything omitted, undeclared keys are dropped, and `run`/`then` each
  get only what they declare. Distinct from `env`: params are plain non-secret
  values (surfaced by `GET /api/jobs`) and map to declared inputs; `env` is for
  `${VAR}` secrets. On a name collision params win (injected after env).
- **`investigate:`** is an optional intent hint for the AI investigator's
  manual runs — see `api/src/ai/CLAUDE.md`.
