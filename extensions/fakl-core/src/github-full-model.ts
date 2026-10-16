import { currentLocale, l10n } from '@fakl/i18n';
import type {
  GhAccountItem,
  GhCheckRun,
  GhComment,
  GhCommit,
  GhContent,
  GhIssue,
  GhJob,
  GhLabel,
  GhNotification,
  GhProfile,
  GhPull,
  GhRelease,
  GhRepo,
  GhReview,
  GhUser,
  GhWorkflowRun,
} from '@fakl/integrations';

import type {
  CheckView,
  CommitView,
  EntryView,
  FullAction,
  FullFromWebview,
  ItemRow,
  ItemState,
  JobView,
  LabelView,
  LanguageShare,
  NotificationGroupView,
  NotificationRow,
  Person,
  ProfileView,
  PullTab,
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
  UserTab,
} from './github-full-protocol.js';
import { COMMENT_LIMIT } from './github-full-protocol.js';

/**
 * Lógica pura do GitHub em tela cheia (ADR 0030): rotas, histórico, links do
 * GitHub para rotas do painel, links e imagens relativos do Markdown e a
 * montagem dos modelos das telas. Sem `vscode`, usada pela extensão, pela
 * webview e pelos testes.
 */

const RAW = 'https://raw.githubusercontent.com';
const WEB = 'https://github.com';

/** Dono ou nome de repositório válido no GitHub. */
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const REPO_TABS: readonly RepoTab[] = ['code', 'issues', 'pulls', 'actions', 'releases'];
const PULL_TABS: readonly PullTab[] = ['conversation', 'files', 'checks'];
const USER_TABS: readonly UserTab[] = [
  'overview',
  'repositories',
  'stars',
  'followers',
  'following',
  'people',
];
const REPO_TYPES: readonly RepoType[] = [
  'all',
  'public',
  'private',
  'sources',
  'forks',
  'archived',
];
const REPO_SORTS: readonly RepoSort[] = ['updated', 'name', 'stars'];

/** Nome de cada aba do perfil, no idioma atual. */
export function userTabLabel(tab: UserTab): string {
  switch (tab) {
    case 'overview':
      return l10n.t('Overview');
    case 'repositories':
      return l10n.t('Repositories');
    case 'stars':
      return l10n.t('Stars');
    case 'followers':
      return l10n.t('Followers');
    case 'following':
      return l10n.t('Following');
    case 'people':
      return l10n.t('People');
  }
}

/**
 * Nome de cada aba do perfil. Getters: o texto sai no idioma da hora da
 * leitura, não no da carga do módulo. Prefira {@link userTabLabel}.
 */
export const USER_TAB_LABELS: Readonly<Record<UserTab, string>> = {
  get overview() {
    return userTabLabel('overview');
  },
  get repositories() {
    return userTabLabel('repositories');
  },
  get stars() {
    return userTabLabel('stars');
  },
  get followers() {
    return userTabLabel('followers');
  },
  get following() {
    return userTabLabel('following');
  },
  get people() {
    return userTabLabel('people');
  },
};

/** Valores de `type` e `sort` na URL do GitHub ↔ os do painel. */
// Map, não objeto: `type=constructor` ou `__proto__` não pode achar nada herdado.
const WEB_TYPES: ReadonlyMap<string, RepoType> = new Map([
  ['public', 'public'],
  ['private', 'private'],
  ['source', 'sources'],
  ['fork', 'forks'],
  ['archived', 'archived'],
]);
const WEB_SORTS: ReadonlyMap<string, RepoSort> = new Map([
  ['name', 'name'],
  ['stargazers', 'stars'],
]);

/** Chave da URL do GitHub para um valor do painel (`sources` → `source`). */
function webKey<T>(map: ReadonlyMap<string, T>, value: T): string | undefined {
  for (const [key, mapped] of map) if (mapped === value) return key;
  return undefined;
}

/** Primeiros segmentos de github.com que não são usuários nem organizações. */
const RESERVED = new Set([
  'about',
  'apps',
  'codespaces',
  'collections',
  'contact',
  'customer-stories',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'login',
  'logout',
  'marketplace',
  'new',
  'notifications',
  'organizations',
  'pricing',
  'pulls',
  'search',
  'security',
  'settings',
  'signup',
  'site',
  'sponsors',
  'topics',
  'trending',
]);

// ------------------------------------------------------------------ rotas

/** Chave estável de uma rota: duas rotas iguais têm a mesma chave. */
export function routeKey(route: Route): string {
  switch (route.view) {
    case 'home':
    case 'notifications':
      return route.view;
    case 'search':
      return `search?${route.q}`;
    case 'user': {
      const tab = route.tab ?? 'overview';
      if (tab !== 'repositories') return `user/${route.login.toLowerCase()}/${tab}`;
      const f = repoFilters(route);
      const params = new URLSearchParams({
        q: f.q,
        type: f.type,
        language: (f.language ?? '').toLowerCase(),
        sort: f.sort,
      });
      return `user/${route.login.toLowerCase()}/${tab}?${params.toString()}`;
    }
    case 'repo':
      return `${repoKey(route)}/${route.tab}@${route.ref ?? ''}:${route.path ?? ''}?${route.state ?? 'open'}`;
    case 'file':
      return `${repoKey(route)}/file@${route.ref ?? ''}:${route.path}`;
    case 'pull':
      return `${repoKey(route)}/pull/${String(route.number)}/${route.tab}`;
    case 'issue':
      return `${repoKey(route)}/issue/${String(route.number)}`;
    case 'run':
      return `${repoKey(route)}/run/${String(route.id)}`;
  }
}

function repoKey(route: { readonly owner: string; readonly name: string }): string {
  return `${route.owner}/${route.name}`.toLowerCase();
}

