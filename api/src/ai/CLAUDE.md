# AI assistant — Azure OpenAI

Scope: `api/src/ai/`, chat UI in `ui/src/ai/`, investigator UI in
`ui/src/jobs/Investigation.tsx`. Root `CLAUDE.md` has the summary + the safety
headline; this is the contract — read before touching anything in `ai/`.

Talks to an **Azure OpenAI** deployment over the chat-completions REST API
directly — plain `fetch`, no SDK (same ethos as `ntfy.ts`).

- **Env-driven, never hard-fails.** `ai.config.ts` reads `AZURE_OPENAI_ENDPOINT`
  / `_API_KEY` / `_DEPLOYMENT` / `_API_VERSION` (+ optional `_REASONING_EFFORT`)
  from `.env`. Unset ⇒ `enabled: false`, the API still runs, AI no-ops, and the
  UI hides its affordances — the clone-and-go property holds (like ntfy, unlike
  the load-bearing `auth.config.ts`).
- **Reasoning-model client.** The deployment is `o4-mini` (a reasoning model):
  the client sends `max_completion_tokens` (NOT `max_tokens`), **omits
  `temperature`** (it rejects a non-default), and may pass `reasoning_effort`.
  `max_completion_tokens` must stay generous — the model spends tokens on hidden
  reasoning before visible output, so a tight cap returns empty content.
  `chatRaw` returns the raw assistant message (incl. `tool_calls`) for the
  agentic loop; `chat` wraps it for one-shot text.

## Interactive chat (`ai.chat.ts`, UI `ui/src/ai/`)

A live tool-calling loop over `/ws/ai/chat` — the client owns history (stateless
server), sends `{ history, userMessage }` frames, and the server streams
`status`/`text`/`cmd`/`output` events, ending each turn with `done`. `run_command`
runs bash on the target over SSH; a minimal denylist (`ai.chat.ts`) backstops the
permissive `ASSISTANT` prompt (a human is directing, so service restarts / edits
are allowed, unlike the read-only investigator).

- **Per-server context.** The target's `ai:` note (Server YAML) plus its
  name/host/user are folded into the system prompt (`serverContext()`), so the
  model knows e.g. "this LXC runs docker-compose" without being told each turn.
- **Cancel mid-turn.** The client can send a `{ type: 'cancel' }` control frame;
  the route aborts the in-flight model call (an `AbortSignal` threaded into
  `chatRaw`'s `fetch`) and the loop stops at the next model-call boundary. Abort
  is deliberately checked only at boundaries so `newMessages` always ends on a
  complete assistant/tool pairing — the partial turn is kept (valid history,
  work preserved), and `done` carries `cancelled: true` (UI shows "stopped",
  re-enables input). The Stop button (`ChatSession`) replaces Send while busy.

## Jobs AI Investigator (`ai.investigate.ts`)

An agentic loop that correlates *what was happening on the box* when a job's
check fails. **On demand only — it does NOT fire automatically.** You trigger it
per-host from the Jobs UI ("Investigate" → `POST /api/jobs/:id/investigate`),
which builds context from that target's **last run** and runs the loop. (Manual
trigger was a deliberate choice — a flapping check, e.g. a host that stays hot,
would otherwise spiral into an investigation every tick. If auto-firing is ever
reintroduced, gate it behind a per-host cooldown.)

- **`investigate:`** in a job (`config/jobs/*.yaml`) is an *optional intent hint*
  for those manual runs — `true`, or a string describing what to focus on (e.g.
  "correlate the high temp with what's running"). The loader splits a string into
  `investigate: true` + `investigateHint`; omitted ⇒ the AI infers intent from
  the script + output + metrics. It no longer gates anything: the UI shows the
  Investigate affordance for any job whenever AI is configured.
- The model is given the failure context — the job's + runbook's descriptions,
  the optional intent hint, the check script + output, the target, and recent
  metrics from `getSnapshot()` — and one tool, `run_probe(purpose, bash)`. It
  runs a *varying* number of **read-only** probes (`collectScript` over SSH),
  reads each result, decides the next, then stops and summarises.
- The transcript is buffered in an **in-memory registry** (no persistence — lost
  on restart, by design) and surfaced live over `GET /ws/ai/investigate?id=`
  (snapshot-then-forward like `/ws/metrics`) + `GET /api/ai/investigations/:id`.
  `GET /api/jobs` overlays each target's latest investigation status/summary.
  Manual runs **suppress** the follow-up ntfy (no phone spam while iterating);
  the push path remains for any future auto-trigger.
- **Auxiliary — must never take down the API.** Started fire-and-forget; the loop
  never throws into its caller (same stance as jobs / metrics).

## Safety (PARAMOUNT — the user stressed this)

AI-generated bash runs on real servers — there is no sandbox. Two aligned
layers, *keep them in sync if either changes*: (1) PRIMARY — the emphatic
read-only system prompt (`INVESTIGATOR` in `ai.prompts.ts`): never
delete/modify/create files (even temp ones), never write via redirects,
**never download from the network** (`curl … | bash`), never install/control
services. (2) BACKSTOP — a command-position denylist in `ai.investigate.ts`
(rejected probes are reported back to the model, not run) + a per-probe
`timeout` wrapper + an iteration cap. It is **not** a sandbox; it's
defence-in-depth behind the prompt, which is why the feature is opt-in.
