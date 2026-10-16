import { isAbsolute } from 'node:path';

import {
  accountQuery,
  GitHubClient,
  notificationUrl,
  parseGitHubRemote,
  parseRepoName,
  toAccountItem,
  type AccountSearch,
  type FetchLike,
  type GhPull,
  type GhRepoRef,
} from '@fakl/integrations';
import {
  DELIVERIES,
  type Delivery,
  type GitHubAccountItems,
  type GitHubAccountNotification,
  type GitHubAccountOrg,
  type GitHubAccountRepo,
  type GitHubAccountRun,
  type GitHubAccountRuns,
  type TaskDefinition,
} from '@fakl/protocol';
import { l10n } from '@fakl/i18n';

import type { AgentRuntime } from '../agents.js';
import { run } from '../exec.js';
import {
  objectParams,
  RpcError,
  stringParam,
  type CallContext,
  type Router,
} from '../rpc/router.js';
import type { SecretVault } from '../secrets.js';
import {
  apiError,
  approveIfAgent,
  audited,
  isAgent,
  untrusted,
  type IntegrationGuards,
} from './guard.js';

export interface GitHubServiceOptions extends IntegrationGuards {
  readonly secrets: SecretVault;
  readonly agents: AgentRuntime;
  readonly createTask?: (definition: TaskDefinition, start: boolean) => Promise<unknown>;
  readonly fetch?: FetchLike;
  readonly log?: (message: string) => void;
}

export interface GitHubStatus {
  readonly conectado: boolean;
  readonly usuario?: string;
  readonly erro?: string;
}

/** Rótulo dos PRs abertos por agentes (SDD 11.1). */
export const AGENT_LABEL = 'fakl-agent';

function numberParam(p: Record<string, unknown>, name: string): number {
  const value = p[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw RpcError.invalidParams(l10n.t('{0} must be a positive integer', name));
  }
  return value;
}

function stateParam(p: Record<string, unknown>): 'open' | 'closed' | 'all' {
  const value = p.estado;
  if (value === 'fechado' || value === 'closed') return 'closed';
  if (value === 'todos' || value === 'all') return 'all';
  return 'open';
}

type Handle = (
  fn: (p: Record<string, unknown>, context: CallContext) => Promise<unknown>,
) => (params: unknown, context: CallContext) => Promise<unknown>;

/** Inteiro de um parâmetro opcional, preso a [min, max]. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

/** `dono/nome` ou `org`, só com caracteres de nomes do GitHub: entra numa consulta de busca. */
function scopeName(value: string, name: string): string {
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(value)) {
    throw RpcError.invalidParams(l10n.t('invalid {0}', name));
  }
  return value;
}

function lastLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-count).join('\n');
}

/**
 * GitHub no Core (SDD 11.1): o token vem do cofre da IDE e nunca chega aos
 * agentes. Eles usam as ferramentas `github_*`, sujeitas a aprovação para
 * escrever; o git do Core recebe o token por variável de ambiente só no push.
 */
export class GitHubService {
  readonly client: GitHubClient;
  private user: string | undefined;
  private userError: string | undefined;
  private checking: Promise<void> | undefined;