/**
 * Rota de um perfil sem os valores padrão: a visão geral não leva `tab` e os
 * filtros só existem na aba Repositórios. Assim a mesma tela tem uma rota só.
 */
export function userRoute(
  login: string,
  tab: UserTab = 'overview',
  filters: RepoFilters = {},
): Extract<Route, { view: 'user' }> {
  if (tab === 'overview') return { view: 'user', login };
  if (tab !== 'repositories') return { view: 'user', login, tab };
  const q = filters.q?.trim() ?? '';
  return {
    view: 'user',
    login,
    tab,
    ...(q ? { q } : {}),
    ...(filters.type && filters.type !== 'all' ? { type: filters.type } : {}),
    ...(filters.language ? { language: filters.language } : {}),
    ...(filters.sort && filters.sort !== 'updated' ? { sort: filters.sort } : {}),
  };
}

/** Filtros da aba Repositórios com os padrões preenchidos. */
export function repoFilters(filters: RepoFilters): {
  q: string;
  type: RepoType;
  language?: string;
  sort: RepoSort;
} {
  return {
    q: filters.q?.trim() ?? '',
    type: filters.type ?? 'all',
    ...(filters.language ? { language: filters.language } : {}),
    sort: filters.sort ?? 'updated',
  };
}

/**
 * Lista de repositórios do perfil com busca, tipo, linguagem e ordem aplicados,
 * como "Encontrar um repositório…" do GitHub. A busca olha nome e descrição.
 */
export function filterRepos(rows: readonly RepoRow[], filters: RepoFilters): RepoRow[] {
  const f = repoFilters(filters);
  const q = f.q.toLowerCase();
  const language = f.language?.toLowerCase();
  const kept = rows.filter((repo) => {
    if (q && !`${repo.name}\n${repo.description ?? ''}`.toLowerCase().includes(q)) return false;
    if (language && repo.language?.toLowerCase() !== language) return false;
    switch (f.type) {
      case 'all':
        return true;
      case 'public':
        return !repo.private;
      case 'private':
        return repo.private;
      case 'sources':
        return !repo.fork;
      case 'forks':
        return repo.fork;
      case 'archived':
        return repo.archived;
    }
  });
  const updated = (repo: RepoRow): number => Date.parse(repo.updatedAt ?? '') || 0;
  const byName = (a: RepoRow, b: RepoRow): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return kept.sort((a, b) => {
    switch (f.sort) {
      case 'name':
        return byName(a, b);
      case 'stars':
        return b.stars - a.stars || updated(b) - updated(a);
      case 'updated':
        return updated(b) - updated(a) || byName(a, b);
    }
  });
}

/** A sessão do GitHub mudou enquanto a leitura corria: o resultado é de outra conta. */
export class StaleSessionError extends Error {
  constructor() {
    super(l10n.t('The GitHub account changed while loading. Refresh the page.'));
    this.name = 'StaleSessionError';
  }
}

/**
 * Cache de um valor por chave, válido por `ttl` ms e preso à sessão: depois de
 * `invalidate()` (troca de conta, Atualizar), nada lido antes volta, nem uma
 * leitura que começou antes e terminou depois. Assim repositórios privados de
 * uma conta não aparecem na outra.
 */
export class SessionCache<T> {
  private generation = 0;
  private entry: { key: string; generation: number; at: number; value: T } | undefined;

