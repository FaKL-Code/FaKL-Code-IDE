import { highlight } from '@fakl/conversa';
import { l10n } from '@fakl/i18n';
import MarkdownIt from 'markdown-it';

import { githubUrl, resolveImage, resolveLink, type DocContext } from '../github-full-model.js';

/*
 * Markdown do GitHub em tela cheia (ADR 0030): markdown-it com HTML ligado,
 * porque READMEs usam <p align>, <img>, <details>; e, depois, uma limpeza por
 * lista de permissão num documento inerte (DOMParser não roda script nem
 * carrega imagem). Só passam tags e atributos conhecidos; links viram rotas
 * do painel, âncoras ou links externos, e imagens só com https ou data:image.
 * O CSP da página é a segunda barreira.
 */

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight: (code, lang) => highlight(code, lang || undefined),
});

/** Tags que somem com o conteúdo. */
const DROP = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'noscript',
  'template',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'head',
  'title',
]);

/** Tags mantidas; o resto é desembrulhado (fica só o conteúdo). */
const KEEP = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'tt',
  'u',
  'ul',
  'var',
  'wbr',
]);

const ATTRS: Record<string, readonly string[]> = {
  '*': ['title', 'align', 'lang', 'dir'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  td: ['colspan', 'rowspan', 'width'],
  th: ['colspan', 'rowspan', 'width', 'scope'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  details: ['open'],
  code: ['class'],
  span: ['class'],
};

/** Título dos avisos do GitHub (`> [!NOTE]` e afins). */
function alertTitle(kind: string): string {
  switch (kind) {
    case 'note':
      return l10n.t('Note');
    case 'tip':
      return l10n.t('Tip');
    case 'important':
      return l10n.t('Important');
    case 'warning':
      return l10n.t('Warning');
    case 'caution':
      return l10n.t('Caution');
    default:
      return kind;
  }
}

/** Âncora de um título, como o GitHub gera (com prefixo, para não colidir com a página). */
export function anchorId(text: string): string {
  return `md-${text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')}`;
}

/** Markdown renderizado e limpo, pronto para entrar na página. */
export function renderMarkdown(source: string, ctx: DocContext | undefined): DocumentFragment {
  const html = md.render(source);
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  clean(parsed.body, ctx);
  taskLists(parsed.body);
  alerts(parsed.body);
  headings(parsed.body);
  const fragment = document.createDocumentFragment();
  for (const node of [...parsed.body.childNodes]) fragment.append(document.adoptNode(node));
  return fragment;
}

function clean(root: Element, ctx: DocContext | undefined): void {
  for (const node of [...root.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove();
      continue;
    }
    if (!(node instanceof Element)) continue;
    const tag = node.tagName.toLowerCase();
    if (DROP.has(tag)) {
      node.remove();
      continue;
    }
    clean(node, ctx);
    if (!KEEP.has(tag)) {
      node.replaceWith(...node.childNodes);
      continue;
    }
    const allowed = new Set([...(ATTRS['*'] ?? []), ...(ATTRS[tag] ?? [])]);
    for (const attr of [...node.attributes]) {
      if (!allowed.has(attr.name)) node.removeAttribute(attr.name);
    }
    const klass = node.getAttribute('class');
    if (klass !== null) {
      // Só as classes do realce de sintaxe.
      const kept = klass.split(/\s+/).filter((c) => /^(tok-[a-z]+|language-[\w+-]+)$/.test(c));
      if (kept.length > 0) node.setAttribute('class', kept.join(' '));
      else node.removeAttribute('class');
    }
    if (tag === 'a') link(node as HTMLAnchorElement, ctx);
    if (tag === 'img') image(node as HTMLImageElement, ctx);
  }
}

function link(anchor: HTMLAnchorElement, ctx: DocContext | undefined): void {
  const href = anchor.getAttribute('href');
  anchor.removeAttribute('href');
  const target = href === null ? undefined : resolveLink(href, ctx);
  if (!target) return;
  // Só o destino já normalizado e seguro entra no DOM, nunca o href original.
  switch (target.kind) {
    case 'anchor': {
      const id = anchorId(target.id.replace(/^md-/, '').replace(/^user-content-/, ''));
      anchor.setAttribute('href', `#${id}`);
      anchor.dataset.anchor = id;
      break;
    }
    case 'route':
      anchor.setAttribute('href', githubUrl(target.route));
      anchor.dataset.route = JSON.stringify(target.route);
      if (target.hash) anchor.dataset.hash = target.hash;
      break;
    case 'external':
      anchor.setAttribute('href', target.url);
      anchor.dataset.external = target.url;
      anchor.title = target.url;
      break;
  }
}

function image(img: HTMLImageElement, ctx: DocContext | undefined): void {
  const src = resolveImage(img.getAttribute('src') ?? '', ctx);
  if (!src) {
    img.remove();
    return;
  }
  img.setAttribute('src', src);
  img.setAttribute('loading', 'lazy');
  img.setAttribute('referrerpolicy', 'no-referrer');
  img.setAttribute('alt', img.getAttribute('alt') ?? '');
}

/** `[ ]` e `[x]` no começo de um item viram caixas de seleção (só leitura). */
function taskLists(root: Element): void {
  for (const li of root.querySelectorAll('li')) {
    const holder = li.firstElementChild?.tagName === 'P' ? li.firstElementChild : li;
    const first = holder.firstChild;
    if (first?.nodeType !== Node.TEXT_NODE) continue;
    const match = /^\[([ xX])\]\s+/.exec(first.textContent ?? '');
    if (!match) continue;
    first.textContent = (first.textContent ?? '').slice(match[0].length);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.disabled = true;
    box.checked = match[1] !== ' ';
    box.setAttribute('aria-label', box.checked ? l10n.t('Done') : l10n.t('To do'));
    holder.insertBefore(box, first);
    li.classList.add('md-task');
    li.parentElement?.classList.add('md-tasks');
  }
}

/** `> [!NOTE]` e afins viram os avisos do GitHub. */
function alerts(root: Element): void {
  for (const quote of root.querySelectorAll('blockquote')) {
    const p = quote.firstElementChild;
    const first = p?.tagName === 'P' ? p.firstChild : undefined;
    if (first?.nodeType !== Node.TEXT_NODE) continue;
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.textContent ?? '');
    if (!match?.[1]) continue;
    const kind = match[1].toLowerCase();
    first.textContent = (first.textContent ?? '').slice(match[0].length);
    if (p?.firstChild?.nodeName === 'BR') p.firstChild.remove();
    const title = document.createElement('p');
    title.className = 'md-alert-title';
    title.textContent = alertTitle(kind);
    quote.prepend(title);
    quote.classList.add('md-alert', `md-alert-${kind}`);
  }
}

function headings(root: Element): void {
  const seen = new Map<string, number>();
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = anchorId(heading.textContent);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    heading.id = count === 0 ? base : `${base}-${String(count)}`;
  }
}
