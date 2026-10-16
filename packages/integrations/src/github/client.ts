import { HttpError, readBody, type FetchLike } from '../http.js';
import { explainGitHubError, rateLimitError } from './errors.js';
import type {
  GhAccountItem,
  GhAccountRun,
  GhBranch,
  GhCheckRun,
  GhComment,
  GhCommit,
  GhContent,
  GhIssue,
  GhJob,
  GhNotification,
  GhOrg,
  GhProfile,
  GhProfileExtras,
  GhPull,
  GhPullFile,
  GhRelease,
  GhRepo,
  GhRepoRef,
  GhReview,
  GhSearchItem,
  GhUser,
  GhWorkflowRun,
  MergeMethod,
  ReviewEvent,
} from './types.js';

export const GITHUB_API = 'https://api.github.com';

export interface GitHubClientOptions {
  /** Token atual; lido a cada pedido, para um novo login valer na hora. */
  readonly token: () => string | undefined;
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  /** Relógio injetável, para testar o limite de requisições. */
  readonly now?: () => number;
}

interface Cached {
  readonly etag: string;
  readonly body: unknown;
  readonly link: string | undefined;
}

interface Limit {
  readonly remaining: number;
  readonly resetAt: number;
}

const CACHE_LIMIT = 500;

/** `dono/nome` de um repositório. */
export function repoPath(repo: GhRepoRef): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** Próxima página do cabeçalho `Link`, se houver. */
export function nextLink(link: string | null | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Executa `fn` sobre os itens com no máximo `limit` chamadas ao mesmo tempo, mantendo a ordem. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** `dono/nome` a partir da `repository_url` de um item da busca. */
export function repoFromApiUrl(url: string): string {
  return /\/repos\/([^/]+\/[^/]+)$/.exec(url)?.[1] ?? url;
}

/** `dono/nome` como referência de repositório; `undefined` se não tiver esse formato. */
export function parseRepoName(full: string): GhRepoRef | undefined {
  const [owner, name, ...rest] = full.split('/');
  return owner && name && rest.length === 0 ? { owner, name } : undefined;
}

/** Recortes da busca da conta (`search/issues`). */
export type AccountSearch = 'reviewRequested' | 'assigned' | 'authored' | 'involves' | 'mentioned';

/** Consulta de `search/issues` para uma visão da conta, em aberto por padrão. */
export function accountQuery(
  kind: AccountSearch,
  type: 'pr' | 'issue' | 'all',
  state: 'open' | 'closed' | 'all' = 'open',
): string {
  const qualifier = {
    reviewRequested: 'review-requested:@me',
    assigned: 'assignee:@me',
    authored: 'author:@me',
    involves: 'involves:@me',
    mentioned: 'mentions:@me',
  }[kind];
  const parts = [qualifier, 'archived:false'];
  if (type === 'pr') parts.unshift('is:pr');
  else if (type === 'issue') parts.unshift('is:issue');
  if (state !== 'all') parts.unshift(`is:${state}`);
  return parts.join(' ');
}

/** URL da web de uma notificação (a API manda a URL da API). */
export function notificationUrl(n: GhNotification): string {
  const api = n.subject.url;
  if (!api) return n.repository.html_url;
  return api
    .replace('https://api.github.com/repos/', 'https://github.com/')
    .replace(/\/pulls\/(\d+)$/, '/pull/$1')
    .replace(/\/commits\/([0-9a-f]+)$/, '/commit/$1');
}

/** Item da busca com o repositório e o tipo (PR ou issue) já resolvidos. */
export function toAccountItem(item: GhSearchItem): GhAccountItem {
  return {
    repo: repoFromApiUrl(item.repository_url),
    kind: item.pull_request ? 'pr' : 'issue',
    number: item.number,
    title: item.title,
    state: item.state,
    draft: item.draft ?? false,
    author: item.user?.login,
    labels: item.labels.map((label) => (typeof label === 'string' ? label : label.name)),
    comments: item.comments,
    url: item.html_url,
    updatedAt: item.updated_at,
  };
}

/** Uma página de uma listagem e se o GitHub indicou uma próxima. */
export interface ListPage<T> {
  readonly items: T[];
  readonly hasMore: boolean;
}

export interface PageOptions {
  /** Máximo de páginas seguidas pelo `Link` (padrão 3). */
  readonly maxPages?: number;
}

export interface SearchOptions extends PageOptions {
  readonly perPage?: number;
}

export interface RecentRunsOptions {
  /** Repositórios a olhar; sem isso, os mais recentemente ativos da conta. */
  readonly repos?: readonly GhRepoRef[];
  /** Quantos repositórios entram no fan-out (padrão 12). */
  readonly maxRepos?: number;
  /** Execuções por repositório (padrão 5). */
  readonly perRepo?: number;
  /** Chamadas simultâneas (padrão 4). */
  readonly concurrency?: number;
  /** `status` da API: queued, in_progress, completed, success, failure... */
  readonly status?: string;
  readonly branch?: string;
  /** Total devolvido, mais recentes primeiro (padrão 50). */
  readonly limit?: number;
}

export interface RecentRuns {
  readonly runs: GhAccountRun[];
  /** Repositórios que falharam (SSO, Actions desligado, sem acesso). */
  readonly errors: { readonly repo: string; readonly message: string }[];
  /** Repositórios consultados. */
  readonly repos: number;
}

/**
 * Cliente REST mínimo da API do GitHub (SDD 11.1, ADR 0020). Pedidos GET usam
 * ETag: uma resposta 304 não conta no limite de requisições e devolve o corpo
 * guardado, então o polling dos painéis sai barato. Segue a paginação por
 * `Link`, respeita o limite de requisições (devolve o cache em vez de
 * insistir) e explica erros de SSO, token fine-grained e escopo.
 */
export class GitHubClient {
  private readonly cache = new Map<string, Cached>();
  private readonly limits = new Map<string, Limit>();
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly now: () => number;
  /** Pedidos restantes na janela atual, quando a API informou. */
  rateRemaining: number | undefined;

  constructor(private readonly options: GitHubClientOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? GITHUB_API).replace(/\/+$/, '');
    this.now = options.now ?? Date.now;
  }

  get authenticated(): boolean {
    return Boolean(this.options.token());
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.options.token();
    if (!token) throw new HttpError(401, 'sem login no GitHub');
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': this.options.userAgent ?? 'FaKL-Code',
      ...extra,
    };
  }

  private url(path: string): string {
    if (!path.startsWith('https://')) return `${this.baseUrl}${path}`;
    // O token só vai para a API configurada, nunca para uma URL de terceiros.
    if (new URL(path).origin !== new URL(this.baseUrl).origin) {
      throw new HttpError(400, 'URL fora da API do GitHub');
    }
    return path;
  }

  private resourceOf(url: string): string {
    return url.startsWith(`${this.baseUrl}/search/`) ? 'search' : 'core';
  }

  /** Quando o limite do recurso volta (ms), se ele estiver esgotado agora. */
  limitedUntil(resource = 'core'): number | undefined {
    const limit = this.limits.get(resource);
    return limit && limit.remaining <= 0 && limit.resetAt > this.now() ? limit.resetAt : undefined;
  }

  private trackLimit(response: Response, fallback: string): void {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === null) return;
    this.rateRemaining = Number(remaining);
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    this.limits.set(response.headers.get('x-ratelimit-resource') ?? fallback, {
      remaining: Number(remaining),
      resetAt: Number.isFinite(reset) ? reset * 1000 : 0,
    });
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: unknown; link: string | undefined }> {
    const url = this.url(path);
    const cached = method === 'GET' ? this.cache.get(url) : undefined;
    const resource = this.resourceOf(url);
    const blockedUntil = this.limitedUntil(resource);
    if (blockedUntil !== undefined) {
      // Sem insistir na API: o que já foi lido ainda serve, o resto espera.
      if (cached) return { data: cached.body, link: cached.link };
      throw rateLimitError(blockedUntil, this.now());
    }
    const response = await this.fetch(url, {
      method,
      headers: this.headers({
        ...(cached ? { 'if-none-match': cached.etag } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.trackLimit(response, resource);
    if (response.status === 304 && cached) return { data: cached.body, link: cached.link };
    const data = await readBody(response);
    if (!response.ok) throw explainGitHubError(response.status, response.headers, data, this.now());
    const etag = response.headers.get('etag');
    const link = response.headers.get('link') ?? undefined;
    if (method === 'GET' && etag) {
      if (this.cache.size >= CACHE_LIMIT) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(url, { etag, body: data, link });
    }
    return { data, link };
  }

  /** Pedido cru; útil para endpoints sem método próprio. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.send(method, path, body)).data as T;
  }

  /**
   * Junta as páginas de uma listagem seguindo `Link: rel="next"`. `pick` tira a
   * lista do corpo (as buscas devolvem `{ items }`).
   */
  async paginate<T>(
    path: string,
    options: PageOptions & { readonly pick?: (body: unknown) => T[] } = {},
  ): Promise<T[]> {
    const pick = options.pick ?? ((body: unknown) => body as T[]);
    const out: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < (options.maxPages ?? 3); page++) {
      const { data, link } = await this.send('GET', next);
      out.push(...pick(data));
      next = nextLink(link);
    }
    return out;
  }

  /** Texto cru, como o log de um job (a API redireciona para o arquivo). */
  async text(path: string, accept = 'application/vnd.github.raw'): Promise<string> {
    const response = await this.fetch(this.url(path), {
      headers: this.headers({ accept }),
      redirect: 'follow',
    });
    if (!response.ok) {
      throw explainGitHubError(response.status, response.headers, await readBody(response));
    }
    return await response.text();
  }

  user(): Promise<GhUser> {
    return this.request('GET', '/user');
  }

  repo(repo: GhRepoRef): Promise<GhRepo> {
    return this.request('GET', `/repos/${repoPath(repo)}`);
  }

  // ----------------------------------------------------------------- conta

  /**
   * Repositórios a que a conta tem acesso (próprios, de colaboração e de
   * organizações), mais recentemente ativos primeiro.
   */
  userRepos(options: PageOptions & { readonly perPage?: number } = {}): Promise<GhRepo[]> {
    return this.paginate(
      `/user/repos?per_page=${String(options.perPage ?? 100)}&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member`,
      options,
    );
  }

  /** Organizações da conta. */
  userOrgs(options: PageOptions = {}): Promise<GhOrg[]> {
    return this.paginate('/user/orgs?per_page=100', options);
  }

  /** Repositórios de uma organização que a conta enxerga. */
  orgRepos(org: string, options: PageOptions = {}): Promise<GhRepo[]> {
    return this.paginate(
      `/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=pushed&direction=desc`,
      options,
    );
  }

  /** `search/issues`: issues e PRs de todos os repositórios, mais recentes primeiro. */
  async searchIssues(
    query: string,
    options: SearchOptions = {},
  ): Promise<{ total: number; items: GhSearchItem[] }> {
    let total = 0;
    const items = await this.paginate<GhSearchItem>(
      `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${String(options.perPage ?? 50)}`,
      {
        maxPages: options.maxPages ?? 1,
        pick: (data) => {
          const body = data as { total_count: number; items: GhSearchItem[] };
          total = body.total_count;
          return body.items;
        },
      },
    );
    return { total, items };
  }

  /** Visão da conta: PRs/issues ligados ao usuário (`@me`), de todos os repositórios. */
  async accountItems(
    kind: AccountSearch,
    type: 'pr' | 'issue' | 'all',
    options: SearchOptions & { readonly state?: 'open' | 'closed' | 'all' } = {},
  ): Promise<{ total: number; items: GhAccountItem[] }> {
    const result = await this.searchIssues(accountQuery(kind, type, options.state), options);
    return { total: result.total, items: result.items.map(toAccountItem) };
  }

  /**
   * Execuções recentes do Actions de vários repositórios. Sem `repos`, olha os
   * repositórios mais recentemente ativos da conta (poucos, com concorrência
   * limitada, para não gastar o limite da API). Falhas por repositório não
   * derrubam o conjunto: voltam em `errors`.
   */
  async recentRuns(options: RecentRunsOptions = {}): Promise<RecentRuns> {
    const maxRepos = options.maxRepos ?? 12;
    let targets: GhRepoRef[];
    if (options.repos) {
      targets = options.repos.slice(0, maxRepos);
    } else {
      const repos = await this.userRepos({ maxPages: 1, perPage: 100 });
      targets = repos
        .filter((repo) => !repo.archived)
        .slice(0, maxRepos)
        .flatMap((repo) => parseRepoName(repo.full_name) ?? []);
    }
    const perRepo = options.perRepo ?? 5;
    const errors: { repo: string; message: string }[] = [];
    const lists = await mapLimit(targets, options.concurrency ?? 4, async (repo) => {
      const full = `${repo.owner}/${repo.name}`;
      try {
        const query = [
          `per_page=${String(perRepo)}`,
          ...(options.branch ? [`branch=${encodeURIComponent(options.branch)}`] : []),
          ...(options.status ? [`status=${encodeURIComponent(options.status)}`] : []),
        ].join('&');
        const page = await this.request<{ workflow_runs: GhWorkflowRun[] }>(
          'GET',
          `/repos/${repoPath(repo)}/actions/runs?${query}`,
        );
        return page.workflow_runs.map((run): GhAccountRun => ({ ...run, repo: full }));
      } catch (error) {
        errors.push({
          repo: full,
          message: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    });
    const runs = lists
      .flat()
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, options.limit ?? 50);
    return { runs, errors, repos: targets.length };
  }

  // ------------------------------------------------------------------ PRs

  pulls(
    repo: GhRepoRef,
    state: 'open' | 'closed' | 'all' = 'open',
    perPage = 50,
  ): Promise<GhPull[]> {
    return this.request(
      'GET',
      `/repos/${repoPath(repo)}/pulls?state=${state}&per_page=${String(perPage)}&sort=updated&direction=desc`,
    );
  }

  pull(repo: GhRepoRef, number: number): Promise<GhPull> {
    return this.request('GET', `/repos/${repoPath(repo)}/pulls/${String(number)}`);
  }

  pullFiles(repo: GhRepoRef, number: number): Promise<GhPullFile[]> {
    return this.paginate(`/repos/${repoPath(repo)}/pulls/${String(number)}/files?per_page=100`, {
      maxPages: 3,
    });
  }

  pullReviews(repo: GhRepoRef, number: number): Promise<GhReview[]> {
    return this.request('GET', `/repos/${repoPath(repo)}/pulls/${String(number)}/reviews`);
  }

  createPull(
    repo: GhRepoRef,
    pull: { title: string; head: string; base: string; body?: string; draft?: boolean },
  ): Promise<GhPull> {
    return this.request('POST', `/repos/${repoPath(repo)}/pulls`, pull);
  }

  reviewPull(
    repo: GhRepoRef,
    number: number,
    event: ReviewEvent,
    body?: string,
  ): Promise<GhReview> {
    return this.request('POST', `/repos/${repoPath(repo)}/pulls/${String(number)}/reviews`, {
      event,
      ...(body ? { body } : {}),
    });
  }

  mergePull(
    repo: GhRepoRef,
    number: number,
    method: MergeMethod = 'squash',
    title?: string,
  ): Promise<{ merged: boolean; sha?: string; message: string }> {
    return this.request('PUT', `/repos/${repoPath(repo)}/pulls/${String(number)}/merge`, {
      merge_method: method,
      ...(title ? { commit_title: title } : {}),
    });
  }

  // --------------------------------------------------------------- issues

  /** Issues sem os PRs, que a API devolve misturados. */
  async issues(
    repo: GhRepoRef,
    state: 'open' | 'closed' | 'all' = 'open',
    perPage = 50,
  ): Promise<GhIssue[]> {
    const list = await this.request<GhIssue[]>(
      'GET',
      `/repos/${repoPath(repo)}/issues?state=${state}&per_page=${String(perPage)}&sort=updated`,
    );
    return list.filter((issue) => !issue.pull_request);
  }

  issue(repo: GhRepoRef, number: number): Promise<GhIssue> {
    return this.request('GET', `/repos/${repoPath(repo)}/issues/${String(number)}`);
  }

  comments(repo: GhRepoRef, number: number): Promise<GhComment[]> {
    return this.paginate(
      `/repos/${repoPath(repo)}/issues/${String(number)}/comments?per_page=100`,
      { maxPages: 3 },
    );
  }

  /** Comenta numa issue ou num PR (a conversa do PR é a da issue). */
  comment(repo: GhRepoRef, number: number, body: string): Promise<GhComment> {
    return this.request('POST', `/repos/${repoPath(repo)}/issues/${String(number)}/comments`, {
      body,
    });
  }

  createIssue(
    repo: GhRepoRef,
    issue: { title: string; body?: string; labels?: string[] },
  ): Promise<GhIssue> {
    return this.request('POST', `/repos/${repoPath(repo)}/issues`, issue);
  }

  addLabels(repo: GhRepoRef, number: number, labels: readonly string[]): Promise<unknown> {
    return this.request('POST', `/repos/${repoPath(repo)}/issues/${String(number)}/labels`, {
      labels,
    });
  }

  // -------------------------------------------------------------- Actions

  /**
   * Dispara um workflow com `workflow_dispatch`. Com `return_run_details`, a
   * API devolve o link da execução; sem ele (GitHub Enterprise antigo), nada.
   */
  async dispatchWorkflow(
    repo: GhRepoRef,
    workflow: string,
    ref: string,
    inputs: Readonly<Record<string, string>> = {},
  ): Promise<{ html_url?: string }> {
    const result = await this.request<{ html_url?: string } | string | undefined>(
      'POST',
      `/repos/${repoPath(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      { ref, inputs, return_run_details: true },
    );
    return result && typeof result === 'object' ? result : {};
  }

  async runs(repo: GhRepoRef, branch?: string, perPage = 30): Promise<GhWorkflowRun[]> {
    const query = `per_page=${String(perPage)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`;
    const page = await this.request<{ workflow_runs: GhWorkflowRun[] }>(
      'GET',
      `/repos/${repoPath(repo)}/actions/runs?${query}`,
    );
    return page.workflow_runs;
  }

  async jobs(repo: GhRepoRef, runId: number): Promise<GhJob[]> {
    const page = await this.request<{ jobs: GhJob[] }>(
      'GET',
      `/repos/${repoPath(repo)}/actions/runs/${String(runId)}/jobs?per_page=100`,
    );
    return page.jobs;
  }

  jobLog(repo: GhRepoRef, jobId: number): Promise<string> {
    return this.text(`/repos/${repoPath(repo)}/actions/jobs/${String(jobId)}/logs`);
  }

  rerun(repo: GhRepoRef, runId: number, failedOnly = false): Promise<unknown> {
    return this.request(
      'POST',
      `/repos/${repoPath(repo)}/actions/runs/${String(runId)}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`,
    );
  }

  // ------------------------------------------------- releases e notificações

  releases(repo: GhRepoRef, perPage = 20): Promise<GhRelease[]> {
    return this.request('GET', `/repos/${repoPath(repo)}/releases?per_page=${String(perPage)}`);
  }

  notifications(all = false, options: PageOptions = {}): Promise<GhNotification[]> {
    return this.paginate(`/notifications?per_page=50${all ? '&all=true' : ''}`, options);
  }

  markNotificationRead(threadId: string): Promise<unknown> {
    return this.request('PATCH', `/notifications/threads/${encodeURIComponent(threadId)}`);
  }

  /** Marca todas as notificações como lidas (opcionalmente só as de um repositório). */
  markNotificationsRead(repo?: GhRepoRef): Promise<unknown> {
    return this.request('PUT', repo ? `/repos/${repoPath(repo)}/notifications` : '/notifications', {
      last_read_at: new Date(this.now()).toISOString(),
    });
  }

  /** Conteúdo de um arquivo num commit ou branch; `undefined` se não existir. */
  async fileAt(repo: GhRepoRef, path: string, ref: string): Promise<string | undefined> {
    try {
      return await this.text(
        `/repos/${repoPath(repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  // ------------------------------------------------- navegação do painel

  /**
   * Pasta (lista, pastas primeiro) ou arquivo (um item) de um caminho. Sem
   * `ref`, o branch padrão.
   */
  async contents(repo: GhRepoRef, path = '', ref?: string): Promise<GhContent[] | GhContent> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const data = await this.request<GhContent[] | GhContent>(
      'GET',
      `/repos/${repoPath(repo)}/contents/${encodePath(path)}${query}`,
    );
    if (!Array.isArray(data)) return data;
    return [...data].sort(
      (a, b) =>
        Number(b.type === 'dir') - Number(a.type === 'dir') ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  /**
   * Markdown cru do README de uma pasta (a raiz, por padrão), com o caminho
   * dele para resolver links relativos; `undefined` se não houver README.
   */
  async readme(
    repo: GhRepoRef,
    ref?: string,
    dir = '',
  ): Promise<{ path: string; text: string } | undefined> {
    const suffix = `${dir ? `/${encodePath(dir)}` : ''}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
    try {
      const info = await this.request<GhContent>('GET', `/repos/${repoPath(repo)}/readme${suffix}`);
      return { path: info.path, text: decodeContent(info) };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Commits de um branch, opcionalmente só os que mexeram num caminho. */
  commits(
    repo: GhRepoRef,
    options: { ref?: string; path?: string; perPage?: number } = {},
  ): Promise<GhCommit[]> {
    const query = [
      `per_page=${String(options.perPage ?? 20)}`,
      ...(options.ref ? [`sha=${encodeURIComponent(options.ref)}`] : []),
      ...(options.path ? [`path=${encodeURIComponent(options.path)}`] : []),
    ].join('&');
    return this.request<GhCommit[]>('GET', `/repos/${repoPath(repo)}/commits?${query}`);
  }

  branches(repo: GhRepoRef): Promise<GhBranch[]> {
    return this.paginate(`/repos/${repoPath(repo)}/branches?per_page=100`, { maxPages: 2 });
  }

  /** Bytes por linguagem, maior primeiro. */
  languages(repo: GhRepoRef): Promise<Record<string, number>> {
    return this.request('GET', `/repos/${repoPath(repo)}/languages`);
  }

  contributors(repo: GhRepoRef, perPage = 12): Promise<GhUser[]> {
    return this.request('GET', `/repos/${repoPath(repo)}/contributors?per_page=${String(perPage)}`);
  }

  /** Busca de repositórios no GitHub inteiro (`search/repositories`). */
  async searchRepos(query: string, perPage = 20): Promise<{ total: number; items: GhRepo[] }> {
    const body = await this.request<{ total_count: number; items: GhRepo[] }>(
      'GET',
      `/search/repositories?q=${encodeURIComponent(query)}&per_page=${String(perPage)}`,
    );
    return { total: body.total_count, items: body.items };
  }

  /** Perfil de um usuário ou organização. */
  profile(login: string): Promise<GhProfile> {
    return this.request('GET', `/users/${encodeURIComponent(login)}`);
  }

  /** Repositórios públicos de um usuário, mais recentemente ativos primeiro. */
  ownerRepos(login: string, perPage = 30): Promise<GhRepo[]> {
    return this.request(
      'GET',
      `/users/${encodeURIComponent(login)}/repos?sort=pushed&direction=desc&per_page=${String(perPage)}`,
    );
  }

  // ------------------------------------------------ listas página a página

  /**
   * Uma página de uma listagem, com `hasMore` pelo cabeçalho `Link` (não pelo
   * tamanho, que engana quando a lista é filtrada, como issues sem PRs).
   */
  async listPage<T>(
    path: string,
    pick: (body: unknown) => T[] = (body) => body as T[],
  ): Promise<ListPage<T>> {
    const { data, link } = await this.send('GET', path);
    return { items: pick(data), hasMore: nextLink(link) !== undefined };
  }

  /** Issues (sem PRs) de um repositório, página `page`. */
  async issuesPage(
    repo: GhRepoRef,
    state: 'open' | 'closed',
    page: number,
    perPage = 30,
  ): Promise<ListPage<GhIssue>> {
    const result = await this.listPage<GhIssue>(
      `/repos/${repoPath(repo)}/issues?state=${state}&per_page=${String(perPage)}&page=${String(page)}&sort=updated`,
    );
    return { ...result, items: result.items.filter((issue) => !issue.pull_request) };
  }

  pullsPage(
    repo: GhRepoRef,
    state: 'open' | 'closed',
    page: number,
    perPage = 30,
  ): Promise<ListPage<GhPull>> {
    return this.listPage(
      `/repos/${repoPath(repo)}/pulls?state=${state}&per_page=${String(perPage)}&page=${String(page)}&sort=updated&direction=desc`,
    );
  }

  runsPage(repo: GhRepoRef, page: number, perPage = 30): Promise<ListPage<GhWorkflowRun>> {
    return this.listPage(
      `/repos/${repoPath(repo)}/actions/runs?per_page=${String(perPage)}&page=${String(page)}`,
      (body) => (body as { workflow_runs: GhWorkflowRun[] }).workflow_runs,
    );
  }

  releasesPage(repo: GhRepoRef, page: number, perPage = 10): Promise<ListPage<GhRelease>> {
    return this.listPage(
      `/repos/${repoPath(repo)}/releases?per_page=${String(perPage)}&page=${String(page)}`,
    );
  }

  async searchReposPage(
    query: string,
    page: number,
    perPage = 30,
  ): Promise<ListPage<GhRepo> & { total: number }> {
    let total = 0;
    const result = await this.listPage<GhRepo>(
      `/search/repositories?q=${encodeURIComponent(query)}&per_page=${String(perPage)}&page=${String(page)}`,
      (body) => {
        const data = body as { total_count: number; items: GhRepo[] };
        total = data.total_count;
        return data.items;
      },
    );
    return { ...result, total };
  }

  /**
   * Repositórios de um dono: `mine` usa `/user/repos` (inclui os privados do
   * próprio usuário), `org` a lista da organização e `user` os públicos.
   */
  ownerReposPage(
    login: string,
    kind: 'mine' | 'org' | 'user',
    page: number,
    perPage = 30,
  ): Promise<ListPage<GhRepo>> {
    const query = `sort=pushed&direction=desc&per_page=${String(perPage)}&page=${String(page)}`;
    const path =
      kind === 'mine'
        ? `/user/repos?affiliation=owner&${query}`
        : kind === 'org'
          ? `/orgs/${encodeURIComponent(login)}/repos?${query}`
          : `/users/${encodeURIComponent(login)}/repos?${query}`;
    return this.listPage(path);
  }

  /**
   * Todos os repositórios de um dono, de 100 em 100, até `maxPages` páginas
   * (o perfil filtra e ordena a lista inteira). `hasMore` diz se parou no limite.
   */
  async ownerReposAll(
    login: string,
    kind: 'mine' | 'org' | 'user',
    maxPages = 5,
  ): Promise<ListPage<GhRepo>> {
    const items: GhRepo[] = [];
    let hasMore = true;
    for (let page = 1; hasMore && page <= maxPages; page++) {
      const result = await this.ownerReposPage(login, kind, page, 100);
      items.push(...result.items);
      hasMore = result.hasMore;
    }
    return { items, hasMore };
  }

  /** Repositórios com estrela de um usuário, mais recentes primeiro. */
  starredPage(login: string, page: number, perPage = 30): Promise<ListPage<GhRepo>> {
    return this.listPage(
      `/users/${encodeURIComponent(login)}/starred?per_page=${String(perPage)}&page=${String(page)}`,
    );
  }

  /**
   * Pessoas de um perfil: seguidores e seguidos de um usuário ou membros de uma
   * organização (os ocultos só aparecem para quem também é membro).
   */
  peoplePage(
    login: string,
    kind: 'followers' | 'following' | 'members',
    page: number,
    perPage = 30,
  ): Promise<ListPage<GhUser>> {
    const base =
      kind === 'members'
        ? `/orgs/${encodeURIComponent(login)}/members`
        : `/users/${encodeURIComponent(login)}/${kind}`;
    return this.listPage(`${base}?per_page=${String(perPage)}&page=${String(page)}`);
  }

  /** Organizações de um usuário: todas para a própria conta, as públicas para os outros. */
  profileOrgs(login: string, mine: boolean): Promise<GhOrg[]> {
    return this.request(
      'GET',
      mine ? '/user/orgs?per_page=100' : `/users/${encodeURIComponent(login)}/orgs?per_page=100`,
    );
  }

  /** Fixados e total de estrelas de um perfil, pelo GraphQL (a REST não expõe). */
  async profileExtras(login: string): Promise<GhProfileExtras> {
    const body = await this.request<{
      data?: { repositoryOwner?: ProfileOwnerNode | null } | null;
      errors?: readonly { message: string }[];
    }>('POST', '/graphql', { query: PROFILE_QUERY, variables: { login } });
    const owner = body.data?.repositoryOwner;
    if (!owner) {
      if (body.errors?.length) throw new HttpError(400, body.errors[0]?.message ?? 'GraphQL');
      return { pinned: [] };
    }
    const pinned = (owner.pinnedItems?.nodes ?? []).flatMap((node) =>
      node?.nameWithOwner ? [pinnedRepo(node)] : [],
    );
    const stars = owner.starredRepositories?.totalCount;
    return { pinned, ...(stars === undefined ? {} : { stars }) };
  }

  /** Tags do repositório (para separar ref e caminho em URLs com `/`). */
  tags(repo: GhRepoRef): Promise<{ name: string }[]> {
    return this.paginate(`/repos/${repoPath(repo)}/tags?per_page=100`, { maxPages: 2 });
  }

  /** Uma execução do Actions. */
  run(repo: GhRepoRef, runId: number): Promise<GhWorkflowRun> {
    return this.request('GET', `/repos/${repoPath(repo)}/actions/runs/${String(runId)}`);
  }

  /** Check runs de um commit (o estado do CI de um PR). */
  async checkRuns(repo: GhRepoRef, sha: string): Promise<GhCheckRun[]> {
    const page = await this.request<{ check_runs: GhCheckRun[] }>(
      'GET',
      `/repos/${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
    );
    return page.check_runs;
  }
}

const PROFILE_QUERY = `query($login: String!) {
  repositoryOwner(login: $login) {
    ... on ProfileOwner {
      pinnedItems(first: 6, types: REPOSITORY) {
        nodes {
          ... on Repository {
            nameWithOwner url description isPrivate isFork isArchived
            stargazerCount forkCount pushedAt
            defaultBranchRef { name }
            primaryLanguage { name color }
          }
        }
      }
    }
    ... on User { starredRepositories { totalCount } }
  }
}`;

interface PinnedNode {
  readonly nameWithOwner?: string;
  readonly url: string;
  readonly description?: string | null;
  readonly isPrivate: boolean;
  readonly isFork: boolean;
  readonly isArchived: boolean;
  readonly stargazerCount: number;
  readonly forkCount: number;
  readonly pushedAt?: string | null;
  readonly defaultBranchRef?: { readonly name: string } | null;
  readonly primaryLanguage?: { readonly name: string; readonly color?: string | null } | null;
}

interface ProfileOwnerNode {
  readonly pinnedItems?: { readonly nodes?: readonly (PinnedNode | null)[] } | null;
  readonly starredRepositories?: { readonly totalCount: number } | null;
}

/** Repositório fixado (GraphQL) no formato da REST. */
function pinnedRepo(node: PinnedNode): GhRepo {
  return {
    full_name: node.nameWithOwner ?? '',
    default_branch: node.defaultBranchRef?.name ?? '',
    private: node.isPrivate,
    html_url: node.url,
    description: node.description ?? null,
    fork: node.isFork,
    archived: node.isArchived,
    pushed_at: node.pushedAt ?? null,
    language: node.primaryLanguage?.name ?? null,
    language_color: node.primaryLanguage?.color ?? null,
    stargazers_count: node.stargazerCount,
    forks_count: node.forkCount,
  };
}

/** Texto de um item de `contents` que veio em base64 (a API quebra em linhas). */
export function decodeContent(item: GhContent): string {
  if (item.content === undefined) return '';
  if (item.encoding !== 'base64') return item.content;
  const binary = atob(item.content.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Caminho de um arquivo na URL, com cada parte codificada e as barras mantidas. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Dono e nome a partir da URL de um remoto do git: HTTPS, `git@github.com:`
 * ou `ssh://`. Devolve `undefined` para remotos fora do github.com.
 */
export function parseGitHubRemote(url: string): GhRepoRef | undefined {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  if (!match?.[1] || !match[2]) return undefined;
  return { owner: match[1], name: match[2] };
}