  constructor(
    private readonly ttl: number,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(): void {
    this.generation++;
    this.entry = undefined;
  }

  /** O valor guardado para `key`, se ainda vale. */
  peek(key: string): T | undefined {
    const entry = this.entry;
    return entry?.key === key &&
      entry.generation === this.generation &&
      this.now() - entry.at < this.ttl
      ? entry.value
      : undefined;
  }

  /** O guardado ou uma leitura nova; `StaleSessionError` se a sessão mudou no meio. */
  async load(key: string, read: () => Promise<T>): Promise<T> {
    const cached = this.peek(key);
    if (cached !== undefined) return cached;
    const generation = this.generation;
    const value = await read();
    if (generation !== this.generation) throw new StaleSessionError();
    this.entry = { key, generation, at: this.now(), value };
    return value;
  }
}

/** Linguagens presentes na lista, em ordem alfabética, para o filtro. */
export function repoLanguages(rows: readonly RepoRow[]): string[] {
  const names = new Set(rows.flatMap((repo) => (repo.language ? [repo.language] : [])));
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Os mais populares (estrelas, depois atividade), para o perfil sem fixados. */
export function popularRepos(rows: readonly RepoRow[], max = 6): RepoRow[] {
  return filterRepos(
    rows.filter((repo) => !repo.fork && !repo.archived),
    { sort: 'stars' },
  ).slice(0, max);
}

/** Mesma aba do mesmo perfil: só a busca ou os filtros mudam entre as duas rotas. */
export function sameUserTab(a: Route, b: Route): boolean {
  return (
    a.view === 'user' &&
    b.view === 'user' &&
    a.login.toLowerCase() === b.login.toLowerCase() &&
    (a.tab ?? 'overview') === (b.tab ?? 'overview')
  );
}

/** Mesmo item, ignorando a aba: trocar de aba não empilha no histórico de outro item. */
export function sameRoute(a: Route, b: Route): boolean {
  return routeKey(a) === routeKey(b);
}

/**
 * Voltar e avançar do painel. Navegar para a mesma rota não empilha; navegar
 * depois de voltar descarta o que estava à frente, como num navegador.
 */
export class RouteHistory {
  private entries: Route[];
  private index = 0;

  constructor(
    start: Route = { view: 'home' },
    private readonly limit = 100,
  ) {
    this.entries = [start];
  }

  get current(): Route {
    return this.entries[this.index] ?? { view: 'home' };
  }

  get canBack(): boolean {
    return this.index > 0;
  }

  get canForward(): boolean {
    return this.index < this.entries.length - 1;
  }

  push(route: Route): Route {
    if (sameRoute(route, this.current)) return this.current;
    this.entries = [...this.entries.slice(0, this.index + 1), route].slice(-this.limit);
    this.index = this.entries.length - 1;
    return route;
  }

  /** Troca a rota atual sem criar entrada (ex.: um arquivo que era pasta). */
  replace(route: Route): void {
    this.entries[this.index] = route;
  }

  back(): Route {
    if (this.canBack) this.index--;
    return this.current;
  }

  forward(): Route {
    if (this.canForward) this.index++;
    return this.current;
  }
}

/** Rota de uma URL do github.com (ou da API); `undefined` se o painel não mostra aquilo. */
export function parseGitHubUrl(raw: string): Route | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => safeDecode(part));
  if (host === 'api.github.com') {
    const [root, owner, name, kind, id] = parts;
    if (root !== 'repos' || !owner || !name) return undefined;
    if (!isName(owner) || !isName(name)) return undefined;
    const number = Number(id);
    if (kind === 'pulls' && isId(number)) {
      return { view: 'pull', owner, name, number, tab: 'conversation' };
    }
    if (kind === 'issues' && isId(number)) return { view: 'issue', owner, name, number };
    if (kind === undefined) return { view: 'repo', owner, name, tab: 'code' };
    return undefined;
  }
  if (host !== 'github.com' && host !== 'www.github.com') return undefined;
  const [owner, name, kind, ...rest] = parts;
  if (!owner) return { view: 'home' };
  if (owner === 'notifications' && !name) return { view: 'notifications' };
  if (owner === 'orgs' && name && isLogin(name)) {
    // github.com/orgs/acme/repositories?q=... e github.com/orgs/acme/people
    const tab = kind === 'repositories' ? 'repositories' : kind === 'people' ? 'people' : undefined;
    return webUserRoute(name, tab, url.searchParams);
  }
  if (RESERVED.has(owner.toLowerCase())) return undefined;
  if (!name) {
    if (!isLogin(owner)) return undefined;
    const tab = USER_TABS.find((t) => t === url.searchParams.get('tab'));
    return webUserRoute(owner, tab, url.searchParams);
  }
  if (!isName(owner) || !isName(name)) return undefined;
  const repo = { owner, name: name.replace(/\.git$/, '') };
  const number = Number(rest[0]);
  switch (kind) {
    case undefined:
      return { view: 'repo', ...repo, tab: 'code' };
    case 'tree':
    case 'blob': {
      const [ref, ...path] = rest;
      if (!ref) return { view: 'repo', ...repo, tab: 'code' };
      const file = path.join('/');
      if (kind === 'blob' && file) return { view: 'file', ...repo, ref, path: file };
      return { view: 'repo', ...repo, tab: 'code', ref, ...(file ? { path: file } : {}) };
    }
    case 'pull': {
      if (!isId(number)) return undefined;
      const tab = rest[1] === 'files' ? 'files' : rest[1] === 'checks' ? 'checks' : 'conversation';
      return { view: 'pull', ...repo, number, tab };
    }
    case 'issues':
      return isId(number)
        ? { view: 'issue', ...repo, number }
        : { view: 'repo', ...repo, tab: 'issues' };
    case 'pulls':
      return { view: 'repo', ...repo, tab: 'pulls' };
    case 'actions': {
      const id = Number(rest[1]);
      return rest[0] === 'runs' && isId(id)
        ? { view: 'run', ...repo, id }
        : { view: 'repo', ...repo, tab: 'actions' };
    }
    case 'releases':
      return { view: 'repo', ...repo, tab: 'releases' };
    default:
      return undefined;
  }
}

/** Rota de perfil a partir da aba e dos filtros da URL do GitHub. */
function webUserRoute(login: string, tab: UserTab | undefined, params: URLSearchParams): Route {
  if (tab !== 'repositories') return userRoute(login, tab);
  const type = WEB_TYPES.get(params.get('type') ?? '');
  const sort = WEB_SORTS.get(params.get('sort') ?? '');
  const q = params.get('q') ?? '';
  const language = params.get('language') ?? '';
  return userRoute(login, tab, {
    ...(isQuery(q) ? { q } : {}),
    ...(type ? { type } : {}),
    ...(isLanguage(language) ? { language } : {}),
    ...(sort ? { sort } : {}),
  });
}

/** URL da mesma tela no github.com, para "Abrir no GitHub". */
export function githubUrl(route: Route): string {
  switch (route.view) {
    case 'home':
      return WEB;
    case 'search':
      return `${WEB}/search?q=${encodeURIComponent(route.q)}&type=repositories`;
    case 'notifications':
      return `${WEB}/notifications`;
    case 'user': {
      const base = `${WEB}/${encodeURIComponent(route.login)}`;
      const tab = route.tab ?? 'overview';
      if (tab === 'overview') return base;
      if (tab === 'people') return `${WEB}/orgs/${encodeURIComponent(route.login)}/people`;
      const params = new URLSearchParams({ tab });
      if (tab === 'repositories') {
        const f = repoFilters(route);
        const type = webKey(WEB_TYPES, f.type);
        const sort = webKey(WEB_SORTS, f.sort);
        if (f.q) params.set('q', f.q);
        if (type) params.set('type', type);
        if (f.language) params.set('language', f.language.toLowerCase());
        if (sort) params.set('sort', sort);
      }
      return `${base}?${params.toString()}`;
    }
    case 'repo': {
      const base = `${WEB}/${route.owner}/${route.name}`;
      switch (route.tab) {
        case 'code':
          return route.ref || route.path
            ? `${base}/tree/${encodeSegments(route.ref ?? 'HEAD')}${route.path ? `/${encodeSegments(route.path)}` : ''}`
            : base;
        case 'issues':
        case 'pulls':
          return `${base}/${route.tab}${route.state === 'closed' ? '?q=is%3Aclosed' : ''}`;
        default:
          return `${base}/${route.tab}`;
      }
    }
    case 'file':
      return `${WEB}/${route.owner}/${route.name}/blob/${encodeSegments(route.ref ?? 'HEAD')}/${encodeSegments(route.path)}`;
    case 'pull':
      return `${WEB}/${route.owner}/${route.name}/pull/${String(route.number)}${route.tab === 'conversation' ? '' : `/${route.tab}`}`;
    case 'issue':
      return `${WEB}/${route.owner}/${route.name}/issues/${String(route.number)}`;
    case 'run':
      return `${WEB}/${route.owner}/${route.name}/actions/runs/${String(route.id)}`;
  }
}

