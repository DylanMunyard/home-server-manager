/**
 * ntfy push-alert config — read from env, never hard-fail.
 *
 * Alerting is optional infra: a clone-and-go checkout with no jobs (or jobs
 * that don't notify) shouldn't need ntfy at all. So unlike auth.config.ts /
 * the YAML loaders, this never throws at startup — if NTFY_TOPIC is unset,
 * alerting is simply disabled and ntfy.ts no-ops (with a one-time warning the
 * first time a job actually wants to notify).
 */
export type NtfyConfig = {
  enabled: boolean;
  url: string;
  topic: string;
  token?: string;
};

export function loadNtfyConfig(): NtfyConfig {
  const url = (process.env.NTFY_URL ?? 'https://ntfy.sh').replace(/\/+$/, '');
  const topic = process.env.NTFY_TOPIC?.trim();
  const token = process.env.NTFY_TOKEN?.trim() || undefined;
  return {
    enabled: !!topic,
    url,
    topic: topic ?? '',
    token,
  };
}
