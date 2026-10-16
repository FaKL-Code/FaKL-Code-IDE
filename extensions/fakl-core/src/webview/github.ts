import { highlight } from '@fakl/conversa';
import { currentLocale, l10n, useLocale } from '@fakl/i18n';

import {
  blogUrl,
  breadcrumbs,
  formatBytes,
  formatCount,
  formatDuration,
  githubUrl,
  parseGitHubUrl,
  relativeTime,
  repoFilters,
  routeKey,
  sameUserTab,
  USER_TAB_LABELS,
  userRoute,
} from '../github-full-model.js';
import type {
  CheckView,
  EntryView,
  FullFromWebview,
  FullToWebview,
  ItemRow,
  ItemState,
  LabelView,
  MoreRows,
  MarkdownDoc,
  NotificationRow,
  Page,
  Person,
  PullFileView,
  ReleaseView,
  RepoFilters,
  RepoHeader,
  RepoRow,
  RepoSort,
  RepoTab,
  RepoType,
  Route,
  RunRow,
  RunState,
  TimelineEntry,
  UserBody,
  UserTab,
} from '../github-full-protocol.js';
import { COMMENT_LIMIT } from '../github-full-protocol.js';
import { anchorId, renderMarkdown } from './github-markdown.js';

/*
 * GitHub em tela cheia (ADR 0030): telas próprias montadas com os dados que a
 * extensão lê da API. Navegação por rotas, com voltar e avançar na extensão;
 * links internos (repo, PR, issue, usuário, arquivo) ficam no painel e os
 * externos abrem no navegador do sistema. Nada aqui tem o token.
 */

interface VsCodeApi {
  postMessage(message: FullFromWebview): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// O host põe o idioma da IDE no <html lang>.
useLocale(document.documentElement.lang);

const vscode = acquireVsCodeApi();
const send = (message: FullFromWebview): void => {
  // Sair da lista (outra tela, voltar, avançar) descarta a busca ainda esperando a pausa.
  if (
    message.type === 'back' ||
    message.type === 'forward' ||
    (message.type === 'navigate' && !message.replace && !sameUserTab(route, message.route))
  ) {
    cancelSearch();
  }
  vscode.postMessage(message);
};
const go = (route: Route): void => {
  send({ type: 'navigate', route });
};

// ----------------------------------------------------------------- DOM

type Child = Node | string | number | false | null | undefined | readonly Child[];

interface Props {
  readonly class?: string;
  readonly attrs?: Readonly<Record<string, string | undefined>>;
  readonly onClick?: (event: MouseEvent) => void;
  readonly style?: Readonly<Record<string, string>>;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props?.class) element.className = props.class;
  for (const [name, value] of Object.entries(props?.attrs ?? {})) {
    if (value !== undefined) element.setAttribute(name, value);
  }
  // CSSOM, não atributo `style`: o CSP da página não libera estilo inline.
  for (const [name, value] of Object.entries(props?.style ?? {})) {
    element.style.setProperty(name, value);
  }
  const onClick = props?.onClick;
  if (onClick) {
    element.addEventListener('click', (event) => {
      if (event instanceof MouseEvent) onClick(event);
    });
  }
  append(element, children);
  return element;
}

function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      append(parent, child);
    }
  }
}

/**
 * Texto traduzido com nós (links, datas, códigos) no lugar de {0}, {1}…, para
 * a frase inteira ficar num texto só e cada idioma pôr as partes na sua ordem.
 */
function fill(text: string, ...parts: Child[]): Child[] {
  return text.split(/(\{\d+\})/).map((piece) => {
    const index = /^\{(\d+)\}$/.exec(piece)?.[1];
    return index === undefined ? piece : parts[Number(index)];
  });
}

/** Locale das datas e números escritos por extenso, o mesmo da interface. */
function dateLocale(): string {
  return currentLocale() === 'pt-br' ? 'pt-BR' : 'en-US';
}

/** Link interno: um `<a>` de verdade (foco, menu de contexto), que navega no painel. */
function link(route: Route, children: Child, cls = 'link', current = false): HTMLAnchorElement {
  return h(
    'a',
    {
      class: cls,
      attrs: { href: githubUrl(route), ...(current ? { 'aria-current': 'page' } : {}) },
      onClick: (event) => {
        event.preventDefault();
        go(route);
      },
    },
    children,
  );
}

function external(url: string, children: Child, cls = 'link'): HTMLAnchorElement {
  return h(
    'a',
    {
      class: cls,
      attrs: { href: url, title: url },
      onClick: (event) => {
        event.preventDefault();
        send({ type: 'external', url });
      },
    },
    children,
  );
}

/** Nome acessível e dica de um elemento que só mostra ícone ou imagem. */
function labeled<T extends HTMLElement>(element: T, text: string): T {
  element.setAttribute('aria-label', text);
  element.title = text;
  return element;
}

function button(
  label: Child,
  onClick: () => void,
  options: { kind?: 'primary' | 'quiet' | 'danger'; icon?: IconName; title?: string } = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      class: `btn${options.kind ? ` btn-${options.kind}` : ''}`,
      attrs: { type: 'button', ...(options.title ? { title: options.title } : {}) },
      onClick: () => {
        onClick();
      },
    },
    options.icon ? icon(options.icon) : null,
    h('span', null, label),
  );
}

function iconButton(name: IconName, label: string, onClick: () => void, disabled = false) {
  const element = h(
    'button',
    {
      class: 'icon-btn',
      attrs: { type: 'button', 'aria-label': label, title: label },
      onClick: () => {
        onClick();
      },
    },
    icon(name),
  );
  element.disabled = disabled;
  return element;
}

// --------------------------------------------------------------- ícones

const ICONS = {
  back: '<path d="M10 3 5 8l5 5"/>',
  forward: '<path d="m6 3 5 5-5 5"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5"/>',
  external:
    '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  home: '<path d="M2.5 7.5 8 3l5.5 4.5M4 6.5v6.5h3v-3.5h2V13h3V6.5"/>',
  repo: '<path d="M3.5 12.5v-9a1 1 0 0 1 1-1h8v10h-8a1 1 0 0 0-1 1 1 1 0 0 0 1 1h3M6 14.5v-2h3v2l-1.5-.8z"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  star: '<path d="m8 2 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2 4.4 13.1l.7-4-2.9-2.8 4-.6z"/>',
  fork: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="11.5" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4.5 5v1a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V5M8 8v3"/>',
  issue: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1" fill="currentColor"/>',
  issueClosed: '<circle cx="8" cy="8" r="5.5"/><path d="m5.5 8 1.8 1.8L10.8 6.3"/>',
  pr: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 11V6a2 2 0 0 0-2-2H7M8.5 2.5 7 4l1.5 1.5"/>',
  merged:
    '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="8.5" r="1.5"/><path d="M4.5 5v6M4.5 5c0 2.5 2 3.5 5.5 3.5"/>',
  prClosed:
    '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 8v3M10 2.5l3 3M13 2.5l-3 3"/>',
  draft:
    '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="12.5" r="1.5"/><path d="M4.5 5v6M11.5 4v.5M11.5 7v.5M11.5 10v.5"/>',
  play: '<circle cx="8" cy="8" r="5.5"/><path d="M7 5.8v4.4L10.3 8z" fill="currentColor"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r=".9" fill="currentColor"/>',
  bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 13.5a1.5 1.5 0 0 0 3 0"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  circle: '<circle cx="8" cy="8" r="5.5"/>',
  dot: '<circle cx="8" cy="8" r="3" fill="currentColor"/>',
  skip: '<circle cx="8" cy="8" r="5.5"/><path d="m4.2 11.8 7.6-7.6"/>',
  folder:
    '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  file: '<path d="M9.5 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5zM9.5 2v3.5H13"/>',
  submodule:
    '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM7 9h4M9 7l2 2-2 2"/>',
  book: '<path d="M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5h4z"/>',
  comment: '<path d="M2.5 3.5h11v7.5h-6L4.5 13.5V11h-2z"/>',
  branch:
    '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-4 2.5-7 4.5"/>',
  commit: '<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>',
  code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  people:
    '<circle cx="6" cy="5.5" r="2.2"/><path d="M2 13c0-2.2 1.8-3.8 4-3.8s4 1.6 4 3.8M10.5 3.5a2 2 0 0 1 0 4M12 9.5c1.3.5 2 1.8 2 3.5"/>',
  location:
    '<path d="M8 14s4.5-4 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 10 8 14 8 14z"/><circle cx="8" cy="6.5" r="1.5"/>',
  linkIcon:
    '<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2.5-2.5a2.5 2.5 0 0 0-3.5-3.5L8.8 3.7M9 7a2.5 2.5 0 0 0-3.5 0L3 9.5A2.5 2.5 0 0 0 6.5 13l.7-.7"/>',
  org: '<path d="M2.5 13.5v-10a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v10M9.5 6.5h3a1 1 0 0 1 1 1v6M1.5 13.5h13M5 5h2M5 7.5h2M5 10h2"/>',
  editor: '<path d="M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10H11"/>',
  rocket:
    '<path d="M9.5 2.5c2.5 0 4 1.5 4 4L9 11 5 7zM5 7 2.5 7.5 4 5.5h3M9 11l-.5 2.5 2-1.5V9M4.5 11.5l-2 2"/>',
  rerun: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5"/>',
  log: '<path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5"/>',
  clone: '<path d="M8 2.5v7M5 6.5l3 3 3-3M3 11.5v2h10v-2"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  warning: '<path d="M8 2.5 14 13H2zM8 6.5v3M8 11.2v.3"/>',
} as const;

type IconName = keyof typeof ICONS;

function icon(name: IconName, cls = 'icon'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  // Caminhos fixos deste arquivo, nunca dados da API.
  svg.innerHTML = ICONS[name];
  return svg;
}

// ------------------------------------------------------------ componentes

function stateText(kind: 'pr' | 'issue', state: ItemState): string {
  switch (state) {
    case 'open':
      return kind === 'issue' ? l10n.t('Open issue') : l10n.t('PR open');
    case 'closed':
      return kind === 'issue' ? l10n.t('Closed issue') : l10n.t('Closed PR');
    case 'merged':
      return l10n.t('Merged');
    case 'draft':
      return l10n.t('Draft');
  }
}

function runText(state: RunState): string {
  switch (state) {
    case 'success':
      return l10n.t('Success');
    case 'failure':
      return l10n.t('Failed');
    case 'running':
      return l10n.t('In progress');
    case 'queued':
      return l10n.t('Queued');
    case 'cancelled':
      return l10n.t('Canceled');
    case 'neutral':
      return l10n.t('Completed');
  }
}

/** Contadores com plural: "1 comentário", "3 comentários". */
function commentsText(count: number): string {
  return count === 1 ? l10n.t('1 comment') : l10n.t('{0} comments', String(count));
}

function starsText(count: number, shown: string): string {
  return count === 1 ? l10n.t('1 star') : l10n.t('{0} stars', shown);
}

function forksText(count: number, shown: string): string {
  return count === 1 ? l10n.t('1 fork') : l10n.t('{0} forks', shown);
}

function itemIcon(kind: 'pr' | 'issue', state: ItemState): IconName {
  if (kind === 'issue') return state === 'closed' ? 'issueClosed' : 'issue';
  return state === 'merged'
    ? 'merged'
    : state === 'closed'
      ? 'prClosed'
      : state === 'draft'
        ? 'draft'
        : 'pr';
}

function runIcon(state: RunState): IconName {
  switch (state) {
    case 'success':
      return 'check';
    case 'failure':
      return 'x';
    case 'running':
      return 'dot';
    case 'queued':
      return 'circle';
    case 'cancelled':
      return 'skip';
    case 'neutral':
      return 'circle';
  }
}