export interface Crumb {
  readonly label: string;
  /** Sem rota: é a tela atual. */
  readonly route?: Route;
}

/** Caminho da tela atual, do dono até o item. */
export function breadcrumbs(route: Route): Crumb[] {
  switch (route.view) {
    case 'home':
      return [{ label: l10n.t('Home') }];
    case 'search':
      return [
        { label: l10n.t('Home'), route: { view: 'home' } },
        { label: l10n.t('Search: {0}', route.q) },
      ];
    case 'notifications':
      return [
        { label: l10n.t('Home'), route: { view: 'home' } },
        { label: l10n.t('Notifications') },
      ];
    case 'user':
      return !route.tab || route.tab === 'overview'
        ? [{ label: route.login }]
        : [
            { label: route.login, route: userRoute(route.login) },
            { label: userTabLabel(route.tab) },
          ];
    default:
      break;
  }
  const owner: Crumb = { label: route.owner, route: { view: 'user', login: route.owner } };
  const repo: Route = { view: 'repo', owner: route.owner, name: route.name, tab: 'code' };
  switch (route.view) {
    case 'repo': {
      const path = route.path ? route.path.split('/') : [];
      if (route.tab !== 'code' || path.length === 0) return [owner, { label: route.name }];
      return [
        owner,
        { label: route.name, route: { ...repo, ...(route.ref ? { ref: route.ref } : {}) } },
        ...pathCrumbs(route.owner, route.name, route.ref, path),
      ];
    }
    case 'file':
      return [
        owner,
        { label: route.name, route: { ...repo, ...(route.ref ? { ref: route.ref } : {}) } },
        ...pathCrumbs(route.owner, route.name, route.ref, route.path.split('/')),
      ];
    case 'pull':
      return [
        owner,
        { label: route.name, route: repo },
        { label: 'Pull requests', route: { ...repo, tab: 'pulls' } },
        { label: `#${String(route.number)}` },
      ];
    case 'issue':
      return [
        owner,
        { label: route.name, route: repo },
        { label: 'Issues', route: { ...repo, tab: 'issues' } },
        { label: `#${String(route.number)}` },
      ];
    case 'run':
      return [
        owner,
        { label: route.name, route: repo },
        { label: 'Actions', route: { ...repo, tab: 'actions' } },
        { label: l10n.t('Run {0}', String(route.id)) },
      ];
  }
}

function pathCrumbs(
  owner: string,
  name: string,
  ref: string | undefined,
  parts: readonly string[],
): Crumb[] {
  return parts.map((part, index) =>
    index === parts.length - 1
      ? { label: part }
      : {
          label: part,
          route: {
            view: 'repo',
            owner,
            name,
            tab: 'code',
            path: parts.slice(0, index + 1).join('/'),
            ...(ref ? { ref } : {}),
          },
        },
  );
}

/** Título curto da aba do editor. */
export function routeTitle(route: Route): string {
  switch (route.view) {
    case 'home':
      return 'GitHub';
    case 'search':
      return `GitHub: ${route.q}`;
    case 'notifications':
      return l10n.t('GitHub: notifications');
    case 'user':
      return !route.tab || route.tab === 'overview'
        ? route.login
        : `${route.login}: ${userTabLabel(route.tab).toLowerCase()}`;
    case 'repo':
      return route.path ? `${route.name}/${route.path}` : `${route.owner}/${route.name}`;
    case 'file':
      return route.path.split('/').pop() ?? route.path;
    case 'pull':
      return `${route.name} #${String(route.number)}`;
    case 'issue':
      return `${route.name} #${String(route.number)}`;
    case 'run':
      return l10n.t('{0}: run', route.name);
  }
}

// --------------------------------------------------- links do Markdown

/** Onde um Markdown mora: o repositório, o ref e a pasta do arquivo. */
export interface DocContext {
  readonly owner: string;
  readonly name: string;
  readonly ref: string;
  readonly dir: string;
}

export type LinkTarget =
  | { readonly kind: 'route'; readonly route: Route; readonly hash?: string }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'anchor'; readonly id: string };

/**
 * Tira o que o parser de URL do navegador ignora ou que disfarça um esquema:
 * caracteres de controle em qualquer lugar (tab e quebra de linha em
 * `jav&#x09;ascript:`) e espaços nas pontas.
 */
export function normalizeHref(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LINK_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:', 'mailto:']);
const IMAGE_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:']);

/** URL absoluta (já normalizada) com esquema permitido, pelo parser de URL; senão `undefined`. */
function safeUrl(value: string, allowed: ReadonlySet<string>): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return allowed.has(url.protocol) ? url : undefined;
}

/** URL externa que a extensão aceita abrir: http(s) ou mailto, já normalizada. */
export function safeExternalUrl(raw: string): string | undefined {
  return safeUrl(normalizeHref(raw), LINK_PROTOCOLS)?.href;
}

/**
 * Para onde leva um link do Markdown: âncora na própria página, outra tela do
 * painel (links relativos e links do github.com) ou o navegador. Só passam
 * http(s), mailto, âncora e caminho relativo; qualquer outro esquema
 * (`javascript:`, `data:`, `file:`...), mesmo disfarçado com caracteres de
 * controle, devolve `undefined`. O destino devolvido é sempre o normalizado.
 */
