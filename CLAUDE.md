# home-server-mgr — agent instructions

Web UI + API to SSH into the user's home/side-project servers and stream script
("runbook") output live. Personal-infra scope — single user. Internet-exposed at
`mgr.munyard.dev` via a Cloudflare Tunnel, gated by Discord OAuth (see "Auth").

## Layout

```
api/                Fastify + ssh2 + WebSocket — TypeScript ESM, tsx watch
  src/<feature>/    feature folders directly under src/ (see "Conventions")
ui/                 React + Vite + xterm.js — TypeScript
  src/<feature>/    same rule
  src/App.tsx       slim chooser: renders DesktopApp or MobileApp by viewport
  src/desktop/      desktop shell (tri-column rail/stage/rail)
  src/mobile/       mobile shell (bottom tab bar + stack-style navigation)
config/
  servers/*.yaml    one file per server group (see "Server YAML")
  scripts/*.sh      one file per runbook (see "Runbook scripts")
  jobs/*.yaml       one file per recurring job (see "Recurring jobs")
dev/run.sh          starts both stacks with prefixed output (see "Verify")
```

## Conventions (non-negotiable)

- **Feature-first folders directly under `src/`** — `src/servers/`, `src/runbooks/`,
  `src/ssh/`, `src/terminal/`. Never `src/features/...`, never `Controllers/`
  / `Services/` / `Models/` type-grouping. Filenames inside say what they are
  (`servers.routes.ts`, `servers.loader.ts`, `useServers.ts`).
- **File-based config only.** No database, no Redis, no persistent state outside
  the `config/` dir. The "clone the repo and go" property is load-bearing —
  preserve it on every change.
- **No backwards-compatibility shims.** This is a personal tool — change the
  shape, update the consumers, move on. Don't introduce feature flags or
  legacy aliases.

## Server YAML — one file per group

Filename stem = group id (immutable identifier). `name:` is cosmetic only.

```yaml
name: bethany                      # display label (optional)
description: Proxmox host + LXCs   # optional
defaults:                          # merged into each server; server fields win
  user: dylan
  key:  ~/.ssh/id_ed25519
servers:
  - { id: proxmox,    host: 192.168.1.215 }
  - { id: plex,       host: 192.168.1.36, name: "plex" }
```

- **Global server id is `<group>/<server>`** (e.g. `bethany/proxmox`). Used in
  URLs and WS query params; URL-encode slashes for transport.
- **Auth precedence:** if a server entry sets `key:` or `password:`, it picks
  its own auth method completely — defaults supply auth only when the server
  entry sets neither. Avoids weird partial inheritance.
- **Key paths use `~/...` for portability.** Resolved to the API process's
  `$HOME` at load time (via `os.homedir()`). This is intentional — the same
  checked-in config works on any machine that has the key at that path.
  Don't "fix" tildes to absolute paths.
- `${ENV_VAR}` is resolved from process env (see "Secrets" below). Use it for
  passwords/passphrases; never hard-code secrets in YAML. Referencing an unset
  var is a fatal load error — the loader throws rather than silently using an
  empty string, so a missing secret fails loudly at startup, not at SSH-time.
- Singleton servers (e.g. Hetzner side project) get a one-server group file —
  no special "standalone" mode.

## Runbook scripts

```bash
#!/usr/bin/env bash
# pia-vpn-reset — regen wireguard + restart tunnel
set -euo pipefail
...
```

- Filename stem = runbook id.
- Description = first contiguous `#` comment block after the shebang.
  A leading `<id><sep>` on line 1 is stripped (sep ∈ `— – : -`).
- Scripts execute server-side via `bash -s` over an SSH exec channel — the
  shebang is ignored at runtime; it's there for local editor tooling.
- **No TTY** is allocated. Scripts that prompt (e.g. interactive `sudo`) will
  hang. Configure passwordless sudo on the target for the relevant commands.

### Runbook inputs (`# params:`)

