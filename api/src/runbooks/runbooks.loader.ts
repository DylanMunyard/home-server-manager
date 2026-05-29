import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { paths } from '../config.js';

export type Runbook = {
  id: string;
  name: string;
  description: string;
  filename: string;
  contents: string;
};

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

function parseRunbook(id: string, filename: string, contents: string): Runbook {
  return {
    id,
    name: id,
    description: extractDescription(id, contents),
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
