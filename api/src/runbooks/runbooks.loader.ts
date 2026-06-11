import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import YAML from 'yaml';
import { paths } from '../config.js';

/**
 * A declared input. The map key in the `# params:` block is the `name` — the
 * shell variable injected (as `export NAME=…`) before the script runs.
 */
export type RunbookParam = {
  name: string;
  label: string;
  required: boolean;
  default?: string;
  choices?: string[];
};

export type Runbook = {
  id: string;
  name: string;
  description: string;
  params: RunbookParam[];
  /**
   * If set, the UI requires explicit confirmation before a *manual* run (the
   * value is the prompt message). Marks a destructive/irreversible runbook so a
   * standalone run can't fire by accident. Only the manual run path honours it —
   * jobs and feature integrations (e.g. the file browser's own delete confirm)
   * run the script directly.
   */
  confirm?: string;
  /**
   * List of node IDs (or glob patterns) this runbook is intended for.
   * If present, the UI hides it unless a matching node is selected.
   */
  nodes?: string[];
  filename: string;
  contents: string;
};

const DEFAULT_CONFIRM = 'This runbook requires confirmation before running. Continue?';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Description = first block of `#` comment lines after the shebang.
 * - Leading blank lines between shebang and the block are skipped.
 * - "Decoration" comment lines (e.g. `# -----`, `# =====`) are stripped.
 * - Consecutive content lines are joined into a paragraph; blank `#` lines
 *   (or blank lines between two `#` blocks) become paragraph breaks.
 * - A leading "<id><sep>" on the first content line is stripped (sep ∈ {—, :, -, –}).
 */
function extractDescription(id: string, contents: string): string {
  const lines = contents.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && lines[i].startsWith('#!')) i++;
  while (i < lines.length && lines[i].trim() === '') i++;

  const isDecoration = (s: string) => /^[-=*_#\s]+$/.test(s);

  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  };

  for (; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') {
      // A bare blank line: peek to see if another `#` block follows; if so,
      // treat as a paragraph break, otherwise end of description.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && /^\s*#/.test(lines[j])) {
        flush();
        i = j - 1;
        continue;
      }
      break;
    }
    const m = /^\s*#\s?(.*)$/.exec(raw);
    if (!m) break;
    const body = m[1].trimEnd();
    // The `# params:` / `# confirm:` directives aren't prose — stop here.
    if (/^(params|confirm)\s*:/.test(body)) break;
    if (body === '') {
      flush();
      continue;
    }
    if (isDecoration(body)) {
      flush();
      continue;
    }
    current.push(body.trim());
  }
  flush();

  if (paragraphs.length === 0) return '';

  const prefix = new RegExp(`^${escapeRegExp(id)}\\s*[\\u2014\\u2013:\\-]\\s+`, 'i');
  paragraphs[0] = paragraphs[0].replace(prefix, '');
  return paragraphs.join('\n\n').trim();
}

/**
 * Pull the `# params:` YAML block out of the header comment region. De-comments
 * the same way `extractDescription` does (skip shebang, strip `# `), finds a
 * top-level `params:` line, then takes it plus the following indented / blank
 * lines (a dedent to column 0 ends the block). Returns the de-commented YAML
 * text, or null if there's no block.
 */
function extractParamsBlock(contents: string): string | null {
  const lines = contents.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && lines[i].startsWith('#!')) i++;
  while (i < lines.length && lines[i].trim() === '') i++; // blank line(s) after the shebang

  const body: string[] = [];
  for (; i < lines.length; i++) {
    const m = /^\s*#\s?(.*)$/.exec(lines[i]);
    if (!m) break; // first non-comment line ends the header region
    body.push(m[1].trimEnd());
  }

  const start = body.findIndex((l) => /^params:\s*$/.test(l));
  if (start === -1) return null;

  const block = [body[start]];
  for (let k = start + 1; k < body.length; k++) {
    const l = body[k];
    if (l === '' || /^\s/.test(l)) block.push(l);
    else break; // back to column 0 ⇒ end of the params block
  }
  return block.join('\n');
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse the declared inputs. Lenient by design: a malformed block logs a warning
 * and yields no params rather than throwing — a bad script must never break the
 * runbook list (same spirit as the jobs loader / the description parser).
 */
