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
then: pia-vpn-reset          # OPTIONAL: runbook run when `when` matches
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
- **Notify semantics:** `action` fires whenever `then` runs (informational);
  `error` fires when the *effective work runbook* fails — `then` if it ran, else
  `run` when the job has no `when` (a check's nonzero exit is a signal, not a
  failure), or any SSH-level error. ntfy payload carries job/target/runbook +
  raw output. ntfy is env-driven (`NTFY_URL`/`NTFY_TOPIC`/`NTFY_TOKEN`); unset
  topic ⇒ alerting disabled (no-op, not a startup failure).
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
