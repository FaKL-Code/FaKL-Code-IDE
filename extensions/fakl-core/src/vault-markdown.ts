import { l10n } from '@fakl/i18n';
import type MarkdownIt from 'markdown-it';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

import { EMBED_MAX_TOTAL, resolveEmbed, type EmbedNote } from './vault-embed.js';

/** Acha o arquivo de um wikilink; devolve o href para a prévia, ou nada se a nota não existe. */
export type WikilinkResolver = (target: string, env: unknown) => string | undefined;

/** Lê uma nota para incorporá-la (`![[nota]]`); a chave da nota aberta serve ao ciclo. */
export interface EmbedSource {
  readonly read: (target: string, env: unknown) => EmbedNote | undefined;
  readonly currentKey?: (env: unknown) => string | undefined;
}

/** Estado do embed numa renderização: notas em andamento e o que resta do orçamento. */
interface EmbedState {
  readonly stack: readonly string[];
  readonly budget: { left: number };
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i;
const CALLOUT = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/;

/** Âncora de título como a prévia do VS Code gera: minúsculas, espaços viram `-`. */
export function headingSlug(text: string): string {
  return encodeURIComponent(
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-'),
  );
}

function wikilink(resolve: WikilinkResolver) {
  return (state: StateInline, silent: boolean): boolean => {
    const { src } = state;
    const embed = src.charCodeAt(state.pos) === 0x21; // !
    const start = embed ? state.pos + 1 : state.pos;
    if (!src.startsWith('[[', start)) return false;
    const end = src.indexOf(']]', start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (!inner.trim() || inner.includes('\n') || inner.includes('[[')) return false;
    if (!silent) {
      const bar = inner.indexOf('|');
      const ref = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
      const alias = bar >= 0 ? inner.slice(bar + 1).trim() : '';
      const hash = ref.indexOf('#');
      const target = (hash >= 0 ? ref.slice(0, hash) : ref).trim();
      const heading = hash >= 0 ? ref.slice(hash + 1).replace(/^\^/, '') : '';
      const found = target ? resolve(target, state.env) : '';
      if (embed && IMAGE.test(target) && found) {
        const image = state.push('image', 'img', 0);
        image.attrs = [
          ['src', found],
          ['alt', alias],
        ];
        const alt = new state.Token('text', '', 0);
        alt.content = alias;
        image.children = alias ? [alt] : [];
        image.content = alias;
      } else {
        const href = `${found ?? encodeURI(`${target}.md`)}${heading ? `#${headingSlug(heading)}` : ''}`;
        const open = state.push('link_open', 'a', 1);
        open.attrs = [
          ['href', href],
          ['class', `fakl-wikilink${found === undefined ? ' fakl-wikilink-missing' : ''}`],
        ];
        if (found === undefined) open.attrs.push(['title', l10n.t("Note doesn't exist yet")]);
        const text = state.push('text', '', 0);
        text.content = alias || (heading ? `${target} › ${heading}` : target) || heading;
        state.push('link_close', 'a', -1);
      }
    }
    state.pos = end + 2;
    return true;
  };
}

/** Só o embed `![[nota]]` ou `![[nota#Título]]` na linha, sem imagem nem anexo. */
const EMBED_LINE = /^!\[\[([^\]\n|]+?)(?:\|[^\]\n]*)?\]\][ \t]*$/;

/**
 * Embed de nota numa linha própria: a prévia incorpora o conteúdo (sem o
 * frontmatter; só a seção, com `#Título`). Quando não dá (nota ausente, ciclo,
 * fundo demais, seção ou bloco `#^id`), a regra recusa e o wikilink de sempre
 * vira link. Embed no meio de um texto continua link.
 */
