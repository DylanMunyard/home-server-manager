import { loadAiConfig } from './ai.config.js';

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };

/** A function the model may call (chat-completions tool-calling shape). */
export type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** A tool invocation the model asked for, in an assistant message. */
export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string }; // arguments is a JSON string
};

export type AssistantMessage = {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
};

/**
 * The richer message shape the agentic loop builds: plain system/user prompts,
 * assistant turns that may carry tool_calls, and the tool results we feed back.
 */
export type ConvoMessage =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

export type ChatResult = {
  ok: boolean;
  skipped: boolean; // AI not configured — nothing sent
  content?: string;
  status?: number;
  error?: string;
};

/** Lower-level result: the raw assistant message + why the model stopped. */
export type RawResult = {
  ok: boolean;
  skipped: boolean;
  message?: AssistantMessage;
  finishReason?: string;
  status?: number;
  error?: string;
};

let warnedUnconfigured = false;

function unconfigured(): true {
  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    console.warn('[ai] chat requested but Azure OpenAI is unconfigured — set AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT');
  }
  return true;
}

/**
 * The core chat-completions call to the Azure OpenAI deployment — returns the
 * raw assistant message (incl. any `tool_calls`) so callers can drive a
 * tool-calling loop. `chat()` below wraps this for the simple text case.
 *
 * Tuned for the o-series reasoning deployment (`o4-mini`):
 *   - uses `max_completion_tokens`, NOT `max_tokens`
 *   - REJECTS a non-default `temperature` — so we never send one
 *   - accepts an optional `reasoning_effort` (low|medium|high)
 * Azure authenticates with the `api-key` header (not a Bearer token).
 *
 * Never throws — a model hiccup must not take down its caller (an investigation,
 * a runbook draft). No-op (with a one-time warning) when unconfigured.
 */
export async function chatRaw(
  messages: ConvoMessage[],
  opts?: { tools?: ToolDef[]; maxCompletionTokens?: number },
): Promise<RawResult> {
  const cfg = loadAiConfig();
  if (!cfg.enabled) return unconfigured() && { ok: false, skipped: true };

  const url =
    `${cfg.endpoint}/openai/deployments/${encodeURIComponent(cfg.deployment)}` +
    `/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion)}`;

  const payload: Record<string, unknown> = {
    messages,
    // o4-mini is a REASONING model: it spends completion tokens on hidden
    // reasoning before any visible output, so this ceiling must be generous or
    // the model can burn the whole budget thinking and return empty content.
    max_completion_tokens: opts?.maxCompletionTokens ?? 25000,
  };
  if (cfg.reasoningEffort) payload.reasoning_effort = cfg.reasoningEffort;
  if (opts?.tools?.length) {
    payload.tools = opts.tools;
    payload.tool_choice = 'auto';
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': cfg.apiKey },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      // Azure puts the useful bit (e.g. "unsupported parameter") in the body.
      const detail = await res.text().catch(() => '');
      const error = `${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 400)}` : ''}`;
      console.warn(`[ai] chat failed: ${error}`);
      return { ok: false, skipped: false, status: res.status, error };
    }

    const data = (await res.json()) as {
      choices?: { message?: AssistantMessage; finish_reason?: string }[];
    };
    const choice = data.choices?.[0];
    const message: AssistantMessage = {
      role: 'assistant',
      content: choice?.message?.content ?? null,
      tool_calls: choice?.message?.tool_calls,
    };
    return { ok: true, skipped: false, status: res.status, message, finishReason: choice?.finish_reason };
  } catch (err) {
    const error = (err as Error).message;
    console.warn(`[ai] chat error: ${error}`);
    return { ok: false, skipped: false, error };
  }
}

/**
 * Simple one-shot text chat — the entrypoint behind `/api/ai/chat`. Wraps
 * `chatRaw` and flattens to plain text (no tool calling).
 */
export async function chat(
  messages: ChatMessage[],
  opts?: { maxCompletionTokens?: number },
): Promise<ChatResult> {
  const r = await chatRaw(messages, opts);
  if (r.skipped) return { ok: false, skipped: true };
  if (!r.ok) return { ok: false, skipped: false, status: r.status, error: r.error };
  return { ok: true, skipped: false, status: r.status, content: r.message?.content ?? '' };
}
