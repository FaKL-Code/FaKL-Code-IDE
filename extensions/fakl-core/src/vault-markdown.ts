import { l10n } from '@fakl/i18n';
import type MarkdownIt from 'markdown-it';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

/** Acha o arquivo de um wikilink; devolve o href para a prévia, ou nada se a nota não existe. */
export type WikilinkResolver = (target: string, env: unknown) => string | undefined;

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

/** Plugin da prévia de Markdown: wikilinks, embeds de imagem e callouts (RF-404). */
export function vaultMarkdown(md: MarkdownIt, resolve: WikilinkResolver): MarkdownIt {
  md.inline.ruler.before('link', 'fakl_wikilink', wikilink(resolve));
  md.core.ruler.after('block', 'fakl_callout', callouts);
  return md;
}
