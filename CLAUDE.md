#   home-server-mgr — agent instructions

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
  dashboard.yaml    live-metrics dashboard config (see "Live dashboard")
dev/run.sh          starts both stacks with prefixed output (see "Verify")
```

**Feature deep-dives live in nested `CLAUDE.md` files** — `api/src/runbooks/`,
`api/src/jobs/`, `api/src/metrics/`, `api/src/k8s/`, `api/src/ai/`. Each covers
its UI counterpart too. This root file keeps only cross-cutting rules + a
summary per feature; **read the nested file before changing that feature**,
even when you're only touching its `ui/src/` side.

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
- **Auxiliary subsystems must never take down the API.** Jobs, the metrics
  collector, the k8s panel, and the AI features are all isolated from the fatal
  `listen` path — malformed config is skipped + logged, runtime failures are
  caught and degrade per-feature. Only auth (`auth.config.ts`) and the server
  YAML loader fail boot, because every route depends on them. Keep new
  subsystems on the lenient side of this line.

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
  - { id: plex,       host: 192.168.1.36, name: "plex",
      ai: "Proxmox LXC running a docker-compose stack incl. Plex" }
```

- **Global server id is `<group>/<server>`** (e.g. `bethany/proxmox`). Used in
  URLs and WS query params; URL-encode slashes for transport.
- **`ai:` is an optional free-text note** describing the box (e.g. "runs Docker",
  "k3s control plane") that's injected into the AI chat's system prompt so the
  model targets the right tooling without the user re-explaining (see "AI
  assistant"). Unlike other scalars it's *combined* across defaults+server (group
  note + per-server note both apply) rather than overridden. Optional, cosmetic
  to everything except the AI — omit it and the assistant just has less context.
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
- **Inputs (`# params:`):** a runbook declares UI inputs as a YAML map in the
  header comment, keyed by the env var the script reads
  (`PKG: { label: …, required: true, default: …, choices: […] }`). Values are
  resolved server-side and injected as `export NAME=…` via the shared prelude
  builder (`api/src/ssh/prelude.ts`) — same mechanism as a job's `env:`. Only
  declared params are injected; every declared one is always set (safe under
  `set -u`). No prompting — there's no TTY. Full field semantics + job
  interplay: `api/src/runbooks/CLAUDE.md`.

## Recurring jobs — one file per job

Cron-scheduled runbooks with optional conditional remediation + ntfy alerts.
Filename stem = job id. Engine is `api/src/jobs/`; alerts are `api/src/alerts/`.

```yaml
# config/jobs/vpn-watchdog.yaml
name: VPN watchdog
schedule: "*/5 * * * *"      # 5-field cron, evaluated in the API process TZ
target: bethany/proxmox      # global server id, OR a list (parallel fan-out)
run: vpn-check               # runbook executed each tick — the "check"
when: { exit: nonzero }      # OPTIONAL: when does the check mean "remediate"?
then: pia-vpn-reset          # OPTIONAL: runbook OR list run in order on match
params: { PKG: htop }        # OPTIONAL: values for the runbook's `# params:`
notify: { on: [action, error], priority: high }   # OPTIONAL: ntfy alerts
```

- **In-memory scheduler (croner), no persistence by design** — last-run state
  in a `Map` only, surfaced read-only at `GET /api/jobs`.
- **Runbooks signal via exit code** — a check exits nonzero to mean "act"; the
  engine stays dumb, the logic lives in bash (incl. sustained/consecutive
  debounce — see `temp-check` / `node-health`).
- **`then` is a chain** — a list runs sequentially on trigger; the `action`
  alert is one combined push (check reason + a section per runbook), so a list
  of diagnostics (e.g. the dotnet scripts) turns an alert into an answer.
- **`env:` vs `params:`** — `env: { NAME: ${VAR} }` injects *secrets* resolved
  from process env (stored raw in `JobConfig` so the API never leaks them);
  `params:` are *literal* non-secret values for a runbook's declared
  `# params:`. Params win on a name collision. Don't `${VAR}`-expand script
  text — bash owns `${...}`.