function statePill(kind: 'pr' | 'issue', state: ItemState): HTMLElement {
  return h(
    'span',
    { class: `pill pill-${state}` },
    icon(itemIcon(kind, state)),
    stateText(kind, state),
  );
}

function runBadge(state: RunState): HTMLElement {
  return h(
    'span',
    { class: `run run-${state}`, attrs: { title: runText(state) } },
    icon(runIcon(state)),
    h('span', { class: 'sr-only' }, runText(state)),
  );
}

function label(l: LabelView): HTMLElement {
  return h(
    'span',
    {
      class: `label${l.color ? ` label-${l.ink}` : ''}`,
      ...(l.color ? { style: { '--label': l.color } } : {}),
    },
    l.name,
  );
}

function avatar(p: Person | undefined, size: 'sm' | 'md' | 'lg' | 'xl' = 'sm'): HTMLElement {
  if (!p?.avatar) {
    return h(
      'span',
      { class: `avatar avatar-${size} avatar-empty`, attrs: { 'aria-hidden': 'true' } },
      (p?.login ?? '?').slice(0, 1).toUpperCase(),
    );
  }
  const url = new URL(p.avatar);
  url.searchParams.set('s', size === 'xl' ? '240' : size === 'lg' ? '96' : '48');
  return h('img', {
    class: `avatar avatar-${size}`,
    attrs: { src: url.toString(), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' },
  });
}

function userLink(login: string | undefined): Child {
  if (!login) return l10n.t('someone');
  if (login.endsWith('[bot]')) return h('span', { class: 'strong' }, login);
  return link({ view: 'user', login }, login, 'link strong');
}

function time(iso: string | undefined): HTMLElement | null {
  if (!iso) return null;
  return h(
    'time',
    { attrs: { datetime: iso, title: new Date(iso).toLocaleString(dateLocale()) } },
    relativeTime(iso),
  );
}

function mono(text: string, cls = 'mono'): HTMLElement {
  return h('code', { class: cls }, text);
}

/** Cor de bolinha das linguagens mais comuns (as do GitHub). */
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Go: '#00ADD8',
  Rust: '#dea584',
  Java: '#b07219',
  Kotlin: '#A97BFF',
  'C#': '#178600',
  'C++': '#f34b7d',
  C: '#555555',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Swift: '#F05138',
  Dart: '#00B4AB',
  Shell: '#89e051',
  PowerShell: '#012456',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Lua: '#000080',
  Dockerfile: '#384d54',
  Nix: '#7e7eff',
  'Jupyter Notebook': '#DA5B0B',
  MDX: '#fcb32c',
  Astro: '#ff5a03',
};

function langDot(name: string, known?: string): HTMLElement {
  const color = known ?? LANGUAGE_COLORS[name];
  return h('span', {
    class: 'lang-dot',
    attrs: { 'aria-hidden': 'true' },
    ...(color ? { style: { '--lang': color } } : {}),
  });
}

function section(
  title: Child,
  count: number | undefined,
  body: Child,
  action?: Child,
): HTMLElement {
  return h(
    'section',
    { class: 'block' },
    h(
      'header',
      { class: 'block-head' },
      h(
        'h2',
        null,
        title,
        count !== undefined ? h('span', { class: 'count' }, formatCount(count)) : null,
      ),
      action ?? null,
    ),
    body,
  );
}

function empty(text: string, action?: Child): HTMLElement {
  return h('div', { class: 'empty' }, h('p', null, text), action ?? null);
}

function markdown(
  doc: MarkdownDoc,
  repo: { owner: string; name: string } | undefined,
): HTMLElement {
  const body = h('div', { class: 'markdown' });
  if (!doc.markdown.trim()) {
    body.append(h('p', { class: 'muted' }, l10n.t('No description.')));
    return body;
  }
  body.append(
    renderMarkdown(
      doc.markdown,
      repo ? { owner: repo.owner, name: repo.name, ref: doc.ref, dir: doc.dir } : undefined,
    ),
  );
  return body;
}

// ------------------------------------------------------------- listas

function itemRow(item: ItemRow, showRepo: boolean): HTMLElement {
  const route: Route =
    item.kind === 'pr'
      ? {
          view: 'pull',
          owner: item.owner,
          name: item.name,
          number: item.number,
          tab: 'conversation',
        }
      : { view: 'issue', owner: item.owner, name: item.name, number: item.number };
  return h(
    'li',
    { class: 'row' },
    h('span', { class: `row-icon state-${item.state}` }, icon(itemIcon(item.kind, item.state))),
    h(
      'div',
      { class: 'row-main' },
      h(
        'div',
        { class: 'row-title' },
        showRepo ? h('span', { class: 'row-repo' }, `${item.owner}/${item.name}`) : null,
        link(route, item.title, 'row-link'),
        item.labels.map(label),
      ),
      h(
        'div',
        { class: 'row-meta' },
        `#${String(item.number)} `,
        item.author
          ? fill(l10n.t('by {0} · updated {1}'), item.author, time(item.updatedAt))
          : fill(l10n.t('updated {0}'), time(item.updatedAt)),
      ),
    ),
    item.comments > 0
      ? h(
          'span',
          { class: 'row-side', attrs: { title: commentsText(item.comments) } },
          icon('comment'),
          String(item.comments),
        )
      : null,
  );
}

function itemList(items: readonly ItemRow[], showRepo: boolean, emptyText: string): HTMLElement {
  if (items.length === 0) return empty(emptyText);
  return h(
    'ul',
    { class: 'rows' },
    items.map((item) => itemRow(item, showRepo)),
  );
}

/**
 * Linha de repositório. `owner: false` tira o dono do nome (a lista de um
 * perfil); `visibility` mostra Público/Privado em toda linha, como no GitHub.
 */
function repoCard(
  repo: RepoRow,
  options: { readonly owner?: boolean; readonly visibility?: boolean } = {},
): HTMLElement {
  return h(
    'li',
    { class: 'row repo-row' },
    h('span', { class: 'row-icon' }, icon(repo.private ? 'lock' : 'repo')),
    h(
      'div',
      { class: 'row-main' },
      h(
        'div',
        { class: 'row-title' },
        link(
          { view: 'repo', owner: repo.owner, name: repo.name, tab: 'code' },
          options.owner === false
            ? repo.name
            : [h('span', { class: 'muted' }, `${repo.owner}/`), repo.name],
          'row-link',
        ),
        repo.private || options.visibility
          ? h('span', { class: 'tag' }, repo.private ? l10n.t('Private') : l10n.t('Public'))
          : null,
        repo.archived ? h('span', { class: 'tag tag-warn' }, l10n.t('Archived')) : null,
        repo.fork ? h('span', { class: 'tag' }, l10n.t('Fork')) : null,
      ),
      repo.description ? h('p', { class: 'row-desc' }, repo.description) : null,
      h(
        'div',
        { class: 'row-meta' },
        repo.language
          ? h(
              'span',
              { class: 'meta-item' },
              langDot(repo.language, repo.languageColor),
              repo.language,
            )
          : null,
        repo.stars > 0
          ? h(
              'span',
              { class: 'meta-item', attrs: { title: starsText(repo.stars, String(repo.stars)) } },
              icon('star'),
              formatCount(repo.stars),
            )
          : null,
        repo.forks > 0
          ? h(
              'span',
              { class: 'meta-item', attrs: { title: forksText(repo.forks, String(repo.forks)) } },
              icon('fork'),
              formatCount(repo.forks),
            )
          : null,
        repo.updatedAt
          ? h('span', { class: 'meta-item' }, fill(l10n.t('updated {0}'), time(repo.updatedAt)))
          : null,
      ),
    ),
  );
}

function runRowView(run: RunRow, showRepo: boolean): HTMLElement {
  return h(
    'li',
    { class: 'row' },
    h('span', { class: 'row-icon' }, runBadge(run.state)),
    h(
      'div',
      { class: 'row-main' },
      h(
        'div',
        { class: 'row-title' },
        showRepo ? h('span', { class: 'row-repo' }, `${run.owner}/${run.name}`) : null,
        link({ view: 'run', owner: run.owner, name: run.name, id: run.id }, run.title, 'row-link'),
      ),
      h(
        'div',
        { class: 'row-meta' },
        h('span', { class: 'strong' }, run.workflow),
        ` #${String(run.number)} · ${run.event}`,
        run.branch ? [' ', fill(l10n.t('on {0}'), mono(run.branch, 'mono branch'))] : null,
        ' · ',
        time(run.createdAt),
      ),
    ),
  );
}

function notificationRowView(n: NotificationRow, compact: boolean): HTMLElement {
  const kind = n.type === 'PullRequest' ? 'pr' : n.type === 'Issue' ? 'issue' : undefined;
  const title = n.route ? link(n.route, n.title, 'row-link') : external(n.url, n.title, 'row-link');
  return h(
    'li',
    { class: `row${n.unread ? ' unread' : ''}`, attrs: { 'data-notification': n.id } },
    h(
      'span',
      { class: 'row-icon' },
      icon(kind ? itemIcon(kind, 'open') : n.type === 'Release' ? 'tag' : 'bell'),
    ),
    h(
      'div',
      { class: 'row-main' },
      h(
        'div',
        { class: 'row-title' },
        compact ? h('span', { class: 'row-repo' }, n.repo) : null,
        title,
      ),
      h('div', { class: 'row-meta' }, n.reason, ' · ', time(n.updatedAt)),
    ),
    !compact && n.unread
      ? iconButton('check', l10n.t('Mark as read'), () => {
          send({ type: 'markRead', id: n.id });
        })
      : null,
  );
}

// ------------------------------------------------------ "Carregar mais"

interface MoreTarget {
  readonly list: HTMLElement;
  readonly foot: HTMLElement;
  readonly render: (rows: MoreRows) => Node[];
  readonly allUrl: string;
}

/** A lista paginada da tela atual (há no máximo uma por tela). */
let moreTarget: MoreTarget | undefined;

/**
 * Lista com "Carregar mais" (a próxima página vem da extensão) e, enquanto
 * houver mais, o link para ver tudo no GitHub.
 */
function paged(
  list: HTMLElement,
  hasMore: boolean,
  render: (rows: MoreRows) => Node[],
  allUrl: string,
): HTMLElement {
  const target: MoreTarget = { list, foot: h('div', { class: 'more' }), render, allUrl };
  moreTarget = target;
  moreFoot(target, hasMore);
  return h('div', { class: 'paged' }, list, target.foot);
}

function moreFoot(target: MoreTarget, hasMore: boolean): void {
  if (!hasMore) {
    target.foot.replaceChildren();
    return;
  }
  const load = button(
    l10n.t('Load more'),
    () => {
      load.disabled = true;
      load.setAttribute('aria-busy', 'true');
      send({ type: 'more', key: routeKey(route) });
    },
    { kind: 'quiet' },
  );
  target.foot.replaceChildren(
    load,
    external(target.allUrl, l10n.t('See all on GitHub'), 'link small'),
  );
}

/** Linhas de uma página a mais, no mesmo formato da lista. */
function moreRows(rows: MoreRows, repo?: RepoHeader): Node[] {
  switch (rows.kind) {
    case 'items':
      return rows.items.map((item) => itemRow(item, false));
    case 'runs':
      return rows.runs.map((run) => runRowView(run, false));
    case 'repos':
      return rows.repos.map((r) => repoCard(r));
    case 'releases':
      return repo ? rows.releases.map((r) => releaseView(r, repo)) : [];
    case 'people':
      return rows.people.map(personRow);
  }
}

