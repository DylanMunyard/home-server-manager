/**
 * Building `export NAME=value` preludes prepended to a runbook before it's piped
 * to the remote `bash -s`. Shared by the manual run path (runbook params) and
 * the jobs runner (a job's `env:`) — both inject values the API process env
 * can't otherwise carry over SSH.
 */

/** Single-quote a value for bash, escaping embedded single quotes. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** `export NAME='value'` lines for each entry, newline-terminated (or '' if empty). */
export function exportPrelude(values: Record<string, string>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n') + '\n';
}