export function resolveLink(href: string, ctx: DocContext | undefined): LinkTarget | undefined {
  const value = normalizeHref(href);
  if (!value) return undefined;
  if (value.startsWith('#')) return { kind: 'anchor', id: safeDecode(value.slice(1)) };
  if (value.startsWith('//')) return resolveLink(`https:${value}`, ctx);
  if (SCHEME.test(value)) {
    const url = safeUrl(value, LINK_PROTOCOLS);
    if (!url) return undefined;
    if (url.protocol === 'mailto:') return { kind: 'external', url: url.href };
    const route = parseGitHubUrl(url.href);
    if (route) {
      const hash = url.hash.slice(1);
      return { kind: 'route', route, ...(hash ? { hash: safeDecode(hash) } : {}) };
    }
    return { kind: 'external', url: url.href };
  }
  if (!ctx) return undefined;
  const [pathPart = '', hash = ''] = value.split('#', 2);
  const clean = pathPart.split('?')[0] ?? '';
  const path = joinRepoPath(ctx.dir, clean);
  const repo = { owner: ctx.owner, name: ctx.name };
  const route: Route =
    path === '' || clean.endsWith('/')
      ? { view: 'repo', ...repo, tab: 'code', ref: ctx.ref, ...(path ? { path } : {}) }
      : { view: 'file', ...repo, ref: ctx.ref, path };
  return { kind: 'route', route, ...(hash ? { hash: safeDecode(hash) } : {}) };
}

/**
 * Endereço seguro de uma imagem do Markdown: relativo vira raw.githubusercontent
 * no ref do documento, `blob` do github.com vira raw, http sobe para https e
 * só `data:image/*` passa. O resto devolve `undefined` e a imagem some.
 */