function noteEmbed(md: MarkdownIt, embed: EmbedSource) {
  return (state: StateBlock, startLine: number, _endLine: number, silent: boolean): boolean => {
    const from = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
    if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) return false;
    const line = state.src.slice(from, state.eMarks[startLine]);
    const match = EMBED_LINE.exec(line);
    if (!match) return false;
    const ref = (match[1] ?? '').trim();
    const hash = ref.indexOf('#');
    const target = (hash >= 0 ? ref.slice(0, hash) : ref).trim();
    const heading = hash >= 0 ? ref.slice(hash + 1).trim() : '';
    // Imagem, PDF e outros anexos têm extensão que não é .md; bloco `^id` não é suportado.
    if (!target || (/\.[A-Za-z0-9]{1,5}$/.test(target) && !/\.md$/i.test(target))) return false;
    if (heading.startsWith('^')) return false;

    const env = (state.env ?? {}) as { faklEmbed?: EmbedState };
    const current = env.faklEmbed ?? { stack: [], budget: { left: EMBED_MAX_TOTAL } };
    const rootKey = embed.currentKey?.(state.env);
    const result = resolveEmbed(
      target.replace(/\.md$/i, ''),
      heading || undefined,
      (name) => embed.read(name, state.env),
      current.stack,
      current.budget,
      rootKey !== undefined ? { rootKey } : {},
    );
    if (result.kind !== 'ok') return false;
    if (silent) return true;

    const inner = md.render(result.markdown, {
      ...env,
      faklEmbed: { stack: [...current.stack, result.key], budget: current.budget },
    });
    const open = state.push('html_block', '', 0);
    open.map = [startLine, startLine + 1];
    open.content = `<div class="fakl-embed" data-embed="${md.utils.escapeHtml(result.key)}">
${inner}</div>
`;
    state.line = startLine + 1;
    return true;
  };
}

/** `> [!tipo] Título` vira um callout do Obsidian. */
function callouts(state: StateCore): void {
  const { tokens } = state;
  for (let i = 0; i < tokens.length - 2; i++) {
    const quote = tokens[i];
    const para = tokens[i + 1];
    const inline = tokens[i + 2];
    if (
      quote?.type !== 'blockquote_open' ||
      para?.type !== 'paragraph_open' ||
      inline?.type !== 'inline'
    ) {
      continue;
    }
    const newline = inline.content.indexOf('\n');
    const first = newline >= 0 ? inline.content.slice(0, newline) : inline.content;
    const match = CALLOUT.exec(first);
    if (!match) continue;
    const kind = (match[1] ?? 'note').toLowerCase();
    const given = match[3]?.trim() ?? '';
    const title = given !== '' ? given : kind.charAt(0).toUpperCase() + kind.slice(1);
    quote.attrJoin('class', `fakl-callout fakl-callout-${kind}`);
    quote.attrSet('data-callout', kind);

    const titleOpen = new state.Token('paragraph_open', 'p', 1);
    titleOpen.attrSet('class', 'fakl-callout-title');
    titleOpen.block = true;
    const titleInline = new state.Token('inline', '', 0);
    titleInline.content = title;
    titleInline.children = [];
    titleInline.block = true;
    const titleClose = new state.Token('paragraph_close', 'p', -1);
    titleClose.block = true;

    const rest = newline >= 0 ? inline.content.slice(newline + 1) : '';
    if (rest.trim()) {
      inline.content = rest;
      tokens.splice(i + 1, 0, titleOpen, titleInline, titleClose);
    } else {
      // Só o título: o parágrafo original sai.
      tokens.splice(i + 1, 3, titleOpen, titleInline, titleClose);
    }
  }
}

/** Plugin da prévia de Markdown: wikilinks, embeds de imagem e de nota, callouts (RF-404). */
export function vaultMarkdown(
  md: MarkdownIt,
  resolve: WikilinkResolver,
  embed?: EmbedSource,
): MarkdownIt {
  md.inline.ruler.before('link', 'fakl_wikilink', wikilink(resolve));
  if (embed) md.block.ruler.before('paragraph', 'fakl_embed', noteEmbed(md, embed));
  md.core.ruler.after('block', 'fakl_callout', callouts);
  return md;
}
