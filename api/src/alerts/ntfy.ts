import { loadNtfyConfig } from './ntfy.config.js';

export type NtfyPriority = 'min' | 'low' | 'default' | 'high' | 'max';

export type Alert = {
  title: string;
  body: string;
  priority?: NtfyPriority;
  tags?: string[]; // ntfy emoji shortcodes / tags, e.g. ['warning']
};

// ntfy rejects very large bodies; keep raw script output well under the limit.
const MAX_BODY = 3500;

let warnedUnconfigured = false;

/**
 * POST an alert to ntfy. No-op (with a one-time warning) when NTFY_TOPIC is
 * unset, so jobs can declare `notify:` rules without forcing every checkout to
 * configure ntfy. Never throws — a failed alert must not take down a job run.
 */
export async function sendAlert(alert: Alert): Promise<void> {
  const cfg = loadNtfyConfig();
  if (!cfg.enabled) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn('[ntfy] alert requested but NTFY_TOPIC is unset — alerting disabled');
    }
    return;
  }

  const body = alert.body.length > MAX_BODY
    ? `${alert.body.slice(0, MAX_BODY)}\n…(truncated)`
    : alert.body;

  const headers: Record<string, string> = {
    Title: alert.title,
  };
  if (alert.priority) headers.Priority = alert.priority;
  if (alert.tags?.length) headers.Tags = alert.tags.join(',');
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

  try {
    const res = await fetch(`${cfg.url}/${cfg.topic}`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      console.warn(`[ntfy] send failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`[ntfy] send error: ${(err as Error).message}`);
  }
}