// ---------------------------------------------------- moldura da página

const app = document.getElementById('app') ?? document.body;
let route: Route = { view: 'home' };
let canBack = false;
let canForward = false;
/** Conta logada, para o avatar e o atalho de repositórios no topo. */
let viewer: Person | undefined;
const live = h('div', { class: 'sr-only', attrs: { 'aria-live': 'polite', role: 'status' } });
const toast = h('div', { class: 'toast', attrs: { role: 'status', 'aria-live': 'polite' } });

function topbar(): HTMLElement {
  const crumbs = breadcrumbs(route);
  const search = h('input', {
    class: 'search-input',
    attrs: {
      type: 'search',
      placeholder: l10n.t('Search repositories or paste a GitHub link'),
      'aria-label': l10n.t('Search repositories or paste a GitHub link'),
      spellcheck: 'false',
    },
  });
  if (route.view === 'search') search.value = route.q;
  const form = h('form', { class: 'search', attrs: { role: 'search' } }, icon('search'), search);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = search.value.trim();
    if (!q) return;
    // Um link do GitHub colado abre direto no painel.
    if (/^https?:\/\//i.test(q)) {
      // O mesmo parser da extensão, que confere a rota de novo.
      const target = parseGitHubUrl(q);
      if (target) go(target);
      else send({ type: 'external', url: q });
      return;
    }
    go({ view: 'search', q });
  });
  return h(
    'header',
    { class: 'topbar' },
    h(
      'nav',
      { class: 'nav-buttons', attrs: { 'aria-label': l10n.t('History') } },
      iconButton(
        'back',
        l10n.t('Back (Alt+←)'),
        () => {
          send({ type: 'back' });
        },
        !canBack,
      ),
      iconButton(
        'forward',
        l10n.t('Forward (Alt+→)'),
        () => {
          send({ type: 'forward' });
        },
        !canForward,
      ),
      iconButton('reload', l10n.t('Refresh'), () => {
        send({ type: 'reload' });
      }),
      route.view === 'home'
        ? null
        : iconButton('home', l10n.t('Home'), () => {
            go({ view: 'home' });
          }),
    ),
    h(
      'nav',
      { class: 'crumbs', attrs: { 'aria-label': l10n.t('You are here') } },
      h(
        'ol',
        null,
        crumbs.map((crumb, index) =>
          h(
            'li',
            null,
            index > 0
              ? h('span', { class: 'crumb-sep', attrs: { 'aria-hidden': 'true' } }, '/')
              : null,
            crumb.route
              ? link(crumb.route, crumb.label, 'crumb')
              : h(
                  'span',
                  { class: 'crumb crumb-current', attrs: { 'aria-current': 'page' } },
                  crumb.label,
                ),
          ),
        ),
      ),
    ),
    form,
    h(
      'div',
      { class: 'top-actions' },
      route.view === 'notifications'
        ? null
        : iconButton('bell', l10n.t('Notifications'), () => {
            go({ view: 'notifications' });
          }),
      viewer
        ? labeled(
            link(userRoute(viewer.login, 'repositories'), icon('repo'), 'icon-btn'),
            l10n.t('Your repositories'),
          )
        : null,
      iconButton('external', l10n.t('Open this page in the browser'), () => {
        send({ type: 'external', url: githubUrl(route) });
      }),
      viewer
        ? labeled(
            link(userRoute(viewer.login), avatar(viewer, 'sm'), 'top-me'),
            l10n.t('Your profile ({0})', viewer.login),
          )
        : null,
    ),
  );
}

function frame(content: HTMLElement): void {
  app.replaceChildren(
    topbar(),
    h('main', { class: 'page', attrs: { id: 'conteudo', tabindex: '-1' } }, content),
    toast,
    live,
  );
}

function skeleton(): HTMLElement {
  const bar = (cls: string): HTMLElement => h('div', { class: `skel ${cls}` });
  return h(
    'div',
    { class: 'wrap', attrs: { 'aria-busy': 'true' } },
    h('span', { class: 'sr-only' }, l10n.t('Loading…')),
    bar('skel-title'),
    bar('skel-line'),
    h(
      'div',
      { class: 'skel-rows' },
      Array.from({ length: 6 }, () => bar('skel-row')),
    ),
  );
}

// -------------------------------------------------------------- telas

/** "Ver todos no GitHub" quando a lista mostra só parte do total. */
function seeAll(total: number, shown: number, url: string): Child {
  return total > shown
    ? external(url, l10n.t('See all {0} on GitHub', formatCount(total)), 'link small')
    : null;
}