export function resolveImage(src: string, ctx: DocContext | undefined): string | undefined {
  const value = normalizeHref(src);
  if (!value) return undefined;
  if (/^data:image\/(png|gif|jpe?g|webp|avif|bmp|svg\+xml)[;,]/i.test(value)) return value;
  if (value.startsWith('//')) return resolveImage(`https:${value}`, ctx);
  if (SCHEME.test(value)) {
    const url = safeUrl(value, IMAGE_PROTOCOLS);
    if (!url) return undefined;
    url.protocol = 'https:';
    if (url.hostname === 'github.com') {
      const [owner, name, kind, ref, ...path] = url.pathname.split('/').filter(Boolean);
      if (owner && name && (kind === 'blob' || kind === 'raw') && ref && path.length > 0) {
        return `${RAW}/${owner}/${name}/${ref}/${path.join('/')}`;
      }
    }
    return url.href;
  }
  if (!ctx) return undefined;
  const path = joinRepoPath(ctx.dir, value.split(/[?#]/)[0] ?? '');
  if (!path) return undefined;
  return `${RAW}/${ctx.owner}/${ctx.name}/${encodeSegments(ctx.ref)}/${encodeSegments(path)}`;
}

/**
 * Separa ref e caminho quando o branch tem `/`: `/blob/feature/auth/src/a.ts`
 * chega como ref `feature` e caminho `auth/src/a.ts`. Fica com o prefixo mais
 * longo que é um branch ou tag conhecido; sem nenhum (um SHA, por exemplo),
 * mantém como veio. O git não deixa existir `feature` e `feature/auth` juntos,
 * então não há dois candidatos válidos.
 */
export function splitRefPath(
  ref: string,
  path: string,
  refs: readonly string[],
): { ref: string; path: string } {
  const known = new Set(refs);
  if (known.has(ref)) return { ref, path };
  const parts = [...ref.split('/'), ...path.split('/')].filter(Boolean);
  for (let end = parts.length; end > 0; end--) {
    const candidate = parts.slice(0, end).join('/');
    if (known.has(candidate)) return { ref: candidate, path: parts.slice(end).join('/') };
  }
  return { ref, path };
}

/** Junta um caminho relativo à pasta do documento; `/` no começo é a raiz do repositório. */
export function joinRepoPath(dir: string, relative: string): string {
  const parts = relative.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const part of safeDecode(relative).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** Pasta de um caminho (`''` na raiz). */
export function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function encodeSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ------------------------------------------- mensagens vindas da webview

function isName(value: unknown): value is string {
  return typeof value === 'string' && NAME.test(value) && value !== '.' && value !== '..';
}

function isLogin(value: unknown): value is string {
  return typeof value === 'string' && LOGIN.test(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Caminho no repositório: texto curto, sem `..`, sem barra invertida nem controle. */
function isRepoPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 1000 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\\]/.test(value) &&
    !value.split('/').some((part) => part === '..')
  );
}

/** Chave de rota (de `routeKey`) vinda da webview. */
function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2000;
}

function isRef(value: unknown): value is string {
  return isRepoPath(value) && value.length > 0 && value.length <= 250;
}

/** Texto curto de busca ou filtro, sem caracteres de controle. */
function isShortText(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function isQuery(value: unknown): value is string {
  return isShortText(value, 100) && value.trim() !== '';
}

function isLanguage(value: unknown): value is string {
  return isShortText(value, 60) && value.trim() !== '';
}

/** Rota de perfil vinda da webview; filtros fora do padrão invalidam a rota inteira. */
function parseUserRoute(r: Record<string, unknown>): Route | undefined {
  if (!isLogin(r.login)) return undefined;
  const tab = r.tab === undefined ? 'overview' : USER_TABS.find((t) => t === r.tab);
  if (!tab) return undefined;
  if (r.q !== undefined && !isShortText(r.q, 100)) return undefined;
  if (r.language !== undefined && !isShortText(r.language, 60)) return undefined;
  const type = r.type === undefined ? 'all' : REPO_TYPES.find((t) => t === r.type);
  const sort = r.sort === undefined ? 'updated' : REPO_SORTS.find((s) => s === r.sort);
  if (!type || !sort) return undefined;
  return userRoute(r.login, tab, {
    ...(typeof r.q === 'string' ? { q: r.q } : {}),
    type,
    ...(isLanguage(r.language) ? { language: r.language.trim() } : {}),
    sort,
  });
}

const ACTIONS: readonly FullAction[] = [
  'review',
  'merge',
  'checkout',
  'toAgents',
  'rerun',
  'clone',
  'newIssue',
  'openInEditor',
  'markAllRead',
  'login',
  'diagnose',
];

/** Rota vinda da webview, conferida campo a campo; `undefined` se algo não bate. */
export function parseRoute(raw: unknown): Route | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.view) {
    case 'home':
    case 'notifications':
      return { view: r.view };
    case 'search':
      return typeof r.q === 'string' && r.q.trim() && r.q.length <= 256
        ? { view: 'search', q: r.q.trim() }
        : undefined;
    case 'user':
      return parseUserRoute(r);
    default:
      break;
  }
  if (!isName(r.owner) || !isName(r.name)) return undefined;
  const repo = { owner: r.owner, name: r.name };
  const ref = r.ref === undefined ? {} : isRef(r.ref) ? { ref: r.ref } : undefined;
  if (!ref) return undefined;
  switch (r.view) {
    case 'repo': {
      const tab = REPO_TABS.find((t) => t === r.tab);
      if (!tab) return undefined;
      if (r.path !== undefined && !isRepoPath(r.path)) return undefined;
      if (r.state !== undefined && r.state !== 'open' && r.state !== 'closed') return undefined;
      return {
        view: 'repo',
        ...repo,
        tab,
        ...ref,
        ...(typeof r.path === 'string' && r.path ? { path: r.path } : {}),
        ...(r.state === 'open' || r.state === 'closed' ? { state: r.state } : {}),
      };
    }
    case 'file':
      return isRepoPath(r.path) && r.path
        ? { view: 'file', ...repo, ...ref, path: r.path }
        : undefined;
    case 'pull': {
      const tab = PULL_TABS.find((t) => t === r.tab) ?? 'conversation';
      return isId(r.number) ? { view: 'pull', ...repo, number: r.number, tab } : undefined;
    }
    case 'issue':
      return isId(r.number) ? { view: 'issue', ...repo, number: r.number } : undefined;
    case 'run':
      return isId(r.id) ? { view: 'run', ...repo, id: r.id } : undefined;
    default:
      return undefined;
  }
}

/** Mensagem da webview validada; qualquer coisa fora do protocolo é descartada. */
export function parseFromWebview(raw: unknown): FullFromWebview | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'back':
    case 'forward':
    case 'reload':
      return { type: m.type };
    case 'navigate': {
      const route = parseRoute(m.route);
      if (!route) return undefined;
      return m.replace === true
        ? { type: 'navigate', route, replace: true }
        : { type: 'navigate', route };
    }
    case 'external': {
      const url = typeof m.url === 'string' && m.url.length < 4096 ? safeExternalUrl(m.url) : '';
      return url ? { type: 'external', url } : undefined;
    }
    case 'action': {
      const action = ACTIONS.find((a) => a === m.action);
      return action ? { type: 'action', action } : undefined;
    }
    case 'more':
      return isKey(m.key) ? { type: 'more', key: m.key } : undefined;
    case 'comment':
      return typeof m.id === 'string' &&
        /^[\w-]{1,40}$/.test(m.id) &&
        isKey(m.key) &&
        isId(m.number) &&
        typeof m.body === 'string' &&
        m.body.trim() &&
        m.body.length <= COMMENT_LIMIT
        ? { type: 'comment', id: m.id, key: m.key, number: m.number, body: m.body }
        : undefined;
    case 'openDiff':
      return isRepoPath(m.filename) && m.filename
        ? { type: 'openDiff', filename: m.filename }
        : undefined;
    case 'jobLog':
      return isId(m.jobId) ? { type: 'jobLog', jobId: m.jobId } : undefined;
    case 'markRead':
      return typeof m.id === 'string' && /^\d{1,30}$/.test(m.id)
        ? { type: 'markRead', id: m.id }
        : undefined;
    default:
      return undefined;
  }
}

// ------------------------------------------------- modelos das telas

/** Texto escuro ou claro sobre a cor de um rótulo, pela luminância. */
export function labelInk(color: string | undefined): 'dark' | 'light' {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color ?? '')?.[1];
  if (!hex) return 'light';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.4 ? 'dark' : 'light';
}

export function labelView(label: GhLabel | string): LabelView {
  if (typeof label === 'string') return { name: label, ink: 'light' };
  const color = label.color && /^[0-9a-f]{6}$/i.test(label.color) ? `#${label.color}` : undefined;
  return { name: label.name, ...(color ? { color } : {}), ink: labelInk(color) };
}

export function person(user: GhUser | null | undefined): Person | undefined {
  if (!user) return undefined;
  return { login: user.login, ...(user.avatar_url ? { avatar: user.avatar_url } : {}) };
}

export function pullState(
  pull: Pick<GhPull, 'state' | 'draft' | 'merged' | 'merged_at'>,
): ItemState {
  if (pull.merged || pull.merged_at) return 'merged';
  if (pull.state === 'closed') return 'closed';
  return pull.draft ? 'draft' : 'open';
}

/** Estado de uma execução, job ou check, pelo par status/conclusão da API. */
export function runState(status: string | null, conclusion: string | null): RunState {
  if (status === 'queued' || status === 'waiting' || status === 'pending' || status === 'requested')
    return 'queued';
  if (status !== 'completed') return 'running';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
    case 'action_required':
      return 'failure';
    case 'cancelled':
    case 'skipped':
      return 'cancelled';
    default:
      return 'neutral';
  }
}

