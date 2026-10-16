import { escapeHtml } from './html.js';
import { highlight } from './highlight.js';

export { escapeHtml };

export interface MarkdownOptions {
  /** Realça a sintaxe dos blocos de código com linguagem conhecida. */
  readonly highlight?: boolean;
}

/**
 * Markdown mínimo para as respostas dos agentes: blocos de código, código
 * inline, negrito, itálico, títulos, listas, citações e links http(s). Todo
 * texto é escapado antes, então a saída só tem as tags geradas aqui.
 */
export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const out: string[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
    }
    list = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const marker = fence[1] ?? '```';
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? '').trimStart().startsWith(marker); i++) {
        code.push(lines[i] ?? '');
      }
      const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : '';
      const body = code.join('\n');
      const html = options.highlight ? highlight(body, fence[2]) : escapeHtml(body);
      out.push(`<pre${lang}><code>${html}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min((heading[1] ?? '#').length + 2, 6);
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = /\d/.test(item[1] ?? '');
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item[2] ?? '');
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${inline(quote[1] ?? '')}</blockquote>`);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return out.join('');
}

function inline(text: string): string {
  // Código inline primeiro, para o conteúdo dele não virar negrito ou link.
  return escapeHtml(text)
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${part.slice(1, -1)}</code>`;
      }
      return part
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(
          /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
          (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
        );
    })
    .join('');
}