  constructor(private readonly options: GitHubServiceOptions) {
    this.client = new GitHubClient({
      token: () => options.secrets.get('github.token'),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    options.secrets.onChange((name) => {
      if (name !== 'github.token') return;
      this.user = undefined;
      this.userError = undefined;
      this.checking = undefined;
    });
  }

  get connected(): boolean {
    return this.client.authenticated;
  }

  async status(): Promise<GitHubStatus> {
    if (!this.connected) return { conectado: false };
    this.checking ??= this.client.user().then(
      (user) => {
        this.user = user.login;
      },
      (error: unknown) => {
        this.userError = error instanceof Error ? error.message : String(error);
      },
    );
    await this.checking;
    return {
      conectado: !this.userError,
      ...(this.user ? { usuario: this.user } : {}),
      ...(this.userError ? { erro: this.userError } : {}),
    };
  }

  /** Repositório do GitHub do `origin` de uma pasta. */
  async repoOf(path: string): Promise<GhRepoRef | undefined> {
    const result = await run('git', ['remote', 'get-url', 'origin'], {
      cwd: path,
      timeoutMs: 10_000,
    });
    return result.code === 0 ? parseGitHubRemote(result.stdout.trim()) : undefined;
  }

  /**
   * Variáveis que dão o token ao git só neste processo: um cabeçalho de
   * autorização para github.com, sem gravar nada na configuração do usuário.
   */
  gitEnv(): Record<string, string> {
    const token = this.options.secrets.get('github.token');
    if (!token) return {};
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
  }

  /** PR da entrega de uma execução (SDD 9.4), com o rótulo dos agentes. */
  async createPull(
    repoRoot: string,
    pull: { title: string; head: string; base: string; body: string; draft: boolean },
  ): Promise<GhPull> {
    const repo = await this.repoOf(repoRoot);
    if (!repo) throw new Error(l10n.t('the origin is not a GitHub repository'));
    const created = await this.client.createPull(repo, pull);
    await this.client.addLabels(repo, created.number, [AGENT_LABEL]).catch((error: unknown) => {
      this.options.log?.(l10n.t('could not label the PR: {0}', String(error)));
    });
    await this.options.audit.record({
      ator: 'orquestrador',
      acao: 'github.prs.create',
      alvo: `${repo.owner}/${repo.name}#${String(created.number)}`,
      resultado: 'ok',
    });
    return created;
  }

  /** Merge (squash) do PR da entrega `pr-merge`. */
  async mergePull(
    repoRoot: string,
    number: number,
    title: string,
  ): Promise<{ merged: boolean; message: string }> {
    const repo = await this.repoOf(repoRoot);
    if (!repo) throw new Error(l10n.t('the origin is not a GitHub repository'));
    const result = await this.client.mergePull(
      repo,
      number,
      'squash',
      `${title} (#${String(number)})`,
    );
    await this.options.audit.record({
      ator: 'orquestrador',
      acao: 'github.prs.merge',
      alvo: `${repo.owner}/${repo.name}#${String(number)}`,
      resultado: result.merged ? 'ok' : 'erro',
    });
    return result;
  }

  /** Dispara o build depois do merge da entrega `pr-merge`. */
  async dispatchWorkflow(
    repoRoot: string,
    workflow: string,
    ref: string,
    inputs: Readonly<Record<string, string>>,
  ): Promise<{ html_url: string }> {
    const repo = await this.repoOf(repoRoot);
    if (!repo) throw new Error(l10n.t('the origin is not a GitHub repository'));
    const dispatched = await this.client.dispatchWorkflow(repo, workflow, ref, inputs);
    await this.options.audit.record({
      ator: 'orquestrador',
      acao: 'github.actions.dispatch',
      alvo: `${repo.owner}/${repo.name}:${workflow}@${ref}`,
      resultado: 'ok',
    });
    return {
      html_url:
        dispatched.html_url ??
        `https://github.com/${repo.owner}/${repo.name}/actions/workflows/${workflow}`,
    };
  }

  /** Repositório do pedido: `repo` ("dono/nome"), `repoPath`, ou a pasta do agente. */
  private async repoFor(p: Record<string, unknown>, context: CallContext): Promise<GhRepoRef> {
    if (typeof p.repo === 'string' && p.repo) {
      const [owner, name, ...rest] = p.repo.split('/');
      if (!owner || !name || rest.length > 0)
        throw RpcError.invalidParams(l10n.t('repo must be owner/name'));
      return { owner, name };
    }
    const path =
      typeof p.repoPath === 'string' && isAbsolute(p.repoPath)
        ? p.repoPath
        : isAgent(context) && context.principal
          ? this.options.agents.cwdOf(context.principal)
          : undefined;
    if (!path) throw RpcError.invalidParams(l10n.t('provide repo (owner/name) or repoPath'));
    const repo = await this.repoOf(path);
    if (!repo) throw RpcError.invalidParams(l10n.t('the folder has no GitHub origin'));
    return repo;
  }

  private require(): void {
    if (!this.connected) {
      throw RpcError.invalidParams(
        l10n.t('not signed in to GitHub; sign in from the IDE (FaKL: Sign in to GitHub)'),
      );
    }
  }

  /**
   * `github.account.*` (ADR 0020): a conta inteira, sem repositório aberto.
   * Leituras são livres; marcar notificações como lidas é escrita e passa pela
   * aprovação quando quem pede é um agente.
   */
  private registerAccount(router: Router, handle: Handle): void {
    const guards: IntegrationGuards = this.options;
    const search = (kind: AccountSearch, type: 'pr' | 'issue' | 'all') =>
      handle(async (p) => {
        const parts = [accountQuery(kind, type, stateParam(p))];
        if (typeof p.repo === 'string' && p.repo) parts.push(`repo:${scopeName(p.repo, 'repo')}`);
        if (typeof p.org === 'string' && p.org) parts.push(`org:${scopeName(p.org, 'org')}`);
        const result = await this.client.searchIssues(parts.join(' '), {
          perPage: clampInt(p.limite, 1, 100, 30),
        });
        return {
          total: result.total,
          itens: result.items.map((item) => {
            const i = toAccountItem(item);
            return {
              repo: i.repo,
              tipo: i.kind,
              numero: i.number,
              titulo: i.title,
              estado: i.state,
              rascunho: i.draft,
              ...(i.author ? { autor: i.author } : {}),
              rotulos: i.labels,
              comentarios: i.comments,
              url: i.url,
              atualizadoEm: i.updatedAt,
            };
          }),
        } satisfies GitHubAccountItems;
      });
    router.register('github.account.prs.mine', search('authored', 'pr'));
    router.register('github.account.prs.reviewRequested', search('reviewRequested', 'pr'));
    router.register('github.account.prs.assigned', search('assigned', 'pr'));
    router.register(
      'github.account.issues.mine',
      handle((p, context) => {
        // `relacao`: atribuídas a mim (padrão), criadas por mim ou que me envolvem.
        const kind: AccountSearch =
          p.relacao === 'autor' ? 'authored' : p.relacao === 'envolvido' ? 'involves' : 'assigned';
        return search(kind, 'issue')(p, context);
      }),
    );
    router.register(
      'github.account.repos.list',
      handle(async (p) => {
        const pages = clampInt(p.paginas, 1, 10, 3);
        const org = typeof p.org === 'string' && p.org ? scopeName(p.org, 'org') : undefined;
        const repos = org
          ? await this.client.orgRepos(org, { maxPages: pages })
          : await this.client.userRepos({ maxPages: pages });
        const text = typeof p.busca === 'string' ? p.busca.trim().toLowerCase() : '';
        return repos
          .filter(
            (repo) =>
              (p.arquivados === true || !repo.archived) &&
              (!text ||
                repo.full_name.toLowerCase().includes(text) ||
                (repo.description ?? '').toLowerCase().includes(text)),
          )
          .slice(0, clampInt(p.limite, 1, 1000, 300))
          .map((repo): GitHubAccountRepo => ({
            repo: repo.full_name,
            privado: repo.private,
            arquivado: repo.archived ?? false,
            fork: repo.fork ?? false,
            ...(repo.description ? { descricao: repo.description } : {}),
            branchPadrao: repo.default_branch,
            ...(repo.pushed_at ? { ultimoPushEm: repo.pushed_at } : {}),
            url: repo.html_url,
          }));
      }),
    );
    router.register(
      'github.account.orgs.list',
      handle(async () =>
        (await this.client.userOrgs()).map((org): GitHubAccountOrg => ({
          login: org.login,
          ...(org.description ? { descricao: org.description } : {}),
        })),
      ),
    );
    router.register(
      'github.account.actions.recent',
      handle(async (p) => {
        const repos = Array.isArray(p.repos)
          ? p.repos.flatMap((r) => (typeof r === 'string' ? (parseRepoName(r) ?? []) : []))
          : undefined;
        const status =
          { falhou: 'failure', andamento: 'in_progress', sucesso: 'success', fila: 'queued' }[
            String(p.status)
          ] ?? (typeof p.status === 'string' && /^[a-z_]+$/.test(p.status) ? p.status : undefined);
        const result = await this.client.recentRuns({
          ...(repos ? { repos } : {}),
          ...(status ? { status } : {}),
          ...(typeof p.branch === 'string' && p.branch ? { branch: p.branch } : {}),
          maxRepos: clampInt(p.maxRepos, 1, 30, 12),
          limit: clampInt(p.limite, 1, 100, 30),
        });
        return {
          execucoes: result.runs.map((r): GitHubAccountRun => ({
            repo: r.repo,
            id: r.id,
            ...nameField(r),
            branch: r.head_branch,
            status: r.status,
            conclusao: r.conclusion,
            evento: r.event,
            url: r.html_url,
            criadoEm: r.created_at,
          })),
          repositorios: result.repos,
          erros: result.errors.map((e) => ({ repo: e.repo, mensagem: e.message })),
        } satisfies GitHubAccountRuns;
      }),
    );
    router.register(
      'github.account.notifications.list',
      handle(async (p) => {
        const list = await this.client.notifications(p.todas === true, { maxPages: 2 });
        return list
          .slice(0, clampInt(p.limite, 1, 100, 50))
          .map((n): GitHubAccountNotification => ({
            id: n.id,
            repo: n.repository.full_name,
            tipo: n.subject.type,
            titulo: n.subject.title,
            motivo: n.reason,
            naoLida: n.unread,
            url: notificationUrl(n),
            atualizadaEm: n.updated_at,
          }));
      }),
    );
    router.register(
      'github.account.notifications.markRead',
      handle(async (p, context) => {
        const id = typeof p.id === 'string' && p.id ? p.id : undefined;
        const repo = typeof p.repo === 'string' && p.repo ? parseRepoName(p.repo) : undefined;
        if (!id && p.todas !== true && !repo) {
          throw RpcError.invalidParams(l10n.t('provide id, repo (owner/name) or todas: true'));
        }
        const alvo = id
          ? l10n.t('notification {0}', id)
          : repo
            ? l10n.t('notifications from {0}', p.repo as string)
            : l10n.t('all notifications');
        const input = { acao: 'github.account.notifications.markRead', alvo };
        await approveIfAgent(guards, context, l10n.t('Mark as read: {0}', alvo), input);
        await audited(guards, context, input, () =>
          id ? this.client.markNotificationRead(id) : this.client.markNotificationsRead(repo),
        );
        return { ok: true };
      }),
    );
  }

  register(router: Router): void {
    const guards: IntegrationGuards = this.options;
    const handle: Handle =
      (fn) =>
      async (params: unknown, context: CallContext): Promise<unknown> => {
        this.require();
        try {
          return await fn(params === undefined ? {} : objectParams(params), context);
        } catch (error) {
          throw apiError(error);
        }
      };

    router.register('github.status', () => this.status());
    router.register('github.gitCredential', (params, context) => {
      // Só a IDE e a CLI (o credential helper) recebem o token.
      if (context.principal !== undefined) throw RpcError.invalidParams(l10n.t('not allowed'));
      const p = params === undefined ? {} : objectParams(params);
      const host = typeof p.host === 'string' ? p.host : 'github.com';
      const token = this.options.secrets.get('github.token');
      if (host !== 'github.com' || !token) return null;
      return { username: 'x-access-token', password: token };
    });
    router.register(
      'github.repo',
      handle(async (p, context) => {
        const repo = await this.repoFor(p, context);
        return { ...repo, ...(await this.client.repo(repo)) };
      }),
    );
    router.register(
      'github.issues.list',
      handle(async (p, context) => {
        const repo = await this.repoFor(p, context);
        const issues = await this.client.issues(repo, stateParam(p));
        return issues.map((issue) => ({
          numero: issue.number,
          titulo: issue.title,
          estado: issue.state,
          autor: issue.user?.login,
          rotulos: issue.labels.map((l) => (typeof l === 'string' ? l : l.name)),
          comentarios: issue.comments,
          url: issue.html_url,
          atualizadaEm: issue.updated_at,
        }));
      }),
    );
    router.register(
      'github.issues.get',
      handle(async (p, context) => {
        const repo = await this.repoFor(p, context);
        const number = numberParam(p, 'numero');
        const [issue, comments] = await Promise.all([
          this.client.issue(repo, number),
          this.client.comments(repo, number),
        ]);
        const text = [
          l10n.t(
            '#{0} {1} ({2}) by {3}',
            String(issue.number),
            issue.title,
            issue.state,
            issue.user?.login ?? '?',
          ),
          issue.body ?? '',
          ...comments.map((c) =>
            l10n.t('--- {0} on {1}\n{2}', c.user?.login ?? '?', c.created_at, c.body),
          ),
        ].join('\n\n');
        return {
          numero: issue.number,
          titulo: issue.title,
          url: issue.html_url,
          estado: issue.state,
          conteudo: isAgent(context) ? untrusted(`issue ${issue.html_url}`, text) : text,
        };
      }),
    );
    router.register(
      'github.issues.comment',
      handle(async (p, context) => {
        const repo = await this.repoFor(p, context);
        const number = numberParam(p, 'numero');
        const body = stringParam(p, 'texto');
        const target = `${repo.owner}/${repo.name}#${String(number)}`;
        const input = { acao: 'github.issues.comment', alvo: target };
        await approveIfAgent(
          guards,
          context,
          l10n.t('Comment on {0}:\n{1}', target, body.slice(0, 500)),
          input,
        );
        const comment = await audited(guards, context, input, () =>
          this.client.comment(repo, number, body),
        );
        return { url: comment.html_url };
      }),
    );
    router.register(
      'github.prs.list',
      handle(async (p, context) => {
        const repo = await this.repoFor(p, context);
        const pulls = await this.client.pulls(repo, stateParam(p));
        return pulls.map((pull) => ({
          numero: pull.number,
          titulo: pull.title,
          estado: pull.state,
          rascunho: pull.draft ?? false,
          autor: pull.user?.login,
          branch: pull.head.ref,
          base: pull.base.ref,
          url: pull.html_url,
          atualizadoEm: pull.updated_at,
        }));
      }),
    );
    router.register(
      'github.prs.get',
      handle(async (p, context) => {
        const repo = await this.repoFor(p, context);
        const number = numberParam(p, 'numero');
        const [pull, files, reviews] = await Promise.all([
          this.client.pull(repo, number),
          this.client.pullFiles(repo, number),
          this.client.pullReviews(repo, number),
        ]);
        const text = [
          pull.draft
            ? l10n.t(
                '#{0} {1} ({2}, draft) {3} → {4}',
                String(pull.number),
                pull.title,
                pull.state,
                pull.head.ref,
                pull.base.ref,
              )
            : l10n.t(
                '#{0} {1} ({2}) {3} → {4}',
                String(pull.number),
                pull.title,
                pull.state,
                pull.head.ref,
                pull.base.ref,
              ),
          pull.body ?? '',
          ...reviews.map((r) =>
            l10n.t('--- review by {0}: {1}\n{2}', r.user?.login ?? '?', r.state, r.body ?? ''),
          ),
          ...files.map(
            (f) =>
              `--- ${f.status} ${f.filename} (+${String(f.additions)} -${String(f.deletions)})\n${(f.patch ?? '').slice(0, 4000)}`,
          ),
        ].join('\n\n');
        return {
          numero: pull.number,
          titulo: pull.title,
          url: pull.html_url,
          estado: pull.merged ? 'merged' : pull.state,
          conteudo: isAgent(context) ? untrusted(`PR ${pull.html_url}`, text) : text,
        };
      }),
    );
    router.register(
      'github.prs.create',
      handle(async (p, context) => {
        const repo = await this.repoFor(p, context);
        const head = stringParam(p, 'head');
        const base =
          typeof p.base === 'string' && p.base
            ? p.base
            : (await this.client.repo(repo)).default_branch;
        const title = stringParam(p, 'titulo');
        const profile =
          context.principal && isAgent(context)
            ? this.options.agents.sessionProfile(context.principal)?.profile.nome
            : undefined;
        const body = [
          typeof p.corpo === 'string' ? p.corpo : '',
          profile ? l10n.t('\n---\nOpened by agent **{0}** in FaKL-Code.', profile) : '',
        ].join('');
        const target = `${repo.owner}/${repo.name} ${head} → ${base}`;
        const input = { acao: 'github.prs.create', alvo: target };
        // PR de um branch dos agentes é liberado; de outro branch, pede aprovação (SDD 14.3).
        if (!head.startsWith('fakl/')) {
          await approveIfAgent(
            guards,
            context,
            l10n.t('Open PR in {0}: {1}', target, title),
            input,
          );
        }
        const pull = await audited(guards, context, input, () =>
          this.client.createPull(repo, { title, head, base, body, draft: p.rascunho === true }),
        );
        if (isAgent(context))
          await this.client.addLabels(repo, pull.number, [AGENT_LABEL]).catch(() => undefined);
        return { numero: pull.number, url: pull.html_url };
      }),
    );
    router.register(
      'github.actions.list',
      handle(async (p, context) => {
        const repo = await this.repoFor(p, context);
        const runs = await this.client.runs(
          repo,
          typeof p.branch === 'string' ? p.branch : undefined,
        );
        return runs.map((r) => ({
          id: r.id,
          nome: r.name ?? r.display_title,
          branch: r.head_branch,
          status: r.status,
          conclusao: r.conclusion,
          evento: r.event,
          url: r.html_url,
          criadoEm: r.created_at,
        }));
      }),
    );
    router.register(
      'github.actions.logs',
      handle(async (p, context) => {
        const repo = await this.repoFor(p, context);
        const runId = numberParam(p, 'runId');
        const jobs = await this.client.jobs(repo, runId);
        const failed = jobs.filter((job) => job.conclusion === 'failure');
        const chosen = failed.length > 0 ? failed : jobs.slice(0, 1);
        const linhas =
          typeof p.linhas === 'number' && p.linhas > 0 ? Math.min(p.linhas, 2000) : 200;
        const logs = await Promise.all(
          chosen.map(async (job) => {
            const text = await this.client.jobLog(repo, job.id).catch((e: unknown) => String(e));
            const tail = lastLines(text, linhas);
            return {
              job: job.name,
              conclusao: job.conclusion,
              log: isAgent(context) ? untrusted(l10n.t('job log {0}', job.name), tail) : tail,
            };
          }),
        );
        return {
          jobs: jobs.map((job) => ({
            id: job.id,
            nome: job.name,
            status: job.status,
            conclusao: job.conclusion,
          })),
          logs,
        };
      }),
    );
    this.registerAccount(router, handle);
    router.register(
      'tasks.fromIssue',
      handle(async (p, context) => {
        if (!this.options.createTask)
          throw RpcError.invalidParams(l10n.t('orchestrator unavailable'));
        const repoPath = stringParam(p, 'repoPath');
        const repo = await this.repoFor({ ...p, repoPath }, context);
        const number = numberParam(p, 'numero');
        const issue = await this.client.issue(repo, number);
        const definition: TaskDefinition = {
          titulo: `#${String(issue.number)} ${issue.title}`,
          descricao: untrusted(`issue ${issue.html_url}`, `${issue.title}\n\n${issue.body ?? ''}`),
          origem: 'issue',
          referencia: issue.html_url,
          repoPath,
          ...(DELIVERIES.includes(p.entrega as Delivery) ? { entrega: p.entrega as Delivery } : {}),
          ...(typeof p.maestroProfileId === 'string'
            ? { maestroProfileId: p.maestroProfileId }
            : {}),
        };
        return await this.options.createTask(definition, p.comecar === true);
      }),
    );
  }
}

function runName(run: { name?: string | null; display_title?: string }): string | undefined {
  return run.name ?? run.display_title ?? undefined;
}

function nameField(run: { name?: string | null; display_title?: string }): { nome?: string } {
  const nome = runName(run);
  return nome ? { nome } : {};
}