- Malformed job files are **skipped + logged, never thrown** (see Conventions).
- Full semantics (`when`/`then`, notify rules, multi-target fan-out, env/params
  resolution): `api/src/jobs/CLAUDE.md`.

## Live dashboard — `config/dashboard.yaml`

A "how are things right now" overview per node — CPU%, memory%, temp, disk —
with live sparkline charts (visx), grouped by node. Engine `api/src/metrics/`;
UI `ui/src/metrics/` (shared `Dashboard` renders in both shells; mobile gets a
4th tab). Single optional config file with clone-and-go defaults.

- **Zero-install probe:** `config/scripts/metrics-stream.sh` is a normal
  runbook that *loops*, emitting NDJSON from `/proc` + `/sys` + `df`. It's a
  stream — never add a param expecting a one-shot run.
- **Always-on in-memory collector:** one SSH connection per watched node into a
  per-node ring buffer; browsers read the buffer (`/api/metrics` +
  `/ws/metrics`), never SSH. Per-node failures reconnect on a backoff and
  never affect the others or the API.
- **Thresholds are display-only** — alerting lives in jobs (a disk/temp
  watchdog), not here.
- `inspect:` = drill-down runbooks (ordinary scripts — that's the plugin
  system); `panels:` = rich detail panels (only `k3s` exists).
- Full config reference + probe/collector/`paths:` invariants:
  `api/src/metrics/CLAUDE.md`. The k3s panel (SSH port-forward to the cluster
  API, no kubectl, streaming WS): `api/src/k8s/CLAUDE.md`.

## AI assistant — Azure OpenAI

Optional AI features (`api/src/ai/`): an interactive per-server chat
(`/ws/ai/chat`, tool-calling loop running bash over SSH) and an **on-demand**
jobs investigator (read-only agentic loop over a failed check's context).
Env-driven (`AZURE_OPENAI_*`); unset ⇒ disabled, the API still runs, the UI
hides its affordances — clone-and-go holds.

**SAFETY IS PARAMOUNT (the user stressed this).** AI-generated bash runs on
real servers — there is no sandbox. The investigator is read-only via two
aligned layers (emphatic system prompt + a denylist backstop) that must stay in
sync; the chat is permissive (human-directed) behind a minimal denylist. **Read
`api/src/ai/CLAUDE.md` before touching anything in `ai/`** — it documents the
client quirks (o4-mini reasoning model), the chat/investigator protocols, and
the safety layers.

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
- **Detail views use native page scroll, not cramped inner scrollers.** When
  metadata stacks up (params, server detail, a job's per-host list), the *whole*
  view should scroll so the primary content (the script preview) renders at full
  height — don't trap it in a short `max-height`/`overflow:auto` box squeezed
  between fixed metadata and a pinned action bar/terminal. Make the screen
  container the scroller and give the script natural height; scope it so siblings
  that genuinely need a bounded box keep one (desktop terminal
  `.stage > .terminal-wrap` holds ~46vh; the jobs-flow script box `.flow-book
  .script` stays capped). Implemented as `.stage { overflow-y:auto }` +
  `.stage > .script { max-height:none }` (desktop) and the `.m-jscroll` modifier
  on the mobile job-detail body.

## What's intentionally out of scope (don't add without asking)

- Multi-user auth / roles — login exists (Discord OAuth, see "Auth"), but it's a
  single-identity allowlist. Don't add user management, RBAC, or per-user state.
- History / audit log of runs (no "logs" tab in mobile either — that's why
  the design's 3-tab bar is implemented as 2)
- Persistent DB of any kind
- Multi-node UI / fan-out (backend already supports it — UI is single-node v1)
- The pencil/paper hand-drawn aesthetic from the original design wireframes
  (that was the medium; the chosen look is brutalist-minimalist)