export function splitRepo(full: string): { owner: string; name: string } {
  const [owner = full, name = ''] = full.split('/');
  return { owner, name };
}

export function accountRow(item: GhAccountItem): ItemRow {
  return {
    ...splitRepo(item.repo),
    number: item.number,
    kind: item.kind,
    title: item.title,
    state: item.state === 'closed' ? 'closed' : item.draft ? 'draft' : 'open',
    ...(item.author ? { author: item.author } : {}),
    labels: item.labels.map(labelView),
    comments: item.comments,
    updatedAt: item.updatedAt,
  };
}

export function pullRow(owner: string, name: string, pull: GhPull): ItemRow {
  return {
    owner,
    name,
    number: pull.number,
    kind: 'pr',
    title: pull.title,
    state: pullState(pull),
    ...(pull.user ? { author: pull.user.login } : {}),
    labels: (pull.labels ?? []).map(labelView),
    comments: 0,
    updatedAt: pull.updated_at,
  };
}

export function issueRow(owner: string, name: string, issue: GhIssue): ItemRow {
  return {
    owner,
    name,
    number: issue.number,
    kind: 'issue',
    title: issue.title,
    state: issue.state,
    ...(issue.user ? { author: issue.user.login } : {}),
    labels: issue.labels.map(labelView),
    comments: issue.comments,
    updatedAt: issue.updated_at,
  };
}

export function repoRow(repo: GhRepo): RepoRow {
  const { owner, name } = splitRepo(repo.full_name);
  return {
    owner,
    name,
    ...(repo.description ? { description: repo.description } : {}),
    private: repo.private,
    fork: repo.fork ?? false,
    archived: repo.archived ?? false,
    ...(repo.language ? { language: repo.language } : {}),
    ...(repo.language_color && /^#[0-9a-f]{6}$/i.test(repo.language_color)
      ? { languageColor: repo.language_color }
      : {}),
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    ...(repo.pushed_at || repo.updated_at
      ? { updatedAt: repo.pushed_at ?? repo.updated_at ?? '' }
      : {}),
  };
}

export function profileView(profile: GhProfile, mine: boolean): ProfileView {
  return {
    login: profile.login,
    kind: profile.type,
    url: profile.html_url,
    mine,
    ...(profile.avatar_url ? { avatar: profile.avatar_url } : {}),
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.bio ? { bio: profile.bio } : {}),
    ...(profile.company ? { company: profile.company } : {}),
    ...(profile.blog ? { blog: profile.blog } : {}),
    ...(profile.location ? { location: profile.location } : {}),
    ...(profile.followers !== undefined ? { followers: profile.followers } : {}),
    ...(profile.following !== undefined ? { following: profile.following } : {}),
    ...(profile.public_repos !== undefined ? { publicRepos: profile.public_repos } : {}),
  };
}

/** Endereço do blog do perfil: o GitHub aceita sem esquema; http sobe para https. */
export function blogUrl(blog: string): string | undefined {
  const value = /^https?:\/\//i.test(blog) ? blog.replace(/^http:/i, 'https:') : `https://${blog}`;
  return safeExternalUrl(value);
}

export function repoHeader(repo: GhRepo): RepoHeader {
  const license =
    repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION'
      ? repo.license.spdx_id
      : repo.license?.name;
  return {
    ...repoRow(repo),
    defaultBranch: repo.default_branch,
    openIssues: repo.open_issues_count ?? 0,
    topics: repo.topics ?? [],
    ...(repo.homepage ? { homepage: repo.homepage } : {}),
    ...(license ? { license } : {}),
    url: repo.html_url,
  };
}

export function runRow(owner: string, name: string, run: GhWorkflowRun): RunRow {
  return {
    owner,
    name,
    id: run.id,
    title: run.display_title ?? run.name ?? 'workflow',
    workflow: run.name ?? 'workflow',
    number: run.run_number,
    ...(run.head_branch ? { branch: run.head_branch } : {}),
    event: run.event,
    state: runState(run.status, run.conclusion),
    createdAt: run.created_at,
  };
}

export function jobView(job: GhJob): JobView {
  const start = job.started_at ? Date.parse(job.started_at) : NaN;
  const end = job.completed_at ? Date.parse(job.completed_at) : NaN;
  return {
    id: job.id,
    name: job.name,
    state: runState(job.status, job.conclusion),
    ...(job.started_at ? { startedAt: job.started_at } : {}),
    ...(Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? { seconds: Math.round((end - start) / 1000) }
      : {}),
  };
}

export function checkView(check: GhCheckRun): CheckView {
  const url = check.html_url ?? check.details_url;
  return {
    name: check.name,
    state: runState(check.status, check.conclusion),
    ...(url ? { url } : {}),
    ...(check.app?.name ? { app: check.app.name } : {}),
  };
}

export function entryView(item: GhContent): EntryView {
  return { name: item.name, path: item.path, type: item.type, size: item.size };
}

export function commitView(commit: GhCommit): CommitView {
  const author = commit.author?.login ?? commit.commit.author?.name;
  return {
    sha: commit.sha,
    message: commit.commit.message.split('\n')[0] ?? '',
    ...(author ? { author } : {}),
    ...(commit.author?.avatar_url ? { avatar: commit.author.avatar_url } : {}),
    ...(commit.commit.author?.date ? { date: commit.commit.author.date } : {}),
  };
}

export function releaseView(release: GhRelease): ReleaseView {
  return {
    tag: release.tag_name,
    name: (release.name ?? '').trim() || release.tag_name,
    draft: release.draft,
    prerelease: release.prerelease,
    ...(release.published_at ? { publishedAt: release.published_at } : {}),
    ...(release.body ? { body: release.body } : {}),
    ...(release.author ? { author: release.author.login } : {}),
    url: release.html_url,
  };
}

