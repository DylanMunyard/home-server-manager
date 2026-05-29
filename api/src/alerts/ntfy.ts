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

export type SendResult = {
  ok: boolean;        // delivered (2xx from ntfy)
  skipped: boolean;   // ntfy not configured — nothing sent
  status?: number;
  error?: string;
};

/**
 * POST an alert to ntfy. No-op (with a one-time warning) when NTFY_TOPIC is
 * unset, so jobs can declare `notify:` rules without forcing every checkout to
 * configure ntfy. Never throws — a failed alert must not take down a job run —
 * but returns a SendResult so callers that care (e.g. the test-alert route)
 * can surface success/failure.
 */
export async function sendAlert(alert: Alert): Promise<SendResult> {
  const cfg = loadNtfyConfig();
  if (!cfg.enabled) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn('[ntfy] alert requested but NTFY_TOPIC is unset — alerting disabled');
    }
    return { ok: false, skipped: true };
  }

  const body = alert.body.length > MAX_BODY
    ? `${alert.body.slice(0, MAX_BODY)}\n…(truncated)`
    : alert.body;

  // Use ntfy's JSON publish API so title/message can carry UTF-8 (em-dashes,
  // emoji, etc.) — HTTP headers are ASCII-only, which would otherwise reject
  // non-Latin-1 characters in `Title`.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

  const payload: Record<string, unknown> = {
    topic: cfg.topic,
    title: alert.title,
    message: body,
  };
  if (alert.priority) {
    const map: Record<NtfyPriority, number> = { min: 1, low: 2, default: 3, high: 4, max: 5 };
    payload.priority = map[alert.priority];
  }
  if (alert.tags?.length) payload.tags = alert.tags;

  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[ntfy] send failed: ${res.status} ${res.statusText}`);
      return { ok: false, skipped: false, status: res.status, error: `${res.status} ${res.statusText}` };
    }
    return { ok: true, skipped: false, status: res.status };
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`[ntfy] send error: ${msg}`);
    return { ok: false, skipped: false, error: msg };
  }
}