function homePage(page: Extract<Page, { view: 'home' }>): HTMLElement {
  return h(
    'div',
    { class: 'wrap' },
    h(
      'div',
      { class: 'hello' },
      avatar(page.me, 'lg'),
      h(
        'div',
        null,
        h('h1', { class: 'hello-name' }, page.me.name ?? page.me.login),
        h(
          'p',
          { class: 'muted' },
          fill(
            l10n.t('{0} · what needs you now'),
            link({ view: 'user', login: page.me.login }, `@${page.me.login}`),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'columns' },
      h(
        'div',
        { class: 'col-main' },
        section(
          l10n.t('Review requested from you'),
          page.totals.reviews,
          itemList(page.reviews, true, l10n.t('No PRs waiting for your review.')),
          seeAll(
            page.totals.reviews,
            page.reviews.length,
            'https://github.com/pulls/review-requested',
          ),
        ),
        section(
          l10n.t('Your pull requests'),
          page.totals.mine,
          itemList(page.mine, true, l10n.t('You have no open PRs.')),
          seeAll(page.totals.mine, page.mine.length, 'https://github.com/pulls'),
        ),
        section(
          l10n.t('Issues assigned to you'),
          page.totals.assigned,
          itemList(page.assigned, true, l10n.t('No open issues assigned to you.')),
          seeAll(page.totals.assigned, page.assigned.length, 'https://github.com/issues/assigned'),
        ),
      ),
      h(
        'aside',
        { class: 'col-side' },
        section(
          l10n.t('Notifications'),
          page.notifications.length || undefined,
          page.notificationsError
            ? empty(
                l10n.t(
                  'The token cannot read notifications. Fine-grained tokens have no access to them.',
                ),
                button(
                  l10n.t('Diagnose access'),
                  () => {
                    send({ type: 'action', action: 'diagnose' });
                  },
                  { kind: 'quiet' },
                ),
              )
            : page.notifications.length === 0
              ? empty(l10n.t('All caught up.'))
              : h(
                  'ul',
                  { class: 'rows' },
                  page.notifications.map((n) => notificationRowView(n, true)),
                ),
          link({ view: 'notifications' }, l10n.t('See all notifications'), 'link small'),
        ),
        section(
          l10n.t('Recent repositories'),
          undefined,
          page.repos.length === 0
            ? empty(l10n.t('No repositories yet.'))
            : h(
                'ul',
                { class: 'mini-repos' },
                page.repos.map((r) =>
                  h(
                    'li',
                    null,
                    icon(r.private ? 'lock' : 'repo'),
                    link({ view: 'repo', owner: r.owner, name: r.name, tab: 'code' }, [
                      h('span', { class: 'muted' }, `${r.owner}/`),
                      r.name,
                    ]),
                  ),
                ),
              ),
          link(
            userRoute(page.me.login, 'repositories'),
            l10n.t('See all repositories'),
            'link small',
          ),
        ),
      ),
    ),
  );
}

function searchPage(page: Extract<Page, { view: 'search' }>): HTMLElement {
  return h(
    'div',
    { class: 'wrap narrow' },
    h('h1', { class: 'page-title' }, l10n.t('Repositories matching “{0}”', page.q)),
    h(
      'p',
      { class: 'muted' },
      page.total === 1
        ? l10n.t('1 result on GitHub')
        : l10n.t('{0} results on GitHub', formatCount(page.total)),
    ),
    page.repos.length === 0
      ? empty(
          l10n.t('Nothing found. Try another term, or filters like user:octocat and language:go.'),
        )
      : paged(
          h(
            'ul',
            { class: 'rows' },
            page.repos.map((r) => repoCard(r)),
          ),
          page.hasMore,
          (rows) => moreRows(rows),
          githubUrl(route),
        ),
  );
}

function notificationsPage(page: Extract<Page, { view: 'notifications' }>): HTMLElement {
  const unread = page.groups.reduce((sum, g) => sum + g.unread, 0);
  return h(
    'div',
    { class: 'wrap narrow' },
    h(
      'div',
      { class: 'page-head' },
      h(
        'h1',
        { class: 'page-title' },
        l10n.t('Notifications'),
        h('span', { class: 'count' }, String(unread)),
      ),
      unread > 0
        ? button(
            l10n.t('Mark all as read'),
            () => {
              send({ type: 'action', action: 'markAllRead' });
            },
            { icon: 'check', kind: 'quiet' },
          )
        : null,
    ),
    page.groups.length === 0
      ? empty(
          l10n.t(
            'No unread notifications. When someone requests your review or mentions you, it shows up here.',
          ),
        )
      : page.groups.map((group) => {
          const [owner = '', name = ''] = group.repo.split('/');
          return section(
            link({ view: 'repo', owner, name, tab: 'code' }, group.repo),
            group.unread,
            h(
              'ul',
              { class: 'rows' },
              group.items.map((n) => notificationRowView(n, false)),
            ),
          );
        }),
    page.truncated
      ? h(
          'p',
          { class: 'muted more' },
          fill(
            l10n.t('Showing the 100 most recent. {0}'),
            external('https://github.com/notifications', l10n.t('See all notifications on GitHub')),
          ),
        )
      : null,
  );
}

type UserPage = Extract<Page, { view: 'user' }>;

/** Coluna de identidade do perfil: quem é, onde está, de quem faz parte. */
function profileSide(page: UserPage): HTMLElement {
  const p = page.profile;
  const org = p.kind === 'Organization';
  const blog = p.blog ? blogUrl(p.blog) : undefined;
  const count = (n: number | undefined, tab: UserTab, text: string): HTMLElement =>
    link(
      userRoute(p.login, tab),
      fill(text, h('span', { class: 'strong' }, formatCount(n ?? 0))),
      'link-quiet',
    );
  return h(
    'aside',
    { class: 'profile-card' },
    avatar(p, 'xl'),
    h(
      'h1',
      { class: 'profile-name' },
      p.name ?? p.login,
      h('span', { class: 'profile-login' }, p.login),
    ),
    org ? h('span', { class: 'tag' }, l10n.t('Organization')) : null,
    p.bio ? h('p', { class: 'profile-bio' }, p.bio) : null,
    h(
      'ul',
      { class: 'facts' },
      !org && p.followers !== undefined
        ? h(
            'li',
            null,
            icon('people'),
            count(
              p.followers,
              'followers',
              p.followers === 1 ? l10n.t('{0} follower') : l10n.t('{0} followers'),
            ),
            h('span', { attrs: { 'aria-hidden': 'true' } }, '·'),
            count(p.following, 'following', l10n.t('{0} following')),
          )
        : null,
      p.company ? h('li', null, icon('org'), p.company) : null,
      p.location ? h('li', null, icon('location'), p.location) : null,
      blog && p.blog
        ? h('li', null, icon('linkIcon'), external(blog, p.blog.replace(/^https?:\/\//, '')))
        : null,
    ),
    page.circle.length > 0
      ? h(
          'section',
          { class: 'side-block profile-circle' },
          h(
            'h2',
            null,
            org ? link(userRoute(p.login, 'people'), l10n.t('People')) : l10n.t('Organizations'),
          ),
          h(
            'div',
            { class: 'faces' },
            page.circle.map((c) =>
              labeled(link(userRoute(c.login), avatar(c, 'md'), 'face'), c.login),
            ),
          ),
        )
      : null,
  );
}

/** Abas do perfil; seguidores e seguindo abrem pelos contadores da coluna. */
function profileTabs(page: UserPage): HTMLElement {
  const p = page.profile;
  const active = page.body.tab;
  const tabs: readonly { tab: UserTab; icon: IconName; count?: number }[] =
    p.kind === 'Organization'
      ? [
          { tab: 'overview', icon: 'book' },
          { tab: 'repositories', icon: 'repo', ...countOf(page.counts.repositories) },
          { tab: 'people', icon: 'people' },
        ]
      : [
          { tab: 'overview', icon: 'book' },
          { tab: 'repositories', icon: 'repo', ...countOf(page.counts.repositories) },
          { tab: 'stars', icon: 'star', ...countOf(page.counts.stars) },
        ];
  return h(
    'nav',
    { class: 'tabs tabs-sub', attrs: { 'aria-label': l10n.t('Profile sections') } },
    tabs.map((t) =>
      link(
        userRoute(p.login, t.tab),
        [
          icon(t.icon),
          USER_TAB_LABELS[t.tab],
          t.count !== undefined ? h('span', { class: 'count' }, formatCount(t.count)) : null,
        ],
        `tab${t.tab === active ? ' tab-on' : ''}`,
        t.tab === active,
      ),
    ),
  );
}

function countOf(count: number | undefined): { count?: number } {
  return count === undefined ? {} : { count };
}

/** Cartão de repositório fixado ou popular, na grade da visão geral. */
function pinCard(repo: RepoRow, owner: string): HTMLElement {
  const other = repo.owner.toLowerCase() !== owner.toLowerCase();
  const color = repo.languageColor ?? (repo.language ? LANGUAGE_COLORS[repo.language] : undefined);
  return h(
    'li',
    { class: 'pin', ...(color ? { style: { '--lang': color } } : {}) },
    h(
      'div',
      { class: 'pin-head' },
      icon(repo.private ? 'lock' : 'repo'),
      link(
        { view: 'repo', owner: repo.owner, name: repo.name, tab: 'code' },
        other ? [h('span', { class: 'muted' }, `${repo.owner}/`), repo.name] : repo.name,
        'pin-name',
      ),
      h('span', { class: 'tag' }, repo.private ? l10n.t('Private') : l10n.t('Public')),
    ),
    h(
      'p',
      { class: repo.description ? 'pin-desc' : 'pin-desc muted' },
      repo.description ?? l10n.t('No description.'),
    ),
    h(
      'div',
      { class: 'row-meta' },
      repo.language
        ? h(
            'span',
            { class: 'meta-item' },
            langDot(repo.language, repo.languageColor),
            repo.language,
          )
        : null,
      repo.stars > 0
        ? h(
            'span',
            { class: 'meta-item', attrs: { title: starsText(repo.stars, String(repo.stars)) } },
            icon('star'),
            formatCount(repo.stars),
          )
        : null,
      repo.forks > 0
        ? h(
            'span',
            { class: 'meta-item', attrs: { title: forksText(repo.forks, String(repo.forks)) } },
            icon('fork'),
            formatCount(repo.forks),
          )
        : null,
    ),
  );
}

function overviewTab(page: UserPage, body: Extract<UserBody, { tab: 'overview' }>): HTMLElement {
  const p = page.profile;
  const readme = body.readme;
  const allRepos = link(
    userRoute(p.login, 'repositories'),
    l10n.t('See all repositories'),
    'link small',
  );
  return h(
    'div',
    { class: 'col-main' },
    readme
      ? h(
          'article',
          { class: 'readme', attrs: { 'aria-label': l10n.t('README for {0}', p.login) } },
          h(
            'header',
            { class: 'readme-head' },
            icon('book'),
            link(
              { view: 'file', owner: readme.owner, name: readme.name, path: readme.path },
              `${readme.name}/${readme.path}`,
            ),
          ),
          markdown(readme, readme),
        )
      : null,
    body.repos.length > 0
      ? section(
          body.reposKind === 'pinned' ? l10n.t('Pinned') : l10n.t('Popular repositories'),
          undefined,
          h(
            'ul',
            { class: 'pins' },
            body.repos.map((r) => pinCard(r, p.login)),
          ),
          allRepos,
        )
      : null,
    !readme && body.repos.length === 0
      ? empty(
          p.mine
            ? l10n.t(
                'Your profile is still empty. Create a repository named after your login with a README to introduce yourself here.',
              )
            : l10n.t('{0} has no profile README or public repositories yet.', p.login),
        )
      : null,
  );
}

function typeText(): Readonly<Record<RepoType, string>> {
  return {
    all: l10n.t('All repositories'),
    public: l10n.t('Public repositories'),
    private: l10n.t('Private repositories'),
    sources: l10n.t('Source repositories'),
    forks: l10n.t('Forked repositories'),
    archived: l10n.t('Archived repositories'),
  };
}

function sortText(): Readonly<Record<RepoSort, string>> {
  return {
    updated: l10n.t('Last updated'),
    name: l10n.t('Name'),
    stars: l10n.t('Stars'),
  };
}

/**
 * O resumo com o filtro de tipo: "3 repositórios arquivados", "1 repositório
 * que é fork". {0} é o número (em negrito).
 */
function typeWords(type: RepoType, one: boolean): string {
  switch (type) {
    case 'all':
      return one ? l10n.t('{0} repository') : l10n.t('{0} repositories');
    case 'public':
      return one ? l10n.t('{0} public repository') : l10n.t('{0} public repositories');
    case 'private':
      return one ? l10n.t('{0} private repository') : l10n.t('{0} private repositories');
    case 'archived':
      return one ? l10n.t('{0} archived repository') : l10n.t('{0} archived repositories');
    case 'sources':
      return one
        ? l10n.t('{0} repository that is not a fork')
        : l10n.t('{0} repositories that are not forks');
    case 'forks':
      return one
        ? l10n.t('{0} repository that is a fork')
        : l10n.t('{0} repositories that are forks');
  }
}

/** Busca digitada esperando a pausa para ir à extensão. */
let findTimer: ReturnType<typeof setTimeout> | undefined;
/** Chave da rota da última busca mandada: só a tela dela mantém o texto ainda digitado. */
let searchKey: string | undefined;

function cancelSearch(): void {
  clearTimeout(findTimer);
  findTimer = undefined;
}

/**
 * Manda a busca do campo com os filtros da rota atual no momento do envio (não
 * os de quando a tecla foi apertada). Fora da aba Repositórios, não faz nada.
 */
function searchNow(): void {
  cancelSearch();
  const input = document.querySelector<HTMLInputElement>('input[data-focus="find"]');
  if (!input || route.view !== 'user' || route.tab !== 'repositories') return;
  const target = userRoute(route.login, 'repositories', {
    ...repoFilters(route),
    q: input.value,
  });
  searchKey = routeKey(target);
  send({ type: 'navigate', route: target, replace: true });
}

function select<T extends string>(
  name: string,
  title: string,
  value: string,
  options: readonly { readonly value: T | ''; readonly text: string }[],
  onChange: (value: T | '') => void,
): HTMLElement {
  const element = h('select', {
    class: 'select',
    attrs: { 'aria-label': title, 'data-focus': name },
  });
  for (const option of options) {
    const node = h('option', { attrs: { value: option.value } }, option.text);
    node.selected = option.value.toLowerCase() === value.toLowerCase();
    element.append(node);
  }
  element.addEventListener('change', () => {
    onChange(options.find((o) => o.value === element.value)?.value ?? '');
  });
  return h('label', { class: 'filter' }, h('span', { class: 'filter-name' }, title), element);
}

/** "3 repositórios arquivados com “x” em Go": o termo e a linguagem entram se houver. */
function summary(count: Child, q: string, language: string): Child {
  const withQ = q ? fill(l10n.t('{0} matching “{1}”'), count, q) : count;
  return language ? fill(l10n.t('{0} written in {1}'), withQ, language) : withQ;
}

function repositoriesTab(
  page: UserPage,
  body: Extract<UserBody, { tab: 'repositories' }>,
): HTMLElement {
  const p = page.profile;
  const f = body.filters;
  const find = h('input', {
    class: 'search-input',
    attrs: {
      type: 'search',
      placeholder: l10n.t('Find a repository…'),
      'aria-label': l10n.t('Find a repository'),
      spellcheck: 'false',
      'data-focus': 'find',
    },
  });
  find.value = f.q;
  // Filtro trocado com a busca ainda esperando a pausa: os dois vão juntos.
  const to = (change: RepoFilters): Route => {
    cancelSearch();
    return userRoute(p.login, 'repositories', { ...f, q: find.value, ...change });
  };
  find.addEventListener('input', () => {
    cancelSearch();
    findTimer = setTimeout(searchNow, 300);
  });
  const form = h(
    'form',
    { class: 'search filter-find', attrs: { role: 'search' } },
    icon('search'),
    find,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    searchNow();
  });
  // Privados só fazem sentido para quem pode vê-los: a própria conta e organizações.
  const typeNames = typeText();
  const sortNames = sortText();
  const types = (Object.keys(typeNames) as RepoType[]).filter(
    (t) => t !== 'private' || p.mine || p.kind === 'Organization',
  );
  const language = f.language ?? '';
  const languages =
    language && !body.languages.some((l) => l.toLowerCase() === language.toLowerCase())
      ? [language, ...body.languages]
      : body.languages;
  const filtered = f.q !== '' || f.type !== 'all' || language !== '';
  const clear = (): HTMLButtonElement =>
    button(
      l10n.t('Clear filters'),
      () => {
        cancelSearch();
        go(userRoute(p.login, 'repositories', { sort: f.sort }));
      },
      { kind: 'quiet', icon: 'x' },
    );
  return h(
    'div',
    { class: 'col-main repo-results' },
    h(
      'div',
      { class: 'toolbar repo-filters' },
      form,
      select<RepoType>(
        'type',
        l10n.t('Type'),
        f.type,
        types.map((t) => ({ value: t, text: typeNames[t] })),
        (type) => {
          go(to({ type: type || 'all' }));
        },
      ),
      select(
        'language',
        l10n.t('Programming language'),
        language,
        [
          { value: '', text: l10n.t('All languages') },
          ...languages.map((l) => ({ value: l, text: l })),
        ],
        (value) => {
          go(to({ language: value }));
        },
      ),
      select<RepoSort>(
        'sort',
        l10n.t('Sort'),
        f.sort,
        (Object.keys(sortNames) as RepoSort[]).map((s) => ({ value: s, text: sortNames[s] })),
        (sort) => {
          go(to({ sort: sort || 'updated' }));
        },
      ),
    ),
    filtered
      ? h(
          'div',
          { class: 'filter-summary' },
          h(
            'p',
            { attrs: { role: 'status' } },
            summary(
              fill(
                typeWords(f.type, body.total === 1),
                h('span', { class: 'strong' }, formatCount(body.total)),
              ),
              f.q,
              language,
            ),
          ),
          clear(),
        )
      : null,
    body.total === 0
      ? empty(
          filtered
            ? l10n.t('No repositories match these filters. Try another term or clear the filters.')
            : p.mine
              ? l10n.t('You have no repositories yet.')
              : l10n.t('{0} has no repositories visible to you.', p.login),
          filtered ? clear() : undefined,
        )
      : paged(
          h(
            'ul',
            { class: 'rows' },
            body.repos.map((r) => repoCard(r, { owner: false, visibility: true })),
          ),
          body.hasMore,
          (rows) =>
            rows.kind === 'repos'
              ? rows.repos.map((r) => repoCard(r, { owner: false, visibility: true }))
              : [],
          githubUrl(route),
        ),
    body.truncated
      ? h(
          'p',
          { class: 'muted small' },
          fill(
            l10n.t(
              'Search and filters apply to the most recent repositories the panel loaded. {0}',
            ),
            external(githubUrl(route), l10n.t('See the full list on GitHub')),
          ),
        )
      : null,
  );
}

function personRow(person: Person): HTMLElement {
  return h(
    'li',
    { class: 'row person-row' },
    avatar(person, 'md'),
    h('div', { class: 'row-main' }, link(userRoute(person.login), person.login, 'row-link')),
  );
}

function peopleTab(
  page: UserPage,
  body: Extract<UserBody, { tab: 'followers' | 'following' | 'people' }>,
): HTMLElement {
  const login = page.profile.login;
  const text = {
    followers: l10n.t('{0} has no followers yet.', login),
    following: l10n.t('{0} is not following anyone yet.', login),
    people: l10n.t('No members of this organization are visible to you.'),
  }[body.tab];
  return h(
    'div',
    { class: 'col-main' },
    body.tab === 'people' ? null : h('h2', { class: 'tab-title' }, USER_TAB_LABELS[body.tab]),
    body.people.length === 0 && !body.hasMore
      ? empty(text)
      : paged(
          h('ul', { class: 'rows' }, body.people.map(personRow)),
          body.hasMore,
          (rows) => moreRows(rows),
          githubUrl(route),
        ),
  );
}

function userPage(page: UserPage): HTMLElement {
  const body = page.body;
  let content: HTMLElement;
  switch (body.tab) {
    case 'overview':
      content = overviewTab(page, body);
      break;
    case 'repositories':
      content = repositoriesTab(page, body);
      break;
    case 'stars':
      content = h(
        'div',
        { class: 'col-main' },
        body.repos.length === 0 && !body.hasMore
          ? empty(
              page.profile.mine
                ? l10n.t('You have not starred any repositories yet.')
                : l10n.t('{0} has not starred any repositories yet.', page.profile.login),
            )
          : paged(
              h(
                'ul',
                { class: 'rows' },
                body.repos.map((r) => repoCard(r)),
              ),
              body.hasMore,
              (rows) => moreRows(rows),
              githubUrl(route),
            ),
      );
      break;
    case 'followers':
    case 'following':
    case 'people':
      content = peopleTab(page, body);
      break;
  }
  return h(
    'div',
    { class: 'wrap profile' },
    profileSide(page),
    h('div', { class: 'profile-main' }, profileTabs(page), content),
  );
}

function repoTabs(): readonly { tab: RepoTab; label: string; icon: IconName }[] {
  return [
    { tab: 'code', label: l10n.t('Code'), icon: 'code' },
    { tab: 'issues', label: l10n.t('Issues'), icon: 'issue' },
    { tab: 'pulls', label: l10n.t('Pull requests'), icon: 'pr' },
    { tab: 'actions', label: l10n.t('Actions'), icon: 'play' },
    { tab: 'releases', label: l10n.t('Releases'), icon: 'tag' },
  ];
}

function repoHead(repo: RepoHeader, active: RepoTab | undefined): HTMLElement {
  const base = { owner: repo.owner, name: repo.name };
  return h(
    'div',
    { class: 'repo-head' },
    h(
      'div',
      { class: 'repo-title-row' },
      h(
        'h1',
        { class: 'repo-title' },
        icon(repo.private ? 'lock' : 'repo'),
        link({ view: 'user', login: repo.owner }, repo.owner, 'repo-owner'),
        h('span', { class: 'repo-slash', attrs: { 'aria-hidden': 'true' } }, '/'),
        link({ view: 'repo', ...base, tab: 'code' }, repo.name, 'repo-name'),
        h('span', { class: 'tag' }, repo.private ? l10n.t('Private') : l10n.t('Public')),
        repo.archived ? h('span', { class: 'tag tag-warn' }, l10n.t('Archived')) : null,
      ),
      h(
        'div',
        { class: 'repo-stats' },
        h(
          'span',
          { class: 'stat', attrs: { title: starsText(repo.stars, String(repo.stars)) } },
          icon('star'),
          formatCount(repo.stars),
        ),
        h(
          'span',
          { class: 'stat', attrs: { title: forksText(repo.forks, String(repo.forks)) } },
          icon('fork'),
          formatCount(repo.forks),
        ),
        button(
          l10n.t('Clone'),
          () => {
            send({ type: 'action', action: 'clone' });
          },
          { icon: 'clone', kind: 'quiet' },
        ),
      ),
    ),
    h(
      'nav',
      { class: 'tabs', attrs: { 'aria-label': l10n.t('Repository sections') } },
      repoTabs().map((t) =>
        h(
          'a',
          {
            class: `tab${t.tab === active ? ' tab-on' : ''}`,
            attrs: {
              href: githubUrl({ view: 'repo', ...base, tab: t.tab }),
              ...(t.tab === active ? { 'aria-current': 'page' } : {}),
            },
            onClick: (event) => {
              event.preventDefault();
              go({ view: 'repo', ...base, tab: t.tab });
            },
          },
          icon(t.icon),
          t.label,
          t.tab === 'issues' && repo.openIssues > 0
            ? h('span', { class: 'count' }, formatCount(repo.openIssues))
            : null,
        ),
      ),
    ),
  );
}

function entryIcon(entry: EntryView): IconName {
  return entry.type === 'dir' ? 'folder' : entry.type === 'submodule' ? 'submodule' : 'file';
}

function codeTab(
  repo: RepoHeader,
  body: Extract<Extract<Page, { view: 'repo' }>['body'], { tab: 'code' }>,
): HTMLElement {
  const base = { owner: repo.owner, name: repo.name };
  const ref = body.ref === repo.defaultBranch ? {} : { ref: body.ref };
  const branchSelect = h('select', { class: 'select', attrs: { 'aria-label': l10n.t('Branch') } });
  const branches = body.branches.includes(body.ref) ? body.branches : [body.ref, ...body.branches];
  for (const name of branches) {
    const option = h('option', { attrs: { value: name } }, name);
    option.selected = name === body.ref;
    branchSelect.append(option);
  }
  branchSelect.addEventListener('change', () => {
    go({
      view: 'repo',
      ...base,
      tab: 'code',
      ref: branchSelect.value,
      ...(body.path ? { path: body.path } : {}),
    });
  });
  const parent = body.path.includes('/') ? body.path.slice(0, body.path.lastIndexOf('/')) : '';
  const files = h(
    'div',
    { class: 'files' },
    body.lastCommit
      ? h(
          'div',
          { class: 'files-head' },
          avatar(
            body.lastCommit.author
              ? {
                  login: body.lastCommit.author,
                  ...(body.lastCommit.avatar ? { avatar: body.lastCommit.avatar } : {}),
                }
              : undefined,
          ),
          h('span', { class: 'strong' }, body.lastCommit.author ?? ''),
          h(
            'span',
            { class: 'files-msg', attrs: { title: body.lastCommit.message } },
            body.lastCommit.message,
          ),
          mono(body.lastCommit.sha.slice(0, 7), 'mono sha'),
          time(body.lastCommit.date),
        )
      : null,
    h(
      'ul',
      { class: 'file-list' },
      body.path
        ? h(
            'li',
            { class: 'file-row' },
            icon('folder'),
            link(
              { view: 'repo', ...base, tab: 'code', ...ref, ...(parent ? { path: parent } : {}) },
              '..',
              'file-link',
            ),
          )
        : null,
      body.entries.map((entry) =>
        h(
          'li',
          { class: 'file-row' },
          icon(entryIcon(entry), `icon icon-${entry.type}`),
          entry.type === 'submodule'
            ? h('span', { class: 'file-link muted' }, entry.name)
            : link(
                entry.type === 'dir'
                  ? { view: 'repo', ...base, tab: 'code', ...ref, path: entry.path }
                  : { view: 'file', ...base, ...ref, path: entry.path },
                entry.name,
                'file-link',
              ),
          entry.type === 'file' ? h('span', { class: 'file-size' }, formatBytes(entry.size)) : null,
        ),
      ),
    ),
  );
  const readme = body.readme
    ? h(
        'article',
        { class: 'readme', attrs: { 'aria-label': body.readme.path } },
        h(
          'header',
          { class: 'readme-head' },
          icon('book'),
          link(
            { view: 'file', ...base, ...ref, path: body.readme.path },
            body.readme.path.split('/').pop() ?? 'README',
          ),
        ),
        markdown(body.readme, base),
      )
    : body.path
      ? null
      : empty(
          l10n.t('This repository has no README.'),
          button(
            l10n.t('Open on GitHub'),
            () => {
              send({ type: 'external', url: repo.url });
            },
            { kind: 'quiet', icon: 'external' },
          ),
        );
  const main = h(
    'div',
    { class: 'col-main' },
    h(
      'div',
      { class: 'toolbar' },
      h('label', { class: 'branch' }, icon('branch'), branchSelect),
      body.path ? h('span', { class: 'mono path' }, `/${body.path}`) : null,
    ),
    files,
    readme,
  );
  if (body.path) return h('div', { class: 'columns single' }, main);
  return h('div', { class: 'columns' }, main, repoAside(repo, body));
}

function repoAside(
  repo: RepoHeader,
  body: Extract<Extract<Page, { view: 'repo' }>['body'], { tab: 'code' }>,
): HTMLElement {
  return h(
    'aside',
    { class: 'col-side' },
    h(
      'section',
      { class: 'side-block' },
      h('h2', null, l10n.t('About')),
      h(
        'p',
        { class: repo.description ? 'about' : 'about muted' },
        repo.description ?? l10n.t('No description.'),
      ),
      repo.homepage
        ? h(
            'p',
            { class: 'about-link' },
            icon('linkIcon'),
            external(
              repo.homepage.replace(/^http:/, 'https:'),
              repo.homepage.replace(/^https?:\/\//, ''),
            ),
          )
        : null,
      repo.topics.length > 0
        ? h(
            'div',
            { class: 'topics' },
            repo.topics.map((t) => h('span', { class: 'topic' }, t)),
          )
        : null,
      h(
        'ul',
        { class: 'facts' },
        repo.license ? h('li', null, icon('book'), repo.license) : null,
        h('li', null, icon('star'), starsText(repo.stars, formatCount(repo.stars))),
        h('li', null, icon('fork'), forksText(repo.forks, formatCount(repo.forks))),
        h('li', null, icon('branch'), fill(l10n.t('default branch {0}'), mono(repo.defaultBranch))),
      ),
    ),
    body.languages.length > 0
      ? h(
          'section',
          { class: 'side-block' },
          h('h2', null, l10n.t('Languages')),
          h(
            'div',
            {
              class: 'lang-bar',
              attrs: {
                role: 'img',
                'aria-label': body.languages
                  .map((l) => `${l.name} ${String(l.percent)}%`)
                  .join(', '),
              },
            },
            body.languages.map((l) =>
              h('span', {
                class: 'lang-seg',
                style: {
                  width: `${String(l.percent)}%`,
                  ...(LANGUAGE_COLORS[l.name] ? { '--lang': LANGUAGE_COLORS[l.name] ?? '' } : {}),
                },
              }),
            ),
          ),
          h(
            'ul',
            { class: 'lang-legend' },
            body.languages.map((l) =>
              h(
                'li',
                null,
                langDot(l.name),
                h('span', { class: 'strong' }, l.name),
                ` ${currentLocale() === 'pt-br' ? String(l.percent).replace('.', ',') : String(l.percent)}%`,
              ),
            ),
          ),
        )
      : null,
    body.releases.length > 0
      ? h(
          'section',
          { class: 'side-block' },
          h(
            'h2',
            null,
            link({ view: 'repo', owner: repo.owner, name: repo.name, tab: 'releases' }, 'Releases'),
          ),
          h(
            'ul',
            { class: 'facts' },
            body.releases.map((r) =>
              h(
                'li',
                null,
                icon('tag'),
                h('span', { class: 'strong' }, r.name),
                ' ',
                time(r.publishedAt),
              ),
            ),
          ),
        )
      : null,
    body.contributors.length > 0
      ? h(
          'section',
          { class: 'side-block' },
          h('h2', null, l10n.t('Contributors')),
          h(
            'div',
            { class: 'faces' },
            body.contributors.map((c) =>
              link({ view: 'user', login: c.login }, avatar(c, 'md'), 'face'),
            ),
          ),
        )
      : null,
  );
}

function listTab(
  repo: RepoHeader,
  body: Extract<Extract<Page, { view: 'repo' }>['body'], { tab: 'issues' | 'pulls' }>,
): HTMLElement {
  const base = { view: 'repo' as const, owner: repo.owner, name: repo.name, tab: body.tab };
  return h(
    'div',
    { class: 'col-main' },
    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'segmented', attrs: { role: 'group', 'aria-label': l10n.t('State') } },
        (['open', 'closed'] as const).map((state) => {
          const on = body.state === state;
          return h(
            'button',
            {
              class: `seg${on ? ' seg-on' : ''}`,
              attrs: { type: 'button', 'aria-pressed': String(on) },
              onClick: () => {
                go({ ...base, state });
              },
            },
            icon(state === 'open' ? (body.tab === 'issues' ? 'issue' : 'pr') : 'check'),
            body.tab === 'issues'
              ? state === 'open'
                ? l10n.t('Open issues')
                : l10n.t('Closed issues')
              : state === 'open'
                ? l10n.t('Open pull requests')
                : l10n.t('Closed pull requests'),
          );
        }),
      ),
      body.tab === 'issues'
        ? button(
            l10n.t('New issue'),
            () => {
              send({ type: 'action', action: 'newIssue' });
            },
            { kind: 'primary', icon: 'plus' },
          )
        : null,
    ),
    body.items.length === 0 && !body.hasMore
      ? empty(
          body.tab === 'issues'
            ? body.state === 'open'
              ? l10n.t('No open issues.')
              : l10n.t('No recently closed issues.')
            : body.state === 'open'
              ? l10n.t('No open pull requests.')
              : l10n.t('No recently closed pull requests.'),
        )
      : paged(
          h(
            'ul',
            { class: 'rows' },
            body.items.map((item) => itemRow(item, false)),
          ),
          body.hasMore,
          (rows) => moreRows(rows),
          githubUrl(route),
        ),
  );
}

/** Repositório sem commits: o convite é o primeiro push. */
function emptyRepo(repo: RepoHeader, cloneUrl: string): HTMLElement {
  const commands = [
    `git clone ${cloneUrl}`,
    `cd ${repo.name}`,
    `git commit --allow-empty -m "${l10n.t('First commit')}"`,
    'git push -u origin HEAD',
  ].join('\n');
  return h(
    'div',
    { class: 'empty-repo' },
    icon('repo', 'icon icon-hero'),
    h('h2', null, l10n.t('Empty repository')),
    h(
      'p',
      { class: 'muted' },
      l10n.t(
        'There are no commits here yet. Clone, make the first commit and push; the code shows up in this tab.',
      ),
    ),
    h(
      'pre',
      { class: 'commands', attrs: { 'aria-label': l10n.t('Commands to get started') } },
      commands,
    ),
    h(
      'div',
      { class: 'actions' },
      button(
        l10n.t('Clone'),
        () => {
          send({ type: 'action', action: 'clone' });
        },
        { kind: 'primary', icon: 'clone' },
      ),
      button(
        l10n.t('Open on GitHub'),
        () => {
          send({ type: 'external', url: repo.url });
        },
        { kind: 'quiet', icon: 'external' },
      ),
    ),
  );
}

function releaseView(release: ReleaseView, repo: RepoHeader): HTMLElement {
  return h(
    'article',
    { class: 'release' },
    h(
      'header',
      { class: 'release-head' },
      h('h2', null, release.name),
      mono(release.tag, 'mono tag-name'),
      release.prerelease ? h('span', { class: 'tag tag-warn' }, l10n.t('Pre-release')) : null,
      release.draft ? h('span', { class: 'tag' }, l10n.t('Draft')) : null,
      h(
        'span',
        { class: 'muted' },
        release.author
          ? fill(l10n.t('{0} published {1}'), userLink(release.author), time(release.publishedAt))
          : fill(l10n.t('published {0}'), time(release.publishedAt)),
      ),
      external(release.url, l10n.t('Open on GitHub'), 'link small push'),
    ),
    release.body ? markdown({ markdown: release.body, dir: '', ref: release.tag }, repo) : null,
  );
}

function repoPage(page: Extract<Page, { view: 'repo' }>): HTMLElement {
  const { repo, body } = page;
  let content: HTMLElement;
  switch (body.tab) {
    case 'code':
      content = codeTab(repo, body);
      break;
    case 'issues':
    case 'pulls':
      content = listTab(repo, body);
      break;
    case 'actions':
      content = h(
        'div',
        { class: 'col-main' },
        body.runs.length === 0 && !body.hasMore
          ? empty(l10n.t('No Actions runs in this repository.'))
          : paged(
              h(
                'ul',
                { class: 'rows' },
                body.runs.map((r) => runRowView(r, false)),
              ),
              body.hasMore,
              (rows) => moreRows(rows),
              githubUrl(route),
            ),
      );
      break;
    case 'releases':
      content = h(
        'div',
        { class: 'col-main' },
        body.releases.length === 0 && !body.hasMore
          ? empty(l10n.t('No published releases.'))
          : paged(
              h(
                'div',
                null,
                body.releases.map((r) => releaseView(r, repo)),
              ),
              body.hasMore,
              (rows) => moreRows(rows, repo),
              githubUrl(route),
            ),
      );
      break;
    case 'empty':
      content = emptyRepo(repo, body.cloneUrl);
      break;
  }
  return h(
    'div',
    { class: 'wrap' },
    repoHead(repo, body.tab === 'empty' ? 'code' : body.tab),
    content,
  );
}

function filePage(page: Extract<Page, { view: 'file' }>): HTMLElement {
  const base = { owner: page.repo.owner, name: page.repo.name };
  const name = page.path.split('/').pop() ?? page.path;
  let body: HTMLElement;
  switch (page.body.kind) {
    case 'markdown':
      body = h('div', { class: 'file-body file-md' }, markdown(page.body.doc, base));
      break;
    case 'code': {
      const lines = page.body.text.replace(/\n$/, '').split('\n').length;
      const code = h('code', { class: 'code' });
      // `highlight` devolve HTML já escapado, só com spans `tok-*`.
      code.innerHTML = highlight(page.body.text.replace(/\n$/, ''), page.body.lang);
      body = h(
        'div',
        {
          class: 'file-body file-code',
          attrs: { tabindex: '0', 'aria-label': l10n.t('Contents of {0}', name) },
        },
        h(
          'pre',
          { class: 'gutter', attrs: { 'aria-hidden': 'true' } },
          Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n'),
        ),
        h('pre', { class: 'lines' }, code),
      );
      break;
    }
    case 'image':
      body = h(
        'div',
        { class: 'file-body file-image' },
        h('img', { attrs: { src: page.body.src, alt: name, referrerpolicy: 'no-referrer' } }),
      );
      break;
    case 'binary':
    case 'large':
      body = h(
        'div',
        { class: 'file-body' },
        empty(
          page.body.kind === 'large'
            ? l10n.t('File too large to show here ({0}).', formatBytes(page.size))
            : l10n.t('Binary file: the panel does not show its contents.'),
          button(
            l10n.t('Open on GitHub'),
            () => {
              send({
                type: 'external',
                url: githubUrl({ view: 'file', ...base, ref: page.ref, path: page.path }),
              });
            },
            { kind: 'quiet', icon: 'external' },
          ),
        ),
      );
      break;
  }
  return h(
    'div',
    { class: 'wrap' },
    repoHead(page.repo, 'code'),
    h(
      'div',
      { class: 'file' },
      h(
        'header',
        { class: 'file-head' },
        icon('file'),
        h('span', { class: 'strong mono' }, name),
        h('span', { class: 'muted' }, formatBytes(page.size)),
        mono(page.ref, 'mono branch'),
        h(
          'div',
          { class: 'push actions' },
          page.body.kind === 'code' || page.body.kind === 'markdown'
            ? button(
                page.local ? l10n.t('Open in editor') : l10n.t('Open in editor (read-only)'),
                () => {
                  send({ type: 'action', action: 'openInEditor' });
                },
                {
                  icon: 'editor',
                  kind: 'quiet',
                  title: page.local
                    ? l10n.t('Opens the local copy from the workspace')
                    : l10n.t('Opens this version in a read-only tab'),
                },
              )
            : null,
        ),
      ),
      body,
    ),
  );
}

/** "fulano aprovou há 2 h": a revisão com quem e quando, na ordem de cada idioma. */
function reviewLine(review: string | undefined, who: Child, when: Child): Child[] {
  switch (review) {
    case 'APPROVED':
      return fill(l10n.t('{0} approved {1}'), who, when);
    case 'CHANGES_REQUESTED':
      return fill(l10n.t('{0} requested changes {1}'), who, when);
    case 'COMMENTED':
      return fill(l10n.t('{0} reviewed {1}'), who, when);
    case 'DISMISSED':
      return fill(l10n.t('{0} had their review dismissed {1}'), who, when);
    case undefined:
      return [who, '  ', when];
    default:
      // Estado novo da API: mostra como veio.
      return [who, ` ${review.toLowerCase()} `, when];
  }
}

function timelineView(entries: readonly TimelineEntry[], repo: RepoHeader): HTMLElement[] {
  return entries.map((entry) => {
    const cls =
      entry.review === 'APPROVED'
        ? ' event-ok'
        : entry.review === 'CHANGES_REQUESTED'
          ? ' event-bad'
          : '';
    if (entry.kind === 'review' && !entry.body) {
      return h(
        'li',
        { class: `event${cls}` },
        h(
          'span',
          { class: 'event-mark' },
          icon(
            entry.review === 'APPROVED'
              ? 'check'
              : entry.review === 'CHANGES_REQUESTED'
                ? 'x'
                : 'comment',
          ),
        ),
        h(
          'p',
          { class: 'event-text' },
          reviewLine(entry.review, userLink(entry.author?.login), time(entry.date)),
        ),
      );
    }
    return h(
      'li',
      { class: `comment${cls}` },
      h('span', { class: 'comment-avatar' }, avatar(entry.author, 'md')),
      h(
        'div',
        { class: 'comment-box' },
        h(
          'header',
          { class: 'comment-head' },
          entry.review
            ? reviewLine(entry.review, userLink(entry.author?.login), time(entry.date))
            : fill(l10n.t('{0} commented {1}'), userLink(entry.author?.login), time(entry.date)),
        ),
        markdown({ markdown: entry.body, dir: '', ref: repo.defaultBranch }, repo),
      ),
    );
  });
}

/** Comentários enviados esperando a resposta da extensão, pelo id. */
const pendingComments = new Map<string, (ok: boolean, error?: string) => void>();
let commentSeq = 0;

function composer(number: number): HTMLElement {
  const key = routeKey(route);
  const input = h('textarea', {
    class: 'composer-input',
    attrs: {
      rows: '4',
      placeholder: l10n.t('Write in Markdown'),
      'aria-label': l10n.t('Comment on #{0}', String(number)),
      'aria-describedby': `composer-msg-${String(number)}`,
    },
  });
  const note = h('span', {
    class: 'muted small composer-msg',
    attrs: { id: `composer-msg-${String(number)}`, 'aria-live': 'polite' },
  });
  const hint = (): void => {
    const over = input.value.length - COMMENT_LIMIT;
    note.classList.toggle('composer-error', over > 0);
    note.textContent =
      over > 0
        ? over === 1
          ? l10n.t('1 character over the GitHub limit (65,536). Shorten it to send.')
          : l10n.t(
              '{0} characters over the GitHub limit (65,536). Shorten it to send.',
              String(over),
            )
        : l10n.t('Ctrl+Enter to send');
    submit.disabled = over > 0;
  };
  const submit = button(
    l10n.t('Comment'),
    () => {
      const body = input.value.trim();
      if (!body) {
        input.focus();
        return;
      }
      if (input.value.length > COMMENT_LIMIT) {
        hint();
        return;
      }
      const id = `c${String(++commentSeq)}`;
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      note.classList.remove('composer-error');
      note.textContent = l10n.t('Sending…');
      pendingComments.set(id, (ok, error) => {
        submit.removeAttribute('aria-busy');
        if (ok) {
          input.value = '';
          hint();
          return;
        }
        // O texto fica onde estava, para tentar de novo.
        submit.disabled = false;
        note.classList.add('composer-error');
        note.textContent = error ?? l10n.t('The comment was not sent. Try again.');
        input.focus();
      });
      send({ type: 'comment', id, key, number, body });
    },
    { kind: 'primary', icon: 'comment' },
  );
  input.addEventListener('input', hint);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit.click();
  });
  hint();
  return h('div', { class: 'composer' }, input, h('div', { class: 'composer-foot' }, note, submit));
}

