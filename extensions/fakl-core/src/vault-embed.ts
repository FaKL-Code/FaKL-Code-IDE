/**
 * Resolução do embed `![[nota]]` de uma nota (RF-404), sem dependência do
 * VS Code nem do markdown-it: recebe uma função que lê notas e devolve o
 * Markdown a incorporar, ou o motivo de cair no link.
 */

/** Quantos níveis de embed dentro de embed a prévia segue. */
export const EMBED_MAX_DEPTH = 2;
/** Teto de caracteres por nota incorporada. */
export const EMBED_MAX_CHARS = 20_000;
/** Teto de caracteres incorporados numa mesma prévia, somando todos os embeds. */
export const EMBED_MAX_TOTAL = 100_000;

export interface EmbedNote {
  /** Identifica a nota (o caminho no vault); serve à detecção de ciclo. */
  readonly key: string;
  /** Texto bruto da nota, com frontmatter. */
  readonly text: string;
}

/** Lê uma nota pelo alvo do wikilink; `undefined` se ela não existe. */
export type NoteReader = (target: string) => EmbedNote | undefined;

export type EmbedResult =
  | { readonly kind: 'ok'; readonly key: string; readonly markdown: string }
  /** Nota inexistente, ciclo, fundo demais, seção ausente ou orçamento esgotado: vira link. */
  | {
      readonly kind: 'link';
      readonly reason: 'missing' | 'cycle' | 'depth' | 'section' | 'budget';
    };

export interface EmbedLimits {
  readonly maxDepth?: number;
  readonly maxChars?: number;
  /** Chave da nota aberta na prévia: embutir a si mesma é ciclo. */
  readonly rootKey?: string;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, '');
}

function normalizeHeading(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A seção de um título: do próprio título até o próximo de nível igual ou
 * menor. Ignora títulos dentro de blocos de código. `undefined` se não existe.
 */
export function extractSection(text: string, heading: string): string | undefined {
  const wanted = normalizeHeading(heading);
  const lines = text.split(/\r?\n/);
  let fence: string | undefined;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = HEADING.exec(line);
    if (!match) continue;
    const depth = (match[1] ?? '').length;
    if (start < 0) {
      if (normalizeHeading(match[2] ?? '') === wanted) {
        start = i;
        level = depth;
      }
    } else if (depth <= level) {
      return lines.slice(start, i).join('\n').trimEnd();
    }
  }
  return start < 0 ? undefined : lines.slice(start).join('\n').trimEnd();
}

/** Corta no limite, de preferência numa quebra de linha, e marca o corte. */
export function truncateEmbed(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const newline = cut.lastIndexOf('\n');
  return `${(newline > maxChars / 2 ? cut.slice(0, newline) : cut).trimEnd()}\n\n…`;
}

/**
 * Decide o que a prévia mostra para `![[alvo#título]]`.
 *
 * `stack` traz as chaves das notas incorporadas que estão sendo desenhadas,
 * da mais externa para a mais interna, sem a nota aberta (essa vem em
 * `limits.rootKey`). O embed some no nível `maxDepth + 1`. `budget.left` é o
 * que resta de caracteres para a prévia inteira e é descontado aqui.
 */
export function resolveEmbed(
  target: string,
  heading: string | undefined,
  read: NoteReader,
  stack: readonly string[],
  budget: { left: number },
  limits: EmbedLimits = {},
): EmbedResult {
  const note = read(target);
  if (!note) return { kind: 'link', reason: 'missing' };
  if (note.key === limits.rootKey || stack.includes(note.key)) {
    return { kind: 'link', reason: 'cycle' };
  }
  if (stack.length >= (limits.maxDepth ?? EMBED_MAX_DEPTH)) {
    return { kind: 'link', reason: 'depth' };
  }
  let body = stripFrontmatter(note.text).trim();
  if (heading) {
    const section = extractSection(body, heading);
    if (section === undefined) return { kind: 'link', reason: 'section' };
    body = section;
  }
  if (budget.left <= 0) return { kind: 'link', reason: 'budget' };
  const markdown = truncateEmbed(body, Math.min(limits.maxChars ?? EMBED_MAX_CHARS, budget.left));
  budget.left -= markdown.length;
  return { kind: 'ok', key: note.key, markdown };
}
