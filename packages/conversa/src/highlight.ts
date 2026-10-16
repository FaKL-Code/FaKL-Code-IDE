import { escapeHtml } from './html.js';

/**
 * Realce de sintaxe leve para os blocos de código do chat: um tokenizador de
 * regex por família de linguagem, sem dependência. Devolve HTML já escapado
 * com `<span class="tok-…">`; linguagem desconhecida volta só escapada.
 */

type Family = 'c' | 'python' | 'shell' | 'json' | 'css' | 'html' | 'yaml' | 'diff';

const FAMILY: Record<string, Family> = {
  ts: 'c',
  tsx: 'c',
  typescript: 'c',
  js: 'c',
  jsx: 'c',
  javascript: 'c',
  mjs: 'c',
  cjs: 'c',
  java: 'c',
  kotlin: 'c',
  kt: 'c',
  c: 'c',
  h: 'c',
  cpp: 'c',
  'c++': 'c',
  cs: 'c',
  csharp: 'c',
  go: 'c',
  golang: 'c',
  rust: 'c',
  rs: 'c',
  swift: 'c',
  php: 'c',
  dart: 'c',
  py: 'python',
  python: 'python',
  rb: 'python',
  ruby: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  powershell: 'shell',
  ps1: 'shell',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'yaml',
  diff: 'diff',
  patch: 'diff',
};

const words = (list: string): ReadonlySet<string> => new Set(list.split(' '));

const KEYWORDS: Record<Family, ReadonlySet<string>> = {
  c: words(
    'abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally fn for from func function if impl implements import in instanceof interface is let loop match mod mut namespace new null nil of override package private protected pub public readonly return self static struct super switch this throw trait true try type typeof undefined unsafe use using var void where while with yield',
  ),
  python: words(
    'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self end do module begin rescue unless',
  ),
  shell: words(
    'if then else elif fi for while do done case esac function in return export local echo cd exit set unset source alias sudo Write-Host',
  ),
  json: words('true false null'),
  css: words('important inherit initial unset none auto'),
  html: new Set(),
  yaml: words('true false null yes no on off'),
  diff: new Set(),
};

interface Grammar {
  /** Grupos, em ordem: comentário, string, número, palavra, extra. */
  readonly regex: RegExp;
  readonly kinds: readonly string[];
}

const NUMBER = String.raw`\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b`;
const WORD = String.raw`[A-Za-z_$][\w$]*`;
const DQ = String.raw`"(?:\\.|[^"\\\n])*"?`;
const SQ = String.raw`'(?:\\.|[^'\\\n])*'?`;
const BQ = '`(?:\\\\[\\s\\S]|[^`\\\\])*`?';

function grammar(comment: string, string: string, extra?: string): Grammar {
  const parts = [comment, string, NUMBER, WORD];
  const kinds = ['comment', 'string', 'number', 'word'];
  if (extra) {
    parts.push(extra);
    kinds.push('tag');
  }
  return { regex: new RegExp(parts.map((p) => `(${p})`).join('|'), 'g'), kinds };
}

const GRAMMARS: Partial<Record<Family, Grammar>> = {
  c: grammar(String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`, `${DQ}|${SQ}|${BQ}`),
  python: grammar(
    String.raw`#[^\n]*`,
    String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${DQ}|${SQ}`,
  ),
  shell: grammar(String.raw`#[^\n]*`, `${DQ}|${SQ}`, String.raw`\$\{?[A-Za-z_]\w*\}?`),
  json: grammar(String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`, DQ),
  css: grammar(String.raw`\/\*[\s\S]*?(?:\*\/|$)`, `${DQ}|${SQ}`, String.raw`#[\da-fA-F]{3,8}\b`),
  html: grammar(String.raw`<!--[\s\S]*?(?:-->|$)`, `${DQ}|${SQ}`, String.raw`<\/?[A-Za-z][\w:-]*`),
  yaml: grammar(String.raw`#[^\n]*`, `${DQ}|${SQ}`),
};

const span = (kind: string, text: string): string =>
  `<span class="tok-${kind}">${escapeHtml(text)}</span>`;

function diff(code: string): string {
  return code
    .split('\n')
    .map((line) => {
      const kind = line.startsWith('+')
        ? line.startsWith('+++')
          ? 'meta'
          : 'add'
        : line.startsWith('-')
          ? line.startsWith('---')
            ? 'meta'
            : 'del'
          : line.startsWith('@@')
            ? 'meta'
            : undefined;
      return kind ? span(kind, line) : escapeHtml(line);
    })
    .join('\n');
}

/** Família da linguagem do bloco, ou `undefined` se não há realce para ela. */
export function familyOf(lang: string | undefined): Family | undefined {
  return lang ? FAMILY[lang.toLowerCase()] : undefined;
}

/** Blocos maiores que isto ficam sem realce, para não travar o streaming. */
const MAX_HIGHLIGHT = 60_000;

export function highlight(code: string, lang: string | undefined): string {
  const family = familyOf(lang);
  if (!family || code.length > MAX_HIGHLIGHT) return escapeHtml(code);
  if (family === 'diff') return diff(code);
  const g = GRAMMARS[family];
  if (!g) return escapeHtml(code);
  const keywords = KEYWORDS[family];
  let out = '';
  let last = 0;
  for (const match of code.matchAll(g.regex)) {
    const text = match[0];
    if (text.length === 0) continue;
    const index = match.index;
    out += escapeHtml(code.slice(last, index));
    last = index + text.length;
    const group = match.findIndex((value, i) => i > 0 && Boolean(value)) - 1;
    const kind = g.kinds[group] ?? 'word';
    if (kind === 'word') {
      const next = /^\s*([(:])/.exec(code.slice(last));
      if (keywords.has(text)) out += span('keyword', text);
      else if (/^[A-Z][A-Za-z0-9]*$/.test(text) && family !== 'shell') out += span('type', text);
      else if (next?.[1] === '(') out += span('function', text);
      else out += escapeHtml(text);
    } else if (
      kind === 'string' &&
      (family === 'json' || family === 'yaml') &&
      /^\s*:/.test(code.slice(last))
    ) {
      out += span('property', text);
    } else {
      out += span(kind, text);
    }
  }
  return out + escapeHtml(code.slice(last));
}
