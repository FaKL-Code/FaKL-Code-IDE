import { randomBytes } from 'node:crypto';

import { l10n } from '@fakl/i18n';
import {
  decodeContent,
  GitHubError,
  HttpError,
  type GhIssue,
  type GhJob,
  type GhProfileExtras,
  type GhPull,
  type GhPullFile,
  type GhRepo,
  type GhRepoRef,
  type GhWorkflowRun,
} from '@fakl/integrations';
import * as vscode from 'vscode';

import type { GitHubAuth } from './github-auth.js';
import {
  accountRow,
  checkView,
  commitView,
  dirOf,
  entryView,
  fileKind,
  issueRow,
  jobView,
  labelView,
  langOf,
  languageShares,
  looksBinary,
  filterRepos,
  notificationGroups,
  notificationRow,
  parseFromWebview,
  person,
  popularRepos,
  profileView,
  pullRow,
  pullState,
  releaseView,
  repoFilters,
  repoHeader,
  repoLanguages,
  repoRow,
  RouteHistory,
  routeKey,
  routeTitle,
  runRow,
  sameUserTab,
  SessionCache,
  splitRefPath,
  timeline,
  userRoute,
} from './github-full-model.js';
import type {
  FullAction,
  FullFromWebview,
  FullToWebview,
  MoreRows,
  Page,
  Person,
  RepoBody,
  RepoHeader,
  RepoRow,
  Route,
  UserBody,
} from './github-full-protocol.js';

/** Arquivo do GitHub aberto no editor, só leitura: `fakl-gh-blob:/dono/nome/<caminho>?ref=`. */
const BLOB_SCHEME = 'fakl-gh-blob';
/** Acima disto, o painel não mostra o conteúdo (a API de contents para em 1 MB). */
const MAX_TEXT = 1024 * 1024;

/** Ações que reaproveitam a lógica da barra lateral (revisar, merge, checkout...). */
export interface FullActions {
  review(repo: GhRepoRef, pull: GhPull): Promise<void>;
  merge(repo: GhRepoRef, pull: GhPull): Promise<void>;
  checkout(repo: GhRepoRef, pull: GhPull): Promise<void>;
  toAgents(repo: GhRepoRef, issue: GhIssue): Promise<void>;
  rerun(repo: GhRepoRef, run: GhWorkflowRun): Promise<void>;
  jobLog(repo: GhRepoRef, run: GhWorkflowRun, job: GhJob): Promise<void>;
  openDiff(repo: GhRepoRef, pull: GhPull, file: GhPullFile): Promise<void>;
  clone(repo: GhRepoRef): Promise<void>;
  newIssue(repo: GhRepoRef): Promise<void>;
  folderOf(repo: GhRepoRef): Promise<vscode.WorkspaceFolder | undefined>;
  /** Atualiza as árvores da barra lateral depois de uma mudança feita no painel. */
  refreshTrees(): void;
}

/** O que a tela atual carregou: as ações da webview só valem sobre isto. */
interface Loaded {
  readonly route: Route;
  readonly repo?: GhRepoRef;
  readonly pull?: GhPull;
  readonly files?: readonly GhPullFile[];
  readonly issue?: GhIssue;
  readonly run?: GhWorkflowRun;
  readonly jobs?: readonly GhJob[];
  readonly file?: { readonly path: string; readonly ref: string };
  readonly notificationIds?: readonly string[];
  /** A lista paginada da tela, para "Carregar mais". */
  readonly more?: Pager;
}

/** Próximas páginas de uma lista; `page` é a última já mandada. */
interface Pager {
  page: number;
  readonly fetch: (page: number) => Promise<{ rows: MoreRows; hasMore: boolean }>;
}

type LoadResult = { readonly redirect: Route } | { readonly page: Page; readonly loaded: Loaded };

/** `notifications` lê até 2 páginas de 50; acima disso, o resto fica no GitHub. */
const NOTIFICATION_CAP = 100;
/** Linhas por página da aba Repositórios do perfil. */
const REPO_PAGE = 30;
/** Quanto tempo a lista de repositórios de um perfil vale sem ler a API de novo. */
const REPO_CACHE_MS = 2 * 60_000;