A runbook declares inputs with a YAML block in the header comment — a *config
convention* (same shape as a job's `env:`), deliberately not a bespoke sigil DSL,
so a new runbook reads like the rest of the YAML config. The block is parsed by
stripping the leading `# ` (same as the description), so it stays valid bash.

```bash
#!/usr/bin/env bash
# install-pkg — install any package via the detected manager
#
# params:
#   PKG:     { label: Package to install, required: true }
#   MANAGER: { label: Force a package manager, default: auto, choices: [auto, apt, brew] }

set -euo pipefail
echo "installing $PKG with $MANAGER"
```

- **Map keyed by the env-var name.** The key is the shell variable the script
  reads (`$PKG`); it must be a valid identifier. Per-param fields are all
  optional: `label` (UI text, defaults to the key), `required` (UI blocks Run
  until filled), `default` (prefill + fallback), `choices` (list ⇒ a `<select>`,
  resolves to the first entry when unset). It's real YAML flow syntax, so a value
  containing `,` `:` `{` `}` must be quoted (`label: "host, port"`).
- **Values inject exactly like a job's `env:`** — resolved server-side, shell-
  quoted, and prepended as `export NAME=…` before the script is piped to
  `bash -s` (shared builder: `api/src/ssh/prelude.ts`). The script just reads
  `$NAME`. Only *declared* params are ever injected (unknown client keys are
  dropped — no arbitrary-env injection), and every declared param is always set
  (empty string at worst), so scripts stay safe under `set -u`.
- **No prompting.** Inputs come from the UI before the run, not an interactive
  prompt — there's no TTY (see above). Don't declare a param expecting `read`.
- **Recurring jobs** feed a parameterized runbook through their own `env:` (params
  *are* env vars); the job author supplies values there, the param UI is only for
  manual runs. A malformed `# params:` block is non-fatal — it logs a warning and
  the runbook loads with no params (same "don't take down the API" stance as jobs).

## Recurring jobs — one file per job

Cron-scheduled runbooks with optional conditional remediation + ntfy alerts.
Filename stem = job id. Engine is `api/src/jobs/`; alerts are `api/src/alerts/`.

```yaml
# config/jobs/vpn-watchdog.yaml
name: VPN watchdog
schedule: "*/5 * * * *"      # 5-field cron, evaluated in the API process TZ
target: bethany/proxmox      # global server id (<group>/<server>)
run: vpn-check               # runbook executed each tick — the "check"
when: { exit: nonzero }      # OPTIONAL: when does the check mean "remediate"?
then: pia-vpn-reset          # OPTIONAL: runbook run when `when` matches
notify: { on: [action, error], priority: high }   # OPTIONAL: ntfy alerts
```

- **In-memory scheduler, no persistence by design.** The scheduler lives in the
  API process (`jobs.scheduler.ts`, croner); on restart, schedules start fresh.
  No DB, no run history, no state file — same clone-and-go property as the rest.
  Holds last-run state in a `Map` only (surfaced read-only at `GET /api/jobs`).
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

## Secrets

Anything sensitive (key passphrases, SSH passwords) lives in `.env` at the
**repo root** — gitignored. The API loads it via `dotenv` before any config
read, populating `process.env`, which the YAML `${VAR}` substitution then
picks up. Workflow:

```
cp .env.example .env       # template is checked in; .env is not
$EDITOR .env               # fill in values
```

```yaml
# config/servers/bethany.yaml
defaults:
  key:        ~/.ssh/id_ed25519
  passphrase: ${ID_ED25519_PASSPHRASE}   # value supplied by .env
```

Rules:
- Don't add a `secrets.yaml` or similar — one secrets location only.
- Don't introduce a secrets manager (Vault/SOPS/AWS Secrets) — explicit
  non-goal for personal infra. If the user ever asks for one, that's a
  scope decision to confirm before implementing.
- Shell-set env vars win over `.env` (dotenv `override: false` — the default).
  Useful for one-off overrides without editing the file.

## Auth

The app is internet-exposed, so every `/api/*` and `/ws/*` route is gated behind
a **Discord OAuth** login (`api/src/auth/`). It's single-user: an allowlist of
Discord user ids (`ALLOWED_DISCORD_IDS`) is the entire authz model.

- **Session = stateless encrypted cookie** (`@fastify/secure-session`, cookie
  `hsm_session`). No server-side session store — keeps the no-DB / clone-and-go
  property. Don't add Redis or a session table.
- **The guard** is one `onRequest` hook in `auth.plugin.ts`. Public paths:
  `/api/health` (k8s liveness + verify loop) and `/api/auth/*`. Everything else
  needs a session, including the WS upgrades — a 401 there aborts the upgrade
  before any SSH connection.
- **Config is env-driven** (see `.env.example`): `DISCORD_CLIENT_ID`,
  `DISCORD_CLIENT_SECRET`, `ALLOWED_DISCORD_IDS`, `PUBLIC_URL`, `SESSION_SECRET`
  (≥32 chars), `SESSION_SALT` (exactly 16). `auth.config.ts` throws at startup
  if any is missing/invalid — fail loud, same as the YAML loader.
- **`PUBLIC_URL`** builds the OAuth callback (`${PUBLIC_URL}/api/auth/callback`)
  and gates the `Secure` cookie flag (on only when `NODE_ENV=production`, which
  the prod image bakes in — so cookies work over plain-HTTP localhost in dev).
- **Local dev uses the real OAuth flow** (no bypass): register
  `http://localhost:5780/api/auth/callback` as a second redirect URL in the
  Discord app and log in once; the cookie persists.
- **Frontend** gates at `ui/src/App.tsx` via `useAuth()` (`auth/`) — anon →
  `LoginScreen`, so the terminal WS only ever opens once authed. `shared/api.ts`
  bounces a `401` to `/api/auth/login` for mid-session expiry.

## Ports

- UI dev server: **5780**
- API: **5781** (overridable via `PORT` env var)

They're paired and intentionally off the common defaults (Vite's 5173, Node's
3000). Vite proxies `/api` and `/ws` to the API.