function sideLabels(labels: readonly LabelView[]): HTMLElement {
  return h(
    'section',
    { class: 'side-block' },
    h('h2', null, l10n.t('Labels')),
    labels.length === 0
      ? h('p', { class: 'muted' }, l10n.t('None yet'))
      : h('div', { class: 'labels' }, labels.map(label)),
  );
}

function diffstat(additions: number, deletions: number): HTMLElement {
  const total = additions + deletions;
  const green = total === 0 ? 0 : Math.round((additions / total) * 5);
  return h(
    'span',
    { class: 'diffstat', attrs: { title: `+${String(additions)} −${String(deletions)}` } },
    h('span', { class: 'add' }, `+${String(additions)}`),
    h('span', { class: 'del' }, `−${String(deletions)}`),
    h(
      'span',
      { class: 'blocks', attrs: { 'aria-hidden': 'true' } },
      Array.from({ length: 5 }, (_, i) =>
        h('span', { class: total === 0 ? 'b' : i < green ? 'b b-add' : 'b b-del' }),
      ),
    ),
  );
}

function fileRow(file: PullFileView): HTMLElement {
  return h(
    'li',
    { class: 'row file-change' },
    h(
      'span',
      { class: `change change-${file.status}`, attrs: { title: file.status } },
      file.status.slice(0, 1).toUpperCase(),
    ),
    h(
      'button',
      {
        class: 'row-link as-link mono',
        attrs: { type: 'button', title: l10n.t('Open the diff in the editor') },
        onClick: () => {
          send({ type: 'openDiff', filename: file.filename });
        },
      },
      file.previous ? `${file.previous} → ${file.filename}` : file.filename,
    ),
    h('span', { class: 'row-side' }, diffstat(file.additions, file.deletions)),
  );
}