function parseParams(id: string, contents: string): RunbookParam[] {
  const block = extractParamsBlock(contents);
  if (!block) return [];

  let doc: unknown;
  try {
    doc = YAML.parse(block);
  } catch (err) {
    console.warn(`[runbooks] ${id}: ignoring malformed params block — ${(err as Error).message}`);
    return [];
  }

  const raw = (doc as { params?: unknown } | null)?.params;
  if (!raw || typeof raw !== 'object') return [];

  const out: RunbookParam[] = [];
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!IDENT.test(name)) {
      console.warn(`[runbooks] ${id}: skipping param '${name}' — not a valid shell identifier`);
      continue;
    }
    const s = (spec ?? {}) as Record<string, unknown>;
    const choices = Array.isArray(s.choices) ? s.choices.map(String) : undefined;
    out.push({
      name,
      label: typeof s.label === 'string' && s.label ? s.label : name,
      required: s.required === true,
      default: s.default !== undefined ? String(s.default) : undefined,
      choices,
    });
  }
  return out;
}

/**
 * Resolve client-supplied values against a runbook's declared params. Only
 * declared params are returned — unknown keys from the client are ignored, so
 * the run path can never inject arbitrary env vars. Every declared param is
 * always present (empty string at worst), keeping scripts safe under `set -u`.
 */
export function resolveParamValues(
  params: RunbookParam[],
  provided: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    const given = provided[p.name];
    const fallback = p.default ?? p.choices?.[0] ?? '';
    out[p.name] = given !== undefined && given !== '' ? given : fallback;
  }
  return out;
}

/**
 * A top-level `# confirm:` directive in the header. `true` (or a bare `confirm:`)
 * ⇒ the default prompt; a string ⇒ that custom prompt; `false`/absent ⇒ no
 * confirmation. Lenient like the params parser — anything unexpected falls back
 * to the default prompt (fail safe: a destructive script stays guarded).
 */
function parseConfirm(contents: string): string | undefined {
  const lines = contents.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && lines[i].startsWith('#!')) i++;

  for (; i < lines.length; i++) {
    const m = /^\s*#\s?(.*)$/.exec(lines[i]);
    if (!m) break; // first non-comment line ends the header region
    const cm = /^confirm\s*:\s*(.*)$/.exec(m[1].trim());
    if (!cm) continue;
    const raw = cm[1].trim();
    if (raw === '') return DEFAULT_CONFIRM;
    let val: unknown;
    try { val = YAML.parse(raw); } catch { return DEFAULT_CONFIRM; }
    if (val === false || val == null) return undefined;
    if (typeof val === 'string' && val) return val;
    return DEFAULT_CONFIRM; // true, or any non-empty non-string
  }
  return undefined;
}

/**
 * A top-level `# nodes:` YAML block in the header.
 */
function parseNodes(contents: string): string[] | undefined {
  const lines = contents.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && lines[i].startsWith('#!')) i++;

  let body: string[] = [];
  for (; i < lines.length; i++) {
    const m = /^\s*#\s?(.*)$/.exec(lines[i]);
    if (!m) break;
    body.push(m[1].trimEnd());
  }

  const start = body.findIndex((l) => /^nodes:\s*(.*)$/.test(l));
  if (start === -1) return undefined;

  const firstLineMatch = /^nodes:\s*(.*)$/.exec(body[start]);
  const firstLineValue = firstLineMatch ? firstLineMatch[1].trim() : '';

  if (firstLineValue && (firstLineValue.startsWith('[') || !firstLineValue.includes(':'))) {
    try {
      const val = YAML.parse(firstLineValue);
      if (Array.isArray(val)) return val.map(String);
      if (typeof val === 'string') return [val];
    } catch { /* fall through to block parse */ }
  }

  const block = [body[start]];
  for (let k = start + 1; k < body.length; k++) {
    const l = body[k];
    if (l === '' || /^\s/.test(l)) block.push(l);
    else break;
  }

  try {
    const doc = YAML.parse(block.join('\n'));
    if (Array.isArray(doc.nodes)) return doc.nodes.map(String);
    if (typeof doc.nodes === 'string') return [doc.nodes];
  } catch {
    return undefined;
  }
  return undefined;
}

function parseRunbook(id: string, filename: string, contents: string): Runbook {
  return {
    id,
    name: id,
    description: extractDescription(id, contents),
    params: parseParams(id, contents),
    confirm: parseConfirm(contents),
    nodes: parseNodes(contents),
    filename,
    contents,
  };
}

export async function loadRunbooks(): Promise<Runbook[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.scripts);
  } catch {
    return [];
  }

  const files = entries.filter((f) => f.endsWith('.sh'));
  const out: Runbook[] = [];
  for (const f of files) {
    const id = basename(f, extname(f));
    const contents = await readFile(join(paths.scripts, f), 'utf8');
    out.push(parseRunbook(id, f, contents));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function loadRunbook(id: string): Promise<Runbook | null> {
  const all = await loadRunbooks();
  return all.find((r) => r.id === id) ?? null;
}
