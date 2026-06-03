import { loadServer } from '../servers/servers.loader.js';
import { collectScript } from '../ssh/ssh.collect.js';
import { chatRaw, type ConvoMessage, type ToolDef } from './ai.client.js';
import { APP_CONTEXT, ASSISTANT } from './ai.prompts.js';

// Events emitted per turn — rendered by the UI as the conversation unfolds.
export type ChatEvent =
  | { type: 'text'; content: string }
  | { type: 'cmd'; n: number; purpose: string; bash: string }
  | { type: 'output'; n: number; exitCode: number | null; stdout: string; stderr: string; rejected?: string };

export type ChatTurnResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  events: ChatEvent[];
  // New ConvoMessage turns to append to the client's history (includes the
  // user message we just processed + all assistant/tool turns). The client
  // passes its full stored history back on the next call; the server prepends
  // the system message. No server-side session state needed.
  messages: ConvoMessage[];
};

const MAX_ITERATIONS = 8;
const CMD_TIMEOUT_S = 30;
const MAX_OUT = 6000;
const SENTINEL = '__HSM_CHAT__';

const RUN_COMMAND: ToolDef = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Run a bash command on the target server via SSH and get back its exit code, ' +
      'stdout, and stderr. Use it to diagnose issues, restart services, inspect ' +
      'configs, and apply fixes. Say what the command does before calling this.',
    parameters: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'Brief description of what this command does.' },
        bash:    { type: 'string', description: 'The bash command to run on the server.' },
      },
      required: ['purpose', 'bash'],
      additionalProperties: false,
    },
  },
};

export async function runChatTurn(
  target: string,
  history: ConvoMessage[],
  userMessage: string,
): Promise<ChatTurnResult> {
  const server = await loadServer(target);
  if (!server) {
    return { ok: false, error: `unknown target '${target}'`, events: [], messages: [] };
  }

  const events: ChatEvent[] = [];
  // Accumulate new turns to hand back to the client.
  const newMessages: ConvoMessage[] = [{ role: 'user', content: userMessage }];

  // Full conversation the model sees (system not stored client-side).
  const messages: ConvoMessage[] = [
    { role: 'system', content: `${APP_CONTEXT}\n\n${ASSISTANT}` },
    ...history,
    { role: 'user', content: userMessage },
  ];

  let cmdN = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const r = await chatRaw(messages, { tools: [RUN_COMMAND] });
    if (r.skipped) {
      return { ok: false, skipped: true, error: 'AI not configured', events, messages: newMessages };
    }
    if (!r.ok || !r.message) {
      return { ok: false, error: r.error ?? 'model error', events, messages: newMessages };
    }

    const msg = r.message;
    messages.push(msg);
    newMessages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      // No tool call — model is done, content is the reply.
      const text = (msg.content ?? '').trim();
      if (text) events.push({ type: 'text', content: text });
      return { ok: true, events, messages: newMessages };
    }

    if (msg.content?.trim()) {
      events.push({ type: 'text', content: msg.content.trim() });
    }

    for (const call of calls) {
      cmdN++;
      const { purpose, bash } = parseArgs(call.function.arguments);
      events.push({ type: 'cmd', n: cmdN, purpose, bash });

      const rejection = denylistReason(bash);
      if (rejection) {
        events.push({ type: 'output', n: cmdN, exitCode: null, stdout: '', stderr: '', rejected: rejection });
        const toolMsg: ConvoMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: `BLOCKED — not run: ${rejection}`,
        };
        messages.push(toolMsg);
        newMessages.push(toolMsg);
        continue;
      }

      const res = await collectScript(server, wrapCmd(bash));
      const stdout = cap(res.stdout);
      const stderr = cap(res.stderr);
      events.push({ type: 'output', n: cmdN, exitCode: res.exitCode, stdout, stderr });
      const toolMsg: ConvoMessage = {
        role: 'tool',
        tool_call_id: call.id,
        content: toolResult(res),
      };
      messages.push(toolMsg);
      newMessages.push(toolMsg);
    }
  }

  // Budget exhausted — force a final reply with no tools available.
  messages.push({ role: 'user', content: 'Command limit reached. Summarise what you found and what was done.' });
  const final = await chatRaw(messages);
  const text = final.ok ? (final.message?.content ?? '').trim() : '';
  if (text) events.push({ type: 'text', content: text });
  if (final.ok && final.message) newMessages.push(final.message);
  return { ok: true, events, messages: newMessages };
}

