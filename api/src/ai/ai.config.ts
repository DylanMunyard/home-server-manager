/**
 * Azure OpenAI config — read from env, never hard-fail.
 *
 * AI is an auxiliary feature: a clone-and-go checkout shouldn't need a model
 * deployment to run runbooks. So like ntfy.config.ts (and unlike the
 * load-bearing auth.config.ts), this never throws at startup — if the endpoint
 * / key / deployment aren't set, AI is simply disabled and ai.client.ts no-ops
 * (with a one-time warning the first time something actually asks for a chat).
 *
 * We talk to the chat-completions REST endpoint directly with `fetch` — no
 * `openai`/`@azure/openai` SDK — to keep the dependency surface and the
 * clone-and-go property intact (same ethos as ntfy.ts).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export type AiConfig = {
  enabled: boolean;
  endpoint: string; // base origin, no trailing slash, no /openai path
  apiKey: string;
  deployment: string;
  apiVersion: string;
  reasoningEffort?: ReasoningEffort;
};

const VALID_EFFORT: ReasoningEffort[] = ['low', 'medium', 'high'];

export function loadAiConfig(): AiConfig {
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT ?? '').trim().replace(/\/+$/, '');
  const apiKey = process.env.AZURE_OPENAI_API_KEY?.trim() ?? '';
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT?.trim() ?? '';
  // Defaults to the deployment's documented version; override per-checkout.
  const apiVersion = (process.env.AZURE_OPENAI_API_VERSION ?? '2024-12-01-preview').trim();

  const rawEffort = process.env.AZURE_OPENAI_REASONING_EFFORT?.trim().toLowerCase();
  const reasoningEffort = VALID_EFFORT.includes(rawEffort as ReasoningEffort)
    ? (rawEffort as ReasoningEffort)
    : undefined;

  return {
    enabled: !!(endpoint && apiKey && deployment),
    endpoint,
    apiKey,
    deployment,
    apiVersion,
    reasoningEffort,
  };
}