/** Comentários e revisões numa linha do tempo só, em ordem de data. */
export function timeline(
  comments: readonly GhComment[],
  reviews: readonly GhReview[] = [],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...comments.map((c): TimelineEntry => {
      const author = person(c.user);
      return { kind: 'comment', ...(author ? { author } : {}), date: c.created_at, body: c.body };
    }),
    ...reviews
      // Revisão "comentada" sem texto é só o envelope de comentários em linha.
      .filter((r) => r.submitted_at && ((r.body ?? '') !== '' || r.state !== 'COMMENTED'))
      .map((r): TimelineEntry => {
        const author = person(r.user);
        return {
          kind: 'review',
          ...(author ? { author } : {}),
          date: r.submitted_at ?? '',
          body: r.body ?? '',
          review: r.state,
        };
      }),
  ];
  return entries.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/** Parte de cada linguagem em porcentagem; além de `max`, o resto vira "Other" ("Outras"). */
export function languageShares(bytes: Readonly<Record<string, number>>, max = 6): LanguageShare[] {
  const entries = Object.entries(bytes)
    .filter(([, size]) => size > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, size]) => sum + size, 0);
  if (total === 0) return [];
  const round = (size: number): number => Math.round((size / total) * 1000) / 10;
  const top = entries.slice(0, max).map(([name, size]) => ({ name, percent: round(size) }));
  const rest = entries.slice(max).reduce((sum, [, size]) => sum + size, 0);
  return rest > 0 ? [...top, { name: l10n.t('Other'), percent: round(rest) }] : top;
}

/** URL da web e rota no painel de uma notificação. */
export function notificationRow(n: GhNotification): NotificationRow {
  const web = notificationWebUrl(n);
  const route = parseGitHubUrl(web);
  return {
    id: n.id,
    unread: n.unread,
    reason: n.reason.replace(/_/g, ' '),
    title: n.subject.title,
    type: n.subject.type,
    repo: n.repository.full_name,
    updatedAt: n.updated_at,
    ...(route ? { route } : {}),
    url: web,
  };
}

function notificationWebUrl(n: GhNotification): string {
  const api = n.subject.url;
  if (!api) return n.repository.html_url;
  return api
    .replace('https://api.github.com/repos/', 'https://github.com/')
    .replace(/\/pulls\/(\d+)$/, '/pull/$1')
    .replace(/\/commits\/([0-9a-f]+)$/, '/commit/$1');
}

export function notificationGroups(list: readonly GhNotification[]): NotificationGroupView[] {
  const groups = new Map<string, NotificationRow[]>();
  for (const n of list) {
    const rows = groups.get(n.repository.full_name) ?? [];
    rows.push(notificationRow(n));
    groups.set(n.repository.full_name, rows);
  }
  const newest = (rows: readonly NotificationRow[]): number =>
    Math.max(...rows.map((row) => Date.parse(row.updatedAt) || 0));
  return [...groups.entries()]
    .map(([repo, items]) => ({
      repo,
      unread: items.filter((item) => item.unread).length,
      items: [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    }))
    .sort((a, b) => newest(b.items) - newest(a.items));
}

// --------------------------------------------------------- arquivos

const MARKDOWN = /\.(md|markdown|mdx|mdown)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

/** Como mostrar um arquivo pelo nome. */
export function fileKind(path: string): 'markdown' | 'image' | 'code' {
  if (MARKDOWN.test(path)) return 'markdown';
  if (IMAGE.test(path)) return 'image';
  return 'code';
}

/** Linguagem do realce de sintaxe pela extensão (ou pelo nome, para Dockerfile e afins). */
export function langOf(path: string): string {
  const file = (path.split('/').pop() ?? path).toLowerCase();
  if (file === 'dockerfile' || file.startsWith('dockerfile.')) return 'shell';
  if (file === 'makefile') return 'shell';
  const ext = /\.([a-z0-9+]+)$/.exec(file)?.[1] ?? '';
  const alias: Record<string, string> = { yml: 'yaml', htm: 'html', vue: 'html', svelte: 'html' };
  return alias[ext] ?? ext;
}

/** Texto que parece binário: tem NUL nos primeiros 8 KB. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8192).includes('\u0000');
}

/** Número com uma casa decimal no idioma atual: 1.2 em inglês, 1,2 em pt-BR. */
function oneDecimal(value: number): string {
  return value.toLocaleString(currentLocale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    useGrouping: false,
  });
}

/** Tamanho legível: 820 B, 12.4 KB, 3.1 MB (12,4 KB em pt-BR). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${oneDecimal(value)} ${units[unit] ?? 'GB'}`;
}

/** Contador curto: 999, 1.2k, 34k, 1.2M (1,2 mil, 34 mil, 1,2 mi em pt-BR). */
export function formatCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return l10n.t('{0}k', oneDecimal(count / 1000));
  if (count < 1_000_000) return l10n.t('{0}k', String(Math.round(count / 1000)));
  return l10n.t('{0}M', oneDecimal(count / 1_000_000));
}

/** "now", "5 min ago", "3 h ago", "2 days ago", "4 months ago", "2 years ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return l10n.t('now');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return l10n.t('{0} min ago', String(minutes));
  const hours = Math.round(minutes / 60);
  if (hours < 24) return l10n.t('{0} h ago', String(hours));
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? l10n.t('yesterday') : l10n.t('{0} days ago', String(days));
  const months = Math.round(days / 30.4);
  if (months < 12) {
    return months === 1 ? l10n.t('1 month ago') : l10n.t('{0} months ago', String(months));
  }
  const years = Math.round(days / 365);
  return years === 1 ? l10n.t('1 year ago') : l10n.t('{0} years ago', String(years));
}

/** Duração de um job: 42 s, 3 min 05 s, 1 h 02 min. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60).padStart(2, '0')} min`;
}
