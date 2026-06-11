# Runbook inputs (`# params:`) — full semantics

Scope: param parsing/injection for runbooks (`api/src/runbooks/`, shared prelude
builder `api/src/ssh/prelude.ts`, param UI in `ui/src/runbooks/`). Root
`CLAUDE.md` has the summary; this is the contract.

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
  prompt — there's no TTY (see root CLAUDE.md "Runbook scripts"). Don't declare
  a param expecting `read`.
- **Recurring jobs** supply values for a parameterized runbook via their own
  `params:` block (see `api/src/jobs/CLAUDE.md`); the param UI is only for
  manual runs. Declared defaults still apply when a job omits a value. A
  malformed `# params:` block is non-fatal — it logs a warning and the runbook
  loads with no params (same "don't take down the API" stance as jobs).