function checkRow(check: CheckView): HTMLElement {
  return h(
    'li',
    { class: 'row' },
    h('span', { class: 'row-icon' }, runBadge(check.state)),
    h(
      'div',
      { class: 'row-main' },
      h(
        'div',
        { class: 'row-title' },
        check.url ? external(check.url, check.name, 'row-link') : h('span', null, check.name),
      ),
      h(
        'div',
        { class: 'row-meta' },
        check.app ?? '',
        check.app ? ' · ' : '',
        runText(check.state),
      ),
    ),
  );
}

function checksSummary(checks: readonly CheckView[]): Child {
  if (checks.length === 0) return h('p', { class: 'muted' }, l10n.t('No checks on this commit.'));
  const count = (state: RunState): number => checks.filter((c) => c.state === state).length;
  const failed = count('failure');
  const running = count('running') + count('queued');
  const passed = count('success');
  const parts = [
    failed === 0 ? '' : failed === 1 ? l10n.t('1 failed') : l10n.t('{0} failures', String(failed)),
    running === 0
      ? ''
      : running === 1
        ? l10n.t('1 running')
        : l10n.t('{0} running', String(running)),
    passed === 0 ? '' : passed === 1 ? l10n.t('1 passed') : l10n.t('{0} passed', String(passed)),
  ].filter(Boolean);
  const worst: RunState =
    count('failure') > 0
      ? 'failure'
      : count('running') + count('queued') > 0
        ? 'running'
        : 'success';
  return h('p', { class: 'checks-sum' }, runBadge(worst), parts.join(', '));
}

