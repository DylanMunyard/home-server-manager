# home-server-mgr — agent instructions

Web UI + API to SSH into the user's home/side-project servers and stream script
("runbook") output live. Personal-infra scope — single user, LAN-fronted, no
public exposure.

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

- App-level auth (LAN-fronted only)
- History / audit log of runs (no "logs" tab in mobile either — that's why
  the design's 3-tab bar is implemented as 2)
- Persistent DB of any kind
- Multi-node UI / fan-out (backend already supports it — UI is single-node v1)
- The pencil/paper hand-drawn aesthetic from the original design wireframes
  (that was the medium; the chosen look is brutalist-minimalist)
