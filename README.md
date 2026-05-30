# home-server-mgr

Web UI + API to SSH into my home and side-project servers and stream script
("runbook") output live. Personal-infra scope — single user, internet-exposed
behind a Cloudflare Tunnel and Discord OAuth.

## What it does

- **Browse servers** defined in file-based config and open a live SSH terminal.
- **Run runbooks** — checked-in bash scripts — against a server and stream their
  output to the browser via WebSockets. Runbooks can declare typed inputs.
- **Schedule recurring jobs** — cron-driven runbook runs with optional
  conditional remediation and ntfy alerts.

## Stack

- **API:** Fastify + ssh2 + WebSocket, TypeScript (ESM).
- **UI:** React + Vite + xterm.js, with separate desktop and mobile shells.
- **Config:** file-based only — no database. Clone the repo, drop in YAML/scripts,
  and go.

## Layout

```
api/            Fastify + ssh2 + WebSocket backend
ui/             React + Vite + xterm.js frontend
config/
  servers/      one YAML file per server group
  scripts/      one bash script per runbook
  jobs/         one YAML file per recurring job
dev/run.sh      starts both stacks with prefixed output
```

## Run

```bash
cp .env.example .env    # fill in Discord OAuth + secrets
./dev/run.sh            # UI on :5780, API on :5781
```

See [CLAUDE.md](CLAUDE.md) for conventions, config formats, auth, and gotchas.
