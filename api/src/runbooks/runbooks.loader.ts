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
 * Description = first contiguous block of `#` comment lines after the shebang.
 * A leading "<id><sep>" on line 1 is stripped (sep ∈ {—, :, -, –}).
 */
function extractDescription(id: string, contents: string): string {
  const lines = contents.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && lines[i].startsWith('#!')) i++;

  const block: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    const m = /^\s*#\s?(.*)$/.exec(line);
    if (!m) break;
    block.push(m[1].trimEnd());
  }
  if (block.length === 0) return '';

  const prefix = new RegExp(`^${escapeRegExp(id)}\\s*[\\u2014\\u2013:\\-]\\s+`, 'i');
  block[0] = block[0].replace(prefix, '');
  return block.join('\n').trim();
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