/** Repositórios de um dono já lidos, para filtrar e ordenar sem nova leitura. */
interface OwnerRepos {
  readonly rows: readonly RepoRow[];
  /** A leitura parou no limite de páginas. */
  readonly truncated: boolean;
}

function pager(fetch: Pager['fetch']): Pager {
  return { page: 1, fetch };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refOf(route: { readonly owner: string; readonly name: string }): GhRepoRef {
  return { owner: route.owner, name: route.name };
}

/**
 * GitHub em tela cheia (ADR 0030): um painel no editor, navegável, com telas
 * próprias para início, repositório (código, README, issues, PRs, Actions,
 * releases), arquivo, PR, issue, execução, notificações e perfil. Os dados vêm
 * da API pela extensão; a webview só recebe o que vai mostrar, nunca o token.
 * Um painel só, reaproveitado, com voltar e avançar.
 */
export class GitHubFullPanel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private history = new RouteHistory();
  private loaded: Loaded | undefined;
  /** Último carregamento pedido; respostas de pedidos anteriores são ignoradas. */
  private seq = 0;
  /** Presa à sessão: trocar de conta descarta até leituras que ainda estão correndo. */
  private readonly repoCache = new SessionCache<OwnerRepos>(REPO_CACHE_MS);

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly auth: GitHubAuth,
    private readonly actions: FullActions,
  ) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(BLOB_SCHEME, {
        provideTextDocumentContent: async (uri) => {
          const [, owner, name, ...path] = uri.path.split('/');
          const ref = new URLSearchParams(uri.query).get('ref') ?? 'HEAD';
          if (!owner || !name || path.length === 0) return '';
          return (await this.auth.api.fileAt({ owner, name }, path.join('/'), ref)) ?? '';
        },
      }),
      auth.onDidChange(() => {
        this.repoCache.invalidate();
        if (this.panel) void this.show(this.history.current);
      }),
    );
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  /** Abre o painel (ou traz para frente) e, com uma rota, navega até ela. */
  open(route?: Route): void {
    if (this.panel) {
      this.panel.reveal();
      if (route) this.navigate(route);
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'dist', 'github');
    const panel = vscode.window.createWebviewPanel(
      'fakl.github.full',
      'GitHub',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'github.svg');
    this.panel = panel;
    this.history = new RouteHistory(route ?? { view: 'home' });
    panel.webview.html = this.html(panel.webview, media);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseFromWebview(raw);
      if (message) void this.receive(message);
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.loaded = undefined;
    });
  }

  private navigate(route: Route): void {
    void this.show(this.history.push(route));
  }

  private async receive(message: FullFromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'reload':
        if (message.type === 'reload') this.repoCache.invalidate();
        await this.show(this.history.current);
        return;
      case 'navigate':
        // Só a busca da mesma lista troca a entrada; o resto empilha.
        if (message.replace && sameUserTab(this.history.current, message.route)) {
          this.history.replace(message.route);
          await this.show(message.route);
          return;
        }
        this.navigate(message.route);
        return;
      case 'back':
        await this.show(this.history.back());
        return;
      case 'forward':
        await this.show(this.history.forward());
        return;
      case 'external':
        await vscode.env.openExternal(vscode.Uri.parse(message.url, true));
        return;
      case 'action':
        await this.act(message.action);
        return;
      case 'comment':
        await this.comment(message);
        return;
      case 'more':
        await this.more(message.key);
        return;
      case 'openDiff': {
        const { repo, pull, files } = this.loaded ?? {};
        const file = files?.find((f) => f.filename === message.filename);
        if (repo && pull && file) await this.actions.openDiff(repo, pull, file);
        return;
      }
      case 'jobLog': {
        const { repo, run, jobs } = this.loaded ?? {};
        const job = jobs?.find((j) => j.id === message.jobId);
        if (repo && run && job) await this.actions.jobLog(repo, run, job);
        return;
      }
      case 'markRead':
        if (!this.loaded?.notificationIds?.includes(message.id)) return;
        await this.guard(
          (detail) => l10n.t('Could not mark the notification as read: {0}', detail),
          async () => {
            await this.auth.api.markNotificationRead(message.id);
            this.post({ type: 'markedRead', id: message.id });
            this.actions.refreshTrees();
          },
        );
        return;
    }
  }

  private async act(action: FullAction): Promise<void> {
    const loaded = this.loaded;
    const repo = loaded?.repo;
    const reload = async (): Promise<void> => {
      if (this.loaded === loaded) await this.show(this.history.current);
    };
    switch (action) {
      case 'login':
        await vscode.commands.executeCommand('fakl.github.login');
        return;
      case 'diagnose':
        await vscode.commands.executeCommand('fakl.github.diagnose');
        return;
      case 'markAllRead':
        await this.guard(
          (detail) => l10n.t('Could not mark all notifications as read: {0}', detail),
          async () => {
            await this.auth.api.markNotificationsRead();
            this.actions.refreshTrees();
            await reload();
          },
        );
        return;
      case 'clone':
        if (repo) await this.actions.clone(repo);
        return;
      case 'newIssue':
        if (repo) await this.actions.newIssue(repo);
        return;
      case 'openInEditor':
        await this.openInEditor();
        return;
      case 'review':
      case 'merge':
      case 'checkout':
        if (!repo || !loaded.pull) return;
        await this.actions[action](repo, loaded.pull);
        if (action !== 'checkout') await reload();
        return;
      case 'toAgents':
        if (repo && loaded.issue) await this.actions.toAgents(repo, loaded.issue);
        return;
      case 'rerun': {
        const run = loaded?.run;
        if (!repo || !run) return;
        const failedOnly = run.conclusion === 'failure';
        const workflow = run.name ?? 'workflow';
        const number = String(run.run_number);
        const where = `${repo.owner}/${repo.name}`;
        const ok = await vscode.window.showWarningMessage(
          failedOnly
            ? l10n.t('Re-run the failed jobs of {0} #{1} in {2}?', workflow, number, where)
            : l10n.t('Re-run {0} #{1} in {2}?', workflow, number, where),
          { modal: true },
          l10n.t('Re-run'),
        );
        if (!ok) return;
        await this.actions.rerun(repo, run);
        await reload();
        return;
      }
    }
  }

  /**
   * Comentário do compositor: só vale se a tela ainda for a mesma em que foi
   * escrito e o número for o do PR/issue carregado. A resposta volta pelo id.
   */
  private async comment(message: Extract<FullFromWebview, { type: 'comment' }>): Promise<void> {
    const loaded = this.loaded;
    const number = loaded?.pull?.number ?? loaded?.issue?.number;
    const reply = (ok: boolean, error?: string): void => {
      this.post({ type: 'commentResult', id: message.id, ok, ...(error ? { error } : {}) });
    };
    if (
      !loaded?.repo ||
      number === undefined ||
      number !== message.number ||
      routeKey(loaded.route) !== message.key
    ) {
      reply(
        false,
        l10n.t('The page changed since the comment was written. Refresh and try again.'),
      );
      return;
    }
    try {
      await this.auth.api.comment(loaded.repo, number, message.body);
    } catch (error) {
      reply(false, l10n.t('GitHub rejected the comment: {0}', explain(error).message));
      return;
    }
    reply(true);
    this.post({ type: 'notice', text: l10n.t('Comment posted on #{0}.', String(number)) });
    if (this.loaded === loaded) await this.show(this.history.current);
  }

  /** Próxima página da lista da tela atual. */
  private async more(key: string): Promise<void> {
    const pager = this.loaded?.more;
    if (!pager || !this.loaded || routeKey(this.loaded.route) !== key) return;
    try {
      const result = await pager.fetch(pager.page + 1);
      pager.page++;
      this.post({ type: 'more', key, ...result });
    } catch (error) {
      this.post({
        type: 'notice',
        text: l10n.t('Could not load more: {0}', explain(error).message),
      });
      this.post({ type: 'more', key, rows: { kind: 'items', items: [] }, hasMore: true });
    }
  }

  /** O arquivo aberto no painel vai para o editor: a cópia local, se houver, ou só leitura. */
  private async openInEditor(): Promise<void> {
    const { repo, file } = this.loaded ?? {};
    if (!repo || !file) return;
    const folder = await this.actions.folderOf(repo);
    const uri = folder
      ? vscode.Uri.joinPath(folder.uri, ...file.path.split('/'))
      : vscode.Uri.from({
          scheme: BLOB_SCHEME,
          path: `/${repo.owner}/${repo.name}/${file.path}`,
          query: `ref=${encodeURIComponent(file.ref)}`,
        });
    try {
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t('Could not open the file: {0}', message(error)));
    }
  }

  /** Roda `fn`; se falhar, mostra `fail` com o detalhe do erro. */
  private async guard(fail: (detail: string) => string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      void vscode.window.showErrorMessage(fail(message(error)));
    }
  }

  private post(message: FullToWebview): void {
    void this.panel?.webview.postMessage(message);
  }

  /** Mostra uma rota: avisa a webview (que mostra o esqueleto), carrega e manda a tela. */
  private async show(route: Route): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    const seq = ++this.seq;
    const key = routeKey(route);
    panel.title = routeTitle(route);
    this.post({
      type: 'navigate',
      route,
      canBack: this.history.canBack,
      canForward: this.history.canForward,
      ...(this.auth.signedIn && this.auth.user
        ? {
            viewer: {
              login: this.auth.user,
              avatar: `https://avatars.githubusercontent.com/${encodeURIComponent(this.auth.user)}`,
            },
          }
        : {}),
    });
    if (!this.auth.signedIn) {
      this.loaded = { route };
      this.post({ type: 'page', key, page: { view: 'signedOut' } });
      return;
    }
    try {
      const result = await this.load(route);
      if (seq !== this.seq) return;
      if ('redirect' in result) {
        this.history.replace(result.redirect);
        await this.show(result.redirect);
        return;
      }
      this.loaded = result.loaded;
      this.post({ type: 'page', key, page: result.page });
    } catch (error) {
      if (seq !== this.seq) return;
      this.loaded = { route };
      this.post({ type: 'error', key, ...explain(error) });
    }
  }

  private async load(route: Route): Promise<LoadResult> {
    const api = this.auth.api;
    switch (route.view) {
      case 'home': {
        const [me, reviews, mine, assigned, notifications, repos] = await Promise.all([
          api.user(),
          api.accountItems('reviewRequested', 'pr', { perPage: 8 }),
          api.accountItems('authored', 'pr', { perPage: 8 }),
          api.accountItems('assigned', 'issue', { perPage: 8 }),
          api
            .notifications(false, { maxPages: 1 })
            .then((list) => ({ list, error: undefined }))
            .catch((error: unknown) => ({ list: [], error: message(error) })),
          api.userRepos({ maxPages: 1, perPage: 12 }),
        ]);
        return {
          loaded: { route, notificationIds: notifications.list.map((n) => n.id) },
          page: {
            view: 'home',
            me: {
              login: me.login,
              ...(me.avatar_url ? { avatar: me.avatar_url } : {}),
              ...(me.name ? { name: me.name } : {}),
            },
            reviews: reviews.items.map(accountRow),
            mine: mine.items.map(accountRow),
            assigned: assigned.items.map(accountRow),
            totals: { reviews: reviews.total, mine: mine.total, assigned: assigned.total },
            notifications: notifications.list.slice(0, 8).map(notificationRow),
            ...(notifications.error ? { notificationsError: notifications.error } : {}),
            repos: repos.map(repoRow),
          },
        };
      }
      case 'search': {
        const fetch = async (page: number) => {
          const result = await api.searchReposPage(route.q, page);
          return { result, rows: { kind: 'repos' as const, repos: result.items.map(repoRow) } };
        };
        const first = await fetch(1);
        return {
          loaded: {
            route,
            more: pager(async (page) => {
              const next = await fetch(page);
              return { rows: next.rows, hasMore: next.result.hasMore };
            }),
          },
          page: {
            view: 'search',
            q: route.q,
            total: first.result.total,
            repos: first.rows.repos,
            hasMore: first.result.hasMore,
          },
        };
      }
      case 'notifications': {
        const list = await api.notifications(false, { maxPages: 2 });
        return {
          loaded: { route, notificationIds: list.map((n) => n.id) },
          page: {
            view: 'notifications',
            groups: notificationGroups(list),
            truncated: list.length >= NOTIFICATION_CAP,
          },
        };
      }
      case 'user':
        return await this.loadUser(route);
      case 'repo':
        return await this.loadRepo(route);
      case 'file':
        return await this.loadFile(route);
      case 'pull': {
        const repo = refOf(route);
        const [info, pull, comments, reviews, files] = await Promise.all([
          api.repo(repo),
          api.pull(repo, route.number),
          api.comments(repo, route.number),
          api.pullReviews(repo, route.number),
          api.pullFiles(repo, route.number),
        ]);
        const checks = await api.checkRuns(repo, pull.head.sha).catch(() => []);
        const author = person(pull.user);
        return {
          loaded: { route, repo, pull, files },
          page: {
            view: 'pull',
            repo: repoHeader(info),
            tab: route.tab,
            number: pull.number,
            title: pull.title,
            state: pullState(pull),
            ...(author ? { author } : {}),
            ...(pull.created_at ? { createdAt: pull.created_at } : {}),
            base: pull.base.ref,
            head: pull.head.ref,
            body: { markdown: pull.body ?? '', dir: '', ref: info.default_branch },
            labels: (pull.labels ?? []).map(labelView),
            additions: pull.additions ?? files.reduce((sum, f) => sum + f.additions, 0),
            deletions: pull.deletions ?? files.reduce((sum, f) => sum + f.deletions, 0),
            changedFiles: pull.changed_files ?? files.length,
            ...(typeof pull.mergeable === 'boolean' ? { mergeable: pull.mergeable } : {}),
            timeline: timeline(comments, reviews),
            files: files.map((f) => ({
              filename: f.filename,
              ...(f.previous_filename ? { previous: f.previous_filename } : {}),
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            })),
            checks: checks.map(checkView),
            url: pull.html_url,
          },
        };
      }
      case 'issue': {
        const repo = refOf(route);
        const [info, issue, comments] = await Promise.all([
          api.repo(repo),
          api.issue(repo, route.number),
          api.comments(repo, route.number),
        ]);
        // Um "issue" que é PR abre na tela de PR.
        if (issue.pull_request) {
          return { redirect: { view: 'pull', ...repo, number: issue.number, tab: 'conversation' } };
        }
        const author = person(issue.user);
        return {
          loaded: { route, repo, issue },
          page: {
            view: 'issue',
            repo: repoHeader(info),
            number: issue.number,
            title: issue.title,
            state: issue.state,
            ...(author ? { author } : {}),
            body: { markdown: issue.body ?? '', dir: '', ref: info.default_branch },
            labels: issue.labels.map(labelView),
            timeline: timeline(comments),
            url: issue.html_url,
          },
        };
      }
      case 'run': {
        const repo = refOf(route);
        const [info, run, jobs] = await Promise.all([
          api.repo(repo),
          api.run(repo, route.id),
          api.jobs(repo, route.id),
        ]);
        return {
          loaded: { route, repo, run, jobs },
          page: {
            view: 'run',
            repo: repoHeader(info),
            run: { ...runRow(repo.owner, repo.name, run), sha: run.head_sha, url: run.html_url },
            jobs: jobs.map(jobView),
          },
        };
      }
    }
  }

  /**
   * Todos os repositórios de um dono (até o limite do cliente), guardados por
   * alguns minutos: trocar busca, filtro ou ordem não lê a API de novo.
   */
  private ownerRepos(login: string, kind: 'mine' | 'org' | 'user'): Promise<OwnerRepos> {
    return this.repoCache.load(ownerKey(login, kind), async () => {
      const result = await this.auth.api.ownerReposAll(login, kind);
      return { rows: result.items.map(repoRow), truncated: result.hasMore };
    });
  }

  private async loadUser(route: Extract<Route, { view: 'user' }>): Promise<LoadResult> {
    const api = this.auth.api;
    const gh = await api.profile(route.login);
    const mine = gh.login.toLowerCase() === (this.auth.user ?? '').toLowerCase();
    const org = gh.type === 'Organization';
    const tab = route.tab ?? 'overview';
    // Aba que não existe neste tipo de perfil (estrelas de uma organização...).
    if (org ? tab === 'stars' || tab === 'followers' || tab === 'following' : tab === 'people') {
      return { redirect: userRoute(gh.login) };
    }
    const login = gh.login;
    const kind = mine ? 'mine' : org ? 'org' : 'user';
    const [circle, extras] = await Promise.all([
      (org
        ? api.peoplePage(login, 'members', 1, 24).then((r) => r.items)
        : api.profileOrgs(login, mine)
      )
        .then((list) => list.flatMap((p) => person(p) ?? []))
        .catch((): Person[] => []),
      api.profileExtras(login).catch((): GhProfileExtras => ({ pinned: [] })),
    ]);
    let body: UserBody;
    let more: Pager | undefined;
    switch (tab) {
      case 'overview': {
        const home = org ? { owner: login, name: '.github' } : { owner: login, name: login };
        const [readme, popular] = await Promise.all([
          api.readme(home, undefined, org ? 'profile' : '').catch(() => undefined),
          extras.pinned.length > 0
            ? Promise.resolve([])
            : this.ownerRepos(login, kind).then((all) => popularRepos(all.rows)),
        ]);
        body = {
          tab,
          ...(readme
            ? {
                readme: {
                  ...home,
                  markdown: readme.text,
                  path: readme.path,
                  dir: dirOf(readme.path),
                  ref: 'HEAD',
                },
              }
            : {}),
          repos: extras.pinned.length > 0 ? extras.pinned.map(repoRow) : popular,
          reposKind: extras.pinned.length > 0 ? 'pinned' : 'popular',
        };
        break;
      }
      case 'repositories': {
        const all = await this.ownerRepos(login, kind);
        const list = filterRepos(all.rows, route);
        const slice = (page: number) => list.slice((page - 1) * REPO_PAGE, page * REPO_PAGE);
        more = pager((page) =>
          Promise.resolve({
            rows: { kind: 'repos', repos: slice(page) },
            hasMore: list.length > page * REPO_PAGE,
          }),
        );
        const f = repoFilters(route);
        body = {
          tab,
          filters: f,
          languages: repoLanguages(all.rows),
          total: list.length,
          repos: slice(1),
          hasMore: list.length > REPO_PAGE,
          truncated: all.truncated,
        };
        break;
      }
      case 'stars': {
        const fetch = async (page: number) => {
          const result = await api.starredPage(login, page);
          return { rows: { kind: 'repos' as const, repos: result.items.map(repoRow) }, ...result };
        };
        const first = await fetch(1);
        more = pager(async (page) => {
          const next = await fetch(page);
          return { rows: next.rows, hasMore: next.hasMore };
        });
        body = { tab, repos: first.rows.repos, hasMore: first.hasMore };
        break;
      }
      case 'followers':
      case 'following':
      case 'people': {
        const fetch = async (page: number) => {
          const result = await api.peoplePage(login, tab === 'people' ? 'members' : tab, page);
          const people = result.items.flatMap((p) => person(p) ?? []);
          return { rows: { kind: 'people' as const, people }, hasMore: result.hasMore };
        };
        const first = await fetch(1);
        more = pager(fetch);
        body = { tab, people: first.rows.people, hasMore: first.hasMore };
        break;
      }
    }
    const cached = this.repoCache.peek(ownerKey(login, kind));
    const repositories =
      cached && !cached.truncated && (mine || org) ? cached.rows.length : gh.public_repos;
    return {
      loaded: { route, ...(more ? { more } : {}) },
      page: {
        view: 'user',
        profile: profileView(gh, mine),
        circle,
        counts: {
          ...(repositories !== undefined ? { repositories } : {}),
          ...(extras.stars !== undefined ? { stars: extras.stars } : {}),
        },
        body,
      },
    };
  }

  /**
   * Ref e caminho de uma rota de código ou arquivo. Uma URL com branch que tem
   * `/` chega cortada (ref `feature`, caminho `auth/src/a.ts`); a lista de
   * branches e tags acha o corte certo. `changed` diz se a rota precisa mudar.
   */
  private async refAndPath(
    repo: GhRepoRef,
    info: GhRepo,
    route: { readonly ref?: string; readonly path?: string },
  ): Promise<{ ref: string; path: string; changed: boolean }> {
    const path = route.path ?? '';
    if (!route.ref || route.ref === info.default_branch) {
      return { ref: route.ref ?? info.default_branch, path, changed: false };
    }
    const api = this.auth.api;
    const [branches, tags] = await Promise.all([
      api.branches(repo).catch(() => []),
      api.tags(repo).catch(() => []),
    ]);
    const split = splitRefPath(route.ref, path, [
      info.default_branch,
      ...branches.map((b) => b.name),
      ...tags.map((t) => t.name),
    ]);
    return { ...split, changed: split.ref !== route.ref };
  }

  /** Repositório sem nenhum commit: `contents` dá 404/409 e `commits` dá 409 ou nada. */
  private async isEmpty(repo: GhRepoRef, error: unknown): Promise<boolean> {
    if (!(error instanceof HttpError) || (error.status !== 404 && error.status !== 409)) {
      return false;
    }
    try {
      return (await this.auth.api.commits(repo, { perPage: 1 })).length === 0;
    } catch (inner) {
      return inner instanceof HttpError && inner.status === 409;
    }
  }

  private async loadRepo(route: Extract<Route, { view: 'repo' }>): Promise<LoadResult> {
    const api = this.auth.api;
    const repo = refOf(route);
    const info = await api.repo(repo);
    const header: RepoHeader = repoHeader(info);
    const state = route.state ?? 'open';
    const list = (fetch: Pager['fetch'], body: RepoBody): LoadResult => ({
      loaded: { route, repo, more: pager(fetch) },
      page: { view: 'repo', repo: header, body },
    });
    switch (route.tab) {
      case 'code': {
        const target = await this.refAndPath(repo, info, route);
        if (target.changed) {
          return {
            redirect: {
              view: 'repo',
              ...repo,
              tab: 'code',
              ref: target.ref,
              ...(target.path ? { path: target.path } : {}),
            },
          };
        }
        const { ref, path } = target;
        let contents: Awaited<ReturnType<typeof api.contents>>;
        try {
          contents = await api.contents(repo, path, ref);
        } catch (error) {
          if (!path && !route.ref && (await this.isEmpty(repo, error))) {
            return {
              loaded: { route, repo },
              page: {
                view: 'repo',
                repo: header,
                body: { tab: 'empty', cloneUrl: `${info.html_url}.git` },
              },
            };
          }
          throw error;
        }
        if (!Array.isArray(contents)) {
          return { redirect: { view: 'file', ...repo, path: contents.path, ref } };
        }
        const [readme, commits, languages, releases, branches, contributors] = await Promise.all([
          api.readme(repo, ref, path).catch(() => undefined),
          api.commits(repo, { ref, perPage: 1, ...(path ? { path } : {}) }).catch(() => []),
          path ? Promise.resolve({}) : api.languages(repo).catch(() => ({})),
          path ? Promise.resolve([]) : api.releases(repo, 3).catch(() => []),
          api.branches(repo).catch(() => []),
          path ? Promise.resolve([]) : api.contributors(repo, 14).catch(() => []),
        ]);
        const last = commits[0];
        return {
          loaded: { route, repo },
          page: {
            view: 'repo',
            repo: header,
            body: {
              tab: 'code',
              ref,
              path,
              branches: branches.map((b) => b.name),
              entries: contents.map(entryView),
              ...(readme
                ? {
                    readme: {
                      markdown: readme.text,
                      path: readme.path,
                      dir: dirOf(readme.path),
                      ref,
                    },
                  }
                : {}),
              ...(last ? { lastCommit: commitView(last) } : {}),
              languages: languageShares(languages),
              releases: releases.map(releaseView),
              contributors: contributors.flatMap((c) => person(c) ?? []),
            },
          },
        };
      }
      case 'issues':
      case 'pulls': {
        const tab = route.tab;
        const fetch = async (page: number) => {
          if (tab === 'issues') {
            const result = await api.issuesPage(repo, state, page);
            const items = result.items.map((i) => issueRow(repo.owner, repo.name, i));
            return { rows: { kind: 'items' as const, items }, hasMore: result.hasMore };
          }
          const result = await api.pullsPage(repo, state, page);
          const items = result.items.map((p) => pullRow(repo.owner, repo.name, p));
          return { rows: { kind: 'items' as const, items }, hasMore: result.hasMore };
        };
        const first = await fetch(1);
        return list(fetch, { tab, state, items: first.rows.items, hasMore: first.hasMore });
      }
      case 'actions': {
        const fetch = async (page: number) => {
          const result = await api.runsPage(repo, page);
          const runs = result.items.map((r) => runRow(repo.owner, repo.name, r));
          return { rows: { kind: 'runs' as const, runs }, hasMore: result.hasMore };
        };
        const first = await fetch(1);
        return list(fetch, { tab: 'actions', runs: first.rows.runs, hasMore: first.hasMore });
      }
      case 'releases': {
        const fetch = async (page: number) => {
          const result = await api.releasesPage(repo, page);
          const releases = result.items.map(releaseView);
          return { rows: { kind: 'releases' as const, releases }, hasMore: result.hasMore };
        };
        const first = await fetch(1);
        return list(fetch, {
          tab: 'releases',
          releases: first.rows.releases,
          hasMore: first.hasMore,
        });
      }
    }
  }

  private async loadFile(route: Extract<Route, { view: 'file' }>): Promise<LoadResult> {
    const api = this.auth.api;
    const repo = refOf(route);
    const info = await api.repo(repo);
    const target = await this.refAndPath(repo, info, route);
    if (target.changed) {
      return {
        redirect: target.path
          ? { view: 'file', ...repo, ref: target.ref, path: target.path }
          : { view: 'repo', ...repo, tab: 'code', ref: target.ref },
      };
    }
    const ref = target.ref;
    const item = await api.contents(repo, route.path, ref);
    if (Array.isArray(item)) {
      return { redirect: { view: 'repo', ...repo, tab: 'code', ref, path: route.path } };
    }
    const local = Boolean(await this.actions.folderOf(repo));
    const kind = fileKind(item.path);
    const base = {
      view: 'file' as const,
      repo: repoHeader(info),
      path: item.path,
      ref,
      size: item.size,
      local,
    };
    const loaded: Loaded = { route, repo, file: { path: item.path, ref } };
    if (kind === 'image') {
      // Imagens de repositórios privados pediriam o token; essas abrem no GitHub.
      const src = !info.private && item.download_url ? item.download_url : undefined;
      return {
        loaded,
        page: { ...base, body: src ? { kind: 'image', src } : { kind: 'binary' } },
      };
    }
    if (item.size > MAX_TEXT || item.content === undefined) {
      return { loaded, page: { ...base, body: { kind: 'large' } } };
    }
    const text = decodeContent(item);
    if (looksBinary(text)) return { loaded, page: { ...base, body: { kind: 'binary' } } };
    return {
      loaded,
      page: {
        ...base,
        body:
          kind === 'markdown'
            ? { kind: 'markdown', doc: { markdown: text, dir: dirOf(item.path), ref } }
            : { kind: 'code', text, lang: langOf(item.path) },
      },
    };
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'github.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'github.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      // Avatares, badges e imagens dos READMEs; nada de http nem de outro esquema.
      'img-src https: data:',
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html lang="${vscode.env.language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="stylesheet" href="${style.toString()}">
<title>GitHub</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}

function ownerKey(login: string, kind: 'mine' | 'org' | 'user'): string {
  return `${kind}:${login.toLowerCase()}`;
}

/** Mensagem clara e próximo passo para um erro da API. */
function explain(error: unknown): {
  message: string;
  fix?: 'login' | 'diagnose' | 'sso';
  url?: string;
} {
  if (error instanceof GitHubError) {
    switch (error.kind) {
      case 'login':
        return {
          message: l10n.t('Your GitHub session expired. Sign in again to continue.'),
          fix: 'login',
        };
      case 'sso':
        return error.ssoUrl
          ? { message: error.message, fix: 'sso', url: error.ssoUrl }
          : { message: error.message, fix: 'diagnose' };
      case 'token-sem-acesso':
      case 'escopo':
        return { message: error.message, fix: 'diagnose' };
      default:
        break;
    }
  }
  if (error instanceof HttpError && error.status === 404) {
    return {
      message: l10n.t(
        "Not found. The address may be wrong, or the repository is private and the token can't access it.",
      ),
      fix: 'diagnose',
    };
  }
  return { message: message(error) };
}
