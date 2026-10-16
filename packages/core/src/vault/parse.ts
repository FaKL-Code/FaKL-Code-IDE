import { basename } from 'node:path';

import { parse } from 'yaml';

/** O que a IDE entende de uma nota no formato do Obsidian (SDD 10.1). */
export interface ParsedNote {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Texto sem o frontmatter. */
  readonly body: string;
  readonly title: string;
  readonly tags: readonly string[];
  /** Alvos de `[[nota]]`, `[[nota|texto]]`, `[[nota#título]]`, sem o título. */
  readonly links: readonly string[];
  /** Alvos de `![[arquivo]]`. */
  readonly embeds: readonly string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
// Tag do Obsidian: # seguido de letras, números, _, -, /; não pode ser só número.
const TAG = /(?:^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const FENCE = /^(```|~~~)[\s\S]*?^\1/gm;
const INLINE_CODE = /`[^`\n]*`/g;

function asStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/** Normaliza o alvo de um wikilink: tira título, bloco e alias. */
export function linkTarget(raw: string): string {
  const target = raw.split('|')[0] ?? '';
  return (target.split('#')[0] ?? '').trim();
}

export function parseNote(path: string, text: string): ParsedNote {
  let frontmatter: Record<string, unknown> = {};
  let body = text;
  const match = FRONTMATTER.exec(text);
  if (match) {
    try {
      const data: unknown = parse(match[1] ?? '');
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        frontmatter = data as Record<string, unknown>;
      }
    } catch {
      // Frontmatter inválido fica como texto; o Obsidian faz o mesmo.
    }
    body = text.slice(match[0].length);
  }

  // Links e tags dentro de código não contam.
  const prose = body.replace(FENCE, '').replace(INLINE_CODE, '');
  const links = new Set<string>();
  const embeds = new Set<string>();
  for (const m of prose.matchAll(WIKILINK)) {
    const target = linkTarget(m[2] ?? '');
    if (!target) continue;
    (m[1] ? embeds : links).add(target);
  }
  const tags = new Set<string>(
    [...asStrings(frontmatter.tags), ...asStrings(frontmatter.tag)].map((t) => t.replace(/^#/, '')),
  );
  for (const m of prose.matchAll(TAG)) if (m[1]) tags.add(m[1]);

  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const fromMatter =
    typeof frontmatter.title === 'string' && frontmatter.title !== ''
      ? frontmatter.title
      : undefined;
  const title = fromMatter ?? heading ?? basename(path).replace(/\.md$/i, '');
  return { frontmatter, body, title, tags: [...tags], links: [...links], embeds: [...embeds] };
}

/** Notas com `privado: true` nunca chegam aos agentes. */
export function isPrivate(frontmatter: Readonly<Record<string, unknown>>): boolean {
  return frontmatter.privado === true || frontmatter.private === true;
}