// --- helpers ---------------------------------------------------------------

function parseArgs(raw: string): { purpose: string; bash: string } {
  try {
    const o = JSON.parse(raw) as { purpose?: unknown; bash?: unknown };
    return {
      purpose: typeof o.purpose === 'string' ? o.purpose : '',
      bash:    typeof o.bash === 'string' ? o.bash : '',
    };
  } catch {
    return { purpose: '', bash: '' };
  }
}

function wrapCmd(bash: string): string {
  // Hard timeout + heredoc so the outer shell can't expand the script content.
  return `timeout ${CMD_TIMEOUT_S}s bash <<'${SENTINEL}'\n${bash}\n${SENTINEL}\n`;
}

/** Blank string literals so banned words inside grep patterns etc. don't false-trigger. */
function stripStringLiterals(s: string): string {
  return s
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, (m) => (/[$`]/.test(m) ? m : ' '));
}

/**
 * Minimal denylist — only the truly catastrophic operations. The ASSISTANT
 * system prompt is the primary guard; this is a backstop for the worst cases.
 * (Contrast with ai.investigate.ts which is read-only and much stricter.)
 */
function denylistReason(bash: string): string | null {
  if (!bash.trim()) return 'empty command';
  if (bash.includes(SENTINEL)) return 'command contains a reserved delimiter';

  const scan = stripStringLiterals(bash);

  const catastrophic: { re: RegExp; why: string }[] = [
    // Disk destruction
    { re: /\bdd\b[^|;&\n]*\bof\s*=\s*\/dev\/[a-z]/, why: 'disk overwrite (dd of=/dev/...)' },
    { re: /\b(mkfs|mke2fs|mkswap|wipefs)\b/, why: 'filesystem format / wipe' },
    { re: /\bshred\b/, why: 'secure file deletion' },
    // Wipe root
    { re: /\brm\b[^|;&\n]*-[a-z]*r[a-z]*f\b[^|;&\n]*\/\s*$/, why: 'recursive delete of root' },
    { re: /\brm\b[^|;&\n]*-[a-z]*r[a-z]*f\b[^|;&\n]*\/\*/, why: 'recursive delete of /*' },
    // Pipe remote content to a shell
    { re: /\b(curl|wget|fetch)\b[^|]*\|\s*(bash|sh|zsh|dash)\b/, why: 'piping remote content to a shell' },
    // Fork bomb
    { re: /:\s*\(\s*\)\s*\{[^}]*:\s*\|[^}]*:\s*&/, why: 'potential fork bomb' },
    // Lateral movement
    { re: /\bscp\s/, why: 'scp data transfer (lateral movement)' },
  ];

  for (const b of catastrophic) if (b.re.test(scan)) return b.why;
  return null;
}

function cap(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…(truncated)` : s;
}

function toolResult(res: import('../ssh/ssh.collect.js').CollectResult): string {
  if (res.error) return `SSH error: ${res.error}`;
  const parts = [`exit: ${res.exitCode}`];
  const out = cap(res.stdout).trim();
  const err = cap(res.stderr).trim();
  if (out) parts.push(`stdout:\n${out}`);
  if (err) parts.push(`stderr:\n${err}`);
  if (!out && !err) parts.push('(no output)');
  if (res.exitCode === 124) parts.push('(exit 124 = timed out)');
  return parts.join('\n');
}