function pullPage(page: Extract<Page, { view: 'pull' }>): HTMLElement {
  const base = {
    view: 'pull' as const,
    owner: page.repo.owner,
    name: page.repo.name,
    number: page.number,
  };
  const open = page.state === 'open' || page.state === 'draft';
  const tabs = h(
    'nav',
    { class: 'tabs tabs-sub', attrs: { 'aria-label': l10n.t('Pull request sections') } },
    (
      [
        ['conversation', l10n.t('Conversation'), 'comment', page.timeline.length],
        ['files', l10n.t('Files changed'), 'file', page.changedFiles],
        ['checks', l10n.t('Checks'), 'check', page.checks.length],
      ] as const
    ).map(([tab, text, ic, count]) =>
      h(
        'a',
        {
          class: `tab${page.tab === tab ? ' tab-on' : ''}`,
          attrs: {
            href: githubUrl({ ...base, tab }),
            ...(page.tab === tab ? { 'aria-current': 'page' } : {}),
          },
          onClick: (event) => {
            event.preventDefault();
            go({ ...base, tab });
          },
        },
        icon(ic),
        text,
        h('span', { class: 'count' }, String(count)),
      ),
    ),
  );
  let content: HTMLElement;
  switch (page.tab) {
    case 'conversation':
      content = h(
        'ol',
        { class: `thread thread-${page.state}` },
        h(
          'li',
          { class: 'comment comment-first' },
          h('span', { class: 'comment-avatar' }, avatar(page.author, 'md')),
          h(
            'div',
            { class: 'comment-box' },
            h(
              'header',
              { class: 'comment-head' },
              fill(l10n.t('{0} opened {1}'), userLink(page.author?.login), time(page.createdAt)),
            ),
            markdown(page.body, page.repo),
          ),
        ),
        timelineView(page.timeline, page.repo),
        h('li', { class: 'thread-end' }, composer(page.number)),
      );
      break;
    case 'files':
      content =
        page.files.length === 0
          ? empty(l10n.t('No files changed.'))
          : h(
              'div',
              null,
              h(
                'p',
                { class: 'muted small' },
                l10n.t('Click a file to open the diff in the editor, with review comments.'),
              ),
              h('ul', { class: 'rows' }, page.files.map(fileRow)),
            );
      break;
    case 'checks':
      content =
        page.checks.length === 0
          ? empty(l10n.t('No checks on this commit.'))
          : h('ul', { class: 'rows' }, page.checks.map(checkRow));
      break;
  }
  return h(
    'div',
    { class: 'wrap' },
    repoHead(page.repo, 'pulls'),
    h(
      'div',
      { class: `item-head rail-${page.state}` },
      h(
        'h1',
        { class: 'item-title' },
        page.title,
        h('span', { class: 'item-number' }, ` #${String(page.number)}`),
      ),
      h(
        'div',
        { class: 'item-meta' },
        statePill('pr', page.state),
        h(
          'span',
          null,
          fill(
            page.state === 'merged'
              ? l10n.t('{0} merged {1} into {2}')
              : l10n.t('{0} wants to merge {1} into {2}'),
            userLink(page.author?.login),
            mono(page.head, 'mono branch'),
            mono(page.base, 'mono branch'),
          ),
        ),
        diffstat(page.additions, page.deletions),
      ),
      h(
        'div',
        { class: 'item-actions' },
        open
          ? [
              button(
                l10n.t('Review'),
                () => {
                  send({ type: 'action', action: 'review' });
                },
                { icon: 'check', kind: 'primary' },
              ),
              button(
                l10n.t('Merge PR'),
                () => {
                  send({ type: 'action', action: 'merge' });
                },
                {
                  icon: 'merged',
                  title:
                    page.mergeable === false
                      ? l10n.t('GitHub reports a conflict or block on this PR')
                      : l10n.t('Pick the method and confirm first'),
                },
              ),
            ]
          : null,
        button(
          l10n.t('Checkout'),
          () => {
            send({ type: 'action', action: 'checkout' });
          },
          { icon: 'branch', kind: 'quiet', title: l10n.t('Brings the PR into a local branch') },
        ),
        button(
          l10n.t('Open on GitHub'),
          () => {
            send({ type: 'external', url: page.url });
          },
          { icon: 'external', kind: 'quiet' },
        ),
      ),
    ),
    tabs,
    h(
      'div',
      { class: 'columns' },
      h('div', { class: 'col-main' }, content),
      h(
        'aside',
        { class: 'col-side' },
        h(
          'section',
          { class: 'side-block' },
          h('h2', null, l10n.t('Checks')),
          checksSummary(page.checks),
        ),
        sideLabels(page.labels),
        h(
          'section',
          { class: 'side-block' },
          h('h2', null, l10n.t('Changes')),
          h(
            'p',
            null,
            page.changedFiles === 1
              ? l10n.t('1 file')
              : l10n.t('{0} files', String(page.changedFiles)),
          ),
          diffstat(page.additions, page.deletions),
          page.mergeable === false
            ? h(
                'p',
                { class: 'warn' },
                icon('warning'),
                l10n.t('There is a conflict or block preventing the merge.'),
              )
            : null,
        ),
      ),
    ),
  );
}

function issuePage(page: Extract<Page, { view: 'issue' }>): HTMLElement {
  return h(
    'div',
    { class: 'wrap' },
    repoHead(page.repo, 'issues'),
    h(
      'div',
      { class: `item-head rail-${page.state}` },
      h(
        'h1',
        { class: 'item-title' },
        page.title,
        h('span', { class: 'item-number' }, ` #${String(page.number)}`),
      ),
      h(
        'div',
        { class: 'item-meta' },
        statePill('issue', page.state),
        h(
          'span',
          null,
          fill(
            l10n.t('{0} opened · {1}'),
            userLink(page.author?.login),
            commentsText(page.timeline.length),
          ),
        ),
      ),
      h(
        'div',
        { class: 'item-actions' },
        page.state === 'open'
          ? button(
              l10n.t('Send to agents'),
              () => {
                send({ type: 'action', action: 'toAgents' });
              },
              {
                icon: 'rocket',
                kind: 'primary',
                title: l10n.t('Creates a task from this issue and the maestro starts'),
              },
            )
          : null,
        button(
          l10n.t('Open on GitHub'),
          () => {
            send({ type: 'external', url: page.url });
          },
          { icon: 'external', kind: 'quiet' },
        ),
      ),
    ),
    h(
      'div',
      { class: 'columns' },
      h(
        'div',
        { class: 'col-main' },
        h(
          'ol',
          { class: `thread thread-${page.state}` },
          h(
            'li',
            { class: 'comment comment-first' },
            h('span', { class: 'comment-avatar' }, avatar(page.author, 'md')),
            h(
              'div',
              { class: 'comment-box' },
              h(
                'header',
                { class: 'comment-head' },
                fill(l10n.t('{0} opened {1}'), userLink(page.author?.login), time(page.createdAt)),
              ),
              markdown(page.body, page.repo),
            ),
          ),
          timelineView(page.timeline, page.repo),
          h('li', { class: 'thread-end' }, composer(page.number)),
        ),
      ),
      h('aside', { class: 'col-side' }, sideLabels(page.labels)),
    ),
  );
}