## Run + verify (do this after any `api/` or `ui/` change)

Don't claim a change works because it type-checks. Run the stack and probe it.
The user explicitly prefers the dev-script + curl loop over Playwright for
quick checks.

1. **Start both stacks in background:**
   ```bash
   ./dev/run.sh
   ```
   Run via Bash with `run_in_background: true`. Auto-installs `node_modules`
   on first run. Output is colour-prefixed `[api]` / `[ui]` to the task's
   output file.

2. **Wait for readiness** (one-shot Bash background, exits when both up):
   ```bash
   until curl -fsS http://localhost:5781/api/health >/dev/null 2>&1 \
      && curl -fsS http://localhost:5780/ >/dev/null 2>&1; do sleep 2; done
   ```

3. **Probe BOTH paths** — the API directly AND through the UI proxy:
   ```bash
   curl -sS http://localhost:5781/api/groups     # API direct
   curl -sS http://localhost:5780/api/groups     # via UI proxy
   ```
   Both must return the same payload. If direct works but proxy doesn't, it's
   almost certainly the IPv4/IPv6 gotcha below.

4. **Scan the dev log** for the issues curl won't surface:
   ```bash
   grep -iE 'error|econnrefused|warn' <task-output-file>
   ```

## Gotchas

- **IPv4/IPv6 — `localhost` vs `127.0.0.1`.** Fastify binds `0.0.0.0` (IPv4
  only). Node 17+ resolves `localhost` to `::1` first, so anything proxying
  to `http://localhost:5781` fails with `ECONNREFUSED ::1:5781`. The Vite
  proxy targets are pinned to `127.0.0.1` for exactly this reason. If you
  add another caller-of-the-API, do the same.
- **Server id namespacing in WS URLs.** The browser will percent-encode `/`
  to `%2F` in `?server=bethany/proxmox`; Fastify decodes it transparently.
  Don't introduce a non-encoding shortcut.
- **TODO placeholders in `config/servers/*.yaml`** — the SSH user and key
  paths are guesses the user is supposed to verify before running a script
  against any real host. Don't silently "fix" them.

## Mobile vs desktop

- `useIsMobile()` (matchMedia `max-width: 767px`) decides which shell renders.
- Both shells **reuse the same hooks** (`useGroups`, `useRunbook`,
  `useSshStream`, `useShellStream`) and the same `Terminal` component — only
  presentation differs. If you add a hook that backs a feature, both shells
  pick it up; don't fork hook logic per shell.
- Mobile CSS tokens are scoped to `.m-app` (cream "paper" palette matched to
  the mobile design); desktop tokens live on `:root`. Adding global tokens
  affects desktop only — mobile must be widened explicitly.
- Mobile-only screens that aren't present on desktop: `RunningScreen`,
  `ShellScreen` (full-screen variants of the desktop terminal/shell modes).

## What's intentionally out of scope (don't add without asking)

- Multi-user auth / roles — login exists (Discord OAuth, see "Auth"), but it's a
  single-identity allowlist. Don't add user management, RBAC, or per-user state.
- History / audit log of runs (no "logs" tab in mobile either — that's why
  the design's 3-tab bar is implemented as 2)
- Persistent DB of any kind
- Multi-node UI / fan-out (backend already supports it — UI is single-node v1)
- The pencil/paper hand-drawn aesthetic from the original design wireframes
  (that was the medium; the chosen look is brutalist-minimalist)