function runPage(page: Extract<Page, { view: 'run' }>): HTMLElement {
  const { run } = page;
  const done = run.state !== 'running' && run.state !== 'queued';
  return h(
    'div',
    { class: 'wrap' },
    repoHead(page.repo, 'actions'),
    h(
      'div',
      { class: `item-head rail-run-${run.state}` },
      h('h1', { class: 'item-title' }, run.title),
      h(
        'div',
        { class: 'item-meta' },
        h(
          'span',
          { class: `pill pill-run-${run.state}` },
          icon(runIcon(run.state)),
          runText(run.state),
        ),
        h(
          'span',
          null,
          h('span', { class: 'strong' }, run.workflow),
          ` #${String(run.number)} · ${run.event}`,
          run.branch ? [' ', fill(l10n.t('on {0}'), mono(run.branch, 'mono branch'))] : null,
          ' · ',
          mono(run.sha.slice(0, 7), 'mono sha'),
          ' · ',
          time(run.createdAt),
        ),
      ),
      h(
        'div',
        { class: 'item-actions' },
        done
          ? button(
              run.state === 'failure' ? l10n.t('Re-run failed jobs') : l10n.t('Re-run all jobs'),
              () => {
                send({ type: 'action', action: 'rerun' });
              },
              { icon: 'rerun', kind: 'primary' },
            )
          : null,
        button(
          l10n.t('Open on GitHub'),
          () => {
            send({ type: 'external', url: run.url });
          },
          { icon: 'external', kind: 'quiet' },
        ),
      ),
    ),
    section(
      l10n.t('Jobs'),
      page.jobs.length,
      page.jobs.length === 0
        ? empty(l10n.t('No jobs yet. The run may be queued.'))
        : h(
            'ul',
            { class: 'rows' },
            page.jobs.map((job) =>
              h(
                'li',
                { class: 'row' },
                h('span', { class: 'row-icon' }, runBadge(job.state)),
                h(
                  'div',
                  { class: 'row-main' },
                  h('div', { class: 'row-title' }, h('span', { class: 'strong' }, job.name)),
                  h(
                    'div',
                    { class: 'row-meta' },
                    runText(job.state),
                    job.seconds !== undefined ? ` · ${formatDuration(job.seconds)}` : '',
                    job.startedAt ? [' · ', time(job.startedAt)] : null,
                  ),
                ),
                button(
                  l10n.t('View log'),
                  () => {
                    send({ type: 'jobLog', jobId: job.id });
                  },
                  { icon: 'log', kind: 'quiet' },
                ),
              ),
            ),
          ),
    ),
  );
}

function signedOutPage(): HTMLElement {
  return h(
    'div',
    { class: 'wrap narrow center-block' },
    icon('repo', 'icon icon-hero'),
    h('h1', { class: 'page-title' }, l10n.t('Sign in to GitHub to browse here')),
    h(
      'p',
      { class: 'muted' },
      l10n.t(
        'Repositories, PRs, issues, Actions and notifications from your account, without leaving the IDE. The sign-in also works for git and the agents.',
      ),
    ),
    button(
      l10n.t('Sign in to GitHub'),
      () => {
        send({ type: 'action', action: 'login' });
      },
      { kind: 'primary' },
    ),
  );
}

function errorPage(
  message: string,
  fix: 'login' | 'diagnose' | 'sso' | undefined,
  url: string | undefined,
): HTMLElement {
  return h(
    'div',
    { class: 'wrap narrow center-block' },
    icon('warning', 'icon icon-hero'),
    h('h1', { class: 'page-title' }, l10n.t('Could not open this page')),
    h('p', { class: 'error-text' }, message),
    h(
      'div',
      { class: 'actions' },
      fix === 'login'
        ? button(
            l10n.t('Sign in to GitHub'),
            () => {
              send({ type: 'action', action: 'login' });
            },
            { kind: 'primary' },
          )
        : null,
      fix === 'sso' && url
        ? button(
            l10n.t('Authorize the token for the organization'),
            () => {
              send({ type: 'external', url });
            },
            { kind: 'primary', icon: 'external' },
          )
        : null,
      fix === 'diagnose' || fix === 'sso'
        ? button(
            l10n.t('Diagnose access'),
            () => {
              send({ type: 'action', action: 'diagnose' });
            },
            { kind: fix === 'diagnose' ? 'primary' : 'quiet' },
          )
        : null,
      button(
        l10n.t('Try again'),
        () => {
          send({ type: 'reload' });
        },
        { icon: 'reload', kind: 'quiet' },
      ),
      button(
        l10n.t('Open on GitHub'),
        () => {
          send({ type: 'external', url: githubUrl(route) });
        },
        { icon: 'external', kind: 'quiet' },
      ),
    ),
  );
}

function render(page: Page): HTMLElement {
  switch (page.view) {
    case 'home':
      return homePage(page);
    case 'search':
      return searchPage(page);
    case 'notifications':
      return notificationsPage(page);
    case 'user':
      return userPage(page);
    case 'repo':
      return repoPage(page);
    case 'file':
      return filePage(page);
    case 'pull':
      return pullPage(page);
    case 'issue':
      return issuePage(page);
    case 'run':
      return runPage(page);
    case 'signedOut':
      return signedOutPage();
  }
}

// ----------------------------------------------------------- eventos

interface FocusState {
  readonly key: string;
  readonly value?: string;
  readonly start?: number | null;
  readonly end?: number | null;
}

/** Campo com foco que sobrevive à troca da tela (`data-focus`), com o texto digitado. */
function focusState(): FocusState | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.dataset.focus) return undefined;
  if (active instanceof HTMLInputElement) {
    return {
      key: active.dataset.focus,
      value: active.value,
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }
  return { key: active.dataset.focus };
}

/**
 * Devolve o foco ao mesmo campo. `keepText` só vale na resposta da própria
 * busca: o que foi digitado depois do pedido continua no campo. Nas outras
 * telas (voltar, avançar, outro filtro) o campo mostra o valor da rota.
 */
function restoreFocus(state: FocusState | undefined, keepText: boolean): void {
  if (!state) return;
  const element = document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(state.key)}"]`);
  if (!element) return;
  if (keepText && element instanceof HTMLInputElement && state.value !== undefined) {
    element.value = state.value;
    element.focus();
    element.setSelectionRange(state.start ?? state.value.length, state.end ?? state.value.length);
    return;
  }
  element.focus();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Âncora a rolar quando a tela de destino de um link chegar. */
let pendingHash: { key: string; hash: string } | undefined;

window.addEventListener('message', (event: MessageEvent<FullToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'navigate': {
      const filtering = sameUserTab(route, message.route);
      // Outra tela aberta pela extensão: a busca esperando a pausa não vale mais.
      if (!filtering) cancelSearch();
      route = message.route;
      canBack = message.canBack;
      canForward = message.canForward;
      viewer = message.viewer;
      moreTarget = undefined;
      pendingComments.clear();
      // Busca e filtros da mesma lista: a tela fica, sem esqueleto, e o foco não se perde.
      const results = filtering ? document.querySelector('.repo-results') : null;
      if (results) {
        results.setAttribute('aria-busy', 'true');
        break;
      }
      frame(skeleton());
      window.scrollTo(0, 0);
      break;
    }
    case 'page': {
      if (message.key !== routeKey(route)) return;
      moreTarget = undefined;
      const focus = focusState();
      const keepText = message.key === searchKey;
      searchKey = undefined;
      frame(render(message.page));
      restoreFocus(focus, keepText);
      live.textContent = l10n.t(
        '{0} loaded',
        document.querySelector('h1')?.textContent ?? l10n.t('Page'),
      );
      // Âncora de um link de outro documento (`./guia.md#setup`).
      if (pendingHash?.key === message.key) {
        document.getElementById(anchorId(pendingHash.hash))?.scrollIntoView({ block: 'start' });
      }
      pendingHash = undefined;
      break;
    }
    case 'error':
      if (message.key !== routeKey(route)) return;
      pendingHash = undefined;
      frame(errorPage(message.message, message.fix, message.url));
      break;
    case 'more':
      if (message.key !== routeKey(route) || !moreTarget) return;
      moreTarget.list.append(...moreTarget.render(message.rows));
      moreFoot(moreTarget, message.hasMore);
      break;
    case 'commentResult': {
      const done = pendingComments.get(message.id);
      pendingComments.delete(message.id);
      done?.(message.ok, message.error);
      break;
    }
    case 'markedRead': {
      const row = document.querySelector(`[data-notification="${CSS.escape(message.id)}"]`);
      row?.classList.remove('unread');
      row?.querySelector('.icon-btn')?.remove();
      live.textContent = l10n.t('Notification marked as read');
      break;
    }
    case 'notice':
      toast.textContent = message.text;
      toast.classList.add('toast-on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.classList.remove('toast-on');
      }, 3500);
      break;
  }
});

/**
 * O host de webview do VS Code ouve cliques na `window` e abre no navegador
 * todo `<a href>`, mesmo com `preventDefault`. Os cliques em links param aqui,
 * depois dos handlers de cada link: navegar ou abrir fora é decisão do painel.
 */
function captureLink(event: MouseEvent): HTMLAnchorElement | undefined {
  const anchor = (event.target as Element | null)?.closest('a');
  if (!(anchor instanceof HTMLAnchorElement)) return undefined;
  event.preventDefault();
  event.stopPropagation();
  return anchor;
}

// Clique do meio: abriria no navegador pelo host; no painel não faz nada.
document.addEventListener('auxclick', (event) => {
  captureLink(event);
});

// Links do Markdown: rotas do painel, âncoras e links externos; nada navega a webview.
document.addEventListener('click', (event) => {
  const anchor = captureLink(event);
  if (!anchor?.closest('.markdown')) return;
  const { route: raw, anchor: id, external: url, hash } = anchor.dataset;
  if (raw) {
    try {
      const target = JSON.parse(raw) as Route;
      pendingHash = hash ? { key: routeKey(target), hash } : undefined;
      go(target);
    } catch {
      // Rota quebrada: a extensão recusaria de qualquer jeito.
    }
  } else if (id) {
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  } else if (url) {
    send({ type: 'external', url });
  }
});

window.addEventListener('keydown', (event) => {
  if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault();
    send({ type: 'back' });
  } else if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault();
    send({ type: 'forward' });
  } else if (
    event.key === '/' &&
    !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
  ) {
    event.preventDefault();
    document.querySelector<HTMLInputElement>('.search-input')?.focus();
  }
});

// Botões laterais do mouse (voltar e avançar).
window.addEventListener('mouseup', (event) => {
  if (event.button === 3) send({ type: 'back' });
  else if (event.button === 4) send({ type: 'forward' });
});

frame(skeleton());
send({ type: 'ready' });
