import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import {
  GitHubError,
  notificationUrl,
  parseGitHubRemote,
  parseRepoName,
  repoPath,
  type AccountSearch,
  type GhAccountItem,
  type GhIssue,
  type GhJob,
  type GhNotification,
  type GhPull,
  type GhPullFile,
  type GhRelease,
  type GhRepo,
  type GhRepoRef,
  type GhWorkflowRun,
  type MergeMethod,
  type ReviewEvent,
} from '@fakl/integrations';
import * as vscode from 'vscode';

import type { GitHubAuth } from './github-auth.js';
import { GitHubFullPanel } from './github-full.js';
import { parseGitHubUrl } from './github-full-model.js';
import type { Route } from './github-full-protocol.js';
import {
  filterRepos,
  groupByOwner,
  groupNotifications,
  RUN_FILTERS,
  runFilterLabel,
  summarizeRunErrors,
  unreadCount,
  type NotificationGroup,
  type OwnerGroup,
  type RunFilterId,
} from './github-model.js';

const execFileAsync = promisify(execFile);
const SCHEME = 'fakl-gh';
/** Atualização automática leve: só com a janela em foco e o painel visível. */
const POLL_MS = 90_000;

type ViewKind =
  | 'account'
  | 'assigned'
  | 'reviews'
  | 'myprs'
  | 'issues'
  | 'actions'
  | 'notifications'
  | 'workspace';

const VIEW_KINDS: readonly ViewKind[] = [
  'account',
  'assigned',
  'reviews',
  'myprs',
  'issues',
  'actions',
  'notifications',
  'workspace',
];

type Section = 'prs' | 'issues' | 'actions' | 'releases';

/** Visões de `Issues`: como o usuário se liga à issue. */
type IssueRelation = Extract<AccountSearch, 'assigned' | 'authored' | 'involves'>;

type Node =
  | {
      readonly t: 'info';
      readonly label: string;
      readonly tooltip?: string;
      readonly icon?: string;
      readonly command?: vscode.Command;
    }
  | { readonly t: 'owner'; readonly group: OwnerGroup }
  | { readonly t: 'repo'; readonly repo: GhRepoRef; readonly info?: GhRepo }
  | { readonly t: 'section'; readonly repo: GhRepoRef; readonly section: Section }
  | { readonly t: 'pr'; readonly repo: GhRepoRef; readonly pull: GhPull }
  | { readonly t: 'apr'; readonly repo: GhRepoRef; readonly item: GhAccountItem }
  | {
      readonly t: 'prfile';
      readonly repo: GhRepoRef;
      readonly pull: GhPull;
      readonly file: GhPullFile;
    }
  | { readonly t: 'issue'; readonly repo: GhRepoRef; readonly issue: GhIssue }
  | { readonly t: 'aissue'; readonly repo: GhRepoRef; readonly item: GhAccountItem }
  | { readonly t: 'run'; readonly repo: GhRepoRef; readonly run: GhWorkflowRun }
  | {
      readonly t: 'job';
      readonly repo: GhRepoRef;
      readonly run: GhWorkflowRun;
      readonly job: GhJob;
    }
  | { readonly t: 'release'; readonly repo: GhRepoRef; readonly release: GhRelease }
  | { readonly t: 'notifgroup'; readonly group: NotificationGroup }
  | { readonly t: 'notification'; readonly notification: GhNotification };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function name(repo: GhRepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

function repoUrl(repo: GhRepoRef): string {
  return `https://github.com/${name(repo)}`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Ícone de uma execução do Actions pelo estado. */
function runIcon(status: string | null, conclusion: string | null): vscode.ThemeIcon {
  if (status !== 'completed') return new vscode.ThemeIcon('sync~spin');
  switch (conclusion) {
    case 'success':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'failure':
    case 'timed_out':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    case 'cancelled':
    case 'skipped':
      return new vscode.ThemeIcon('circle-slash');
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

/** URI de um lado do diff de um PR: `fakl-gh:/dono/nome/<lado>/<caminho>?pr=N&ref=sha`. */
function fileUri(repo: GhRepoRef, pull: GhPull, path: string, side: 'base' | 'head'): vscode.Uri {
  const ref = side === 'base' ? pull.base.sha : pull.head.sha;
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${repo.owner}/${repo.name}/${side}/${path}`,
    query: `pr=${String(pull.number)}&ref=${ref}`,
  });
}

function parseFileUri(
  uri: vscode.Uri,
): { repo: GhRepoRef; side: string; path: string; pr: number; ref: string } | undefined {
  const [, owner, repoName, side, ...rest] = uri.path.split('/');
  const query = new URLSearchParams(uri.query);
  const pr = Number(query.get('pr'));
  const ref = query.get('ref');
  if (!owner || !repoName || !side || rest.length === 0 || !ref || !pr) return undefined;
  return { repo: { owner, name: repoName }, side, path: rest.join('/'), pr, ref };
}

/** Repositórios do GitHub abertos na janela, pelo `origin` de cada pasta. */
async function workspaceRepos(): Promise<WorkspaceRepo[]> {
  const repos: WorkspaceRepo[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: folder.uri.fsPath,
        timeout: 10_000,
      });
      const ref = parseGitHubRemote(stdout.trim());
      if (ref && !repos.some((r) => name(r.ref) === name(ref))) repos.push({ ref, folder });
    } catch {
      // Pasta sem git ou sem origin.
    }
  }
  return repos;
}

/** Repositório aberto no workspace, com a pasta onde está. */
export interface WorkspaceRepo {
  readonly ref: GhRepoRef;
  readonly folder: vscode.WorkspaceFolder;
}

/** Um erro da API vira uma linha clara, com o próximo passo quando existe. */
function errorNodes(error: unknown): Node[] {
  if (error instanceof GitHubError) {
    switch (error.kind) {
      case 'login':
        return [
          {
            t: 'info',
            label: l10n.t('GitHub session expired: sign in again'),
            tooltip: error.message,
            icon: 'sign-in',
            command: { command: 'fakl.github.login', title: l10n.t('Sign in') },
          },
        ];
      case 'sso':
        return [
          {
            t: 'info',
            label: l10n.t('Organization with SSO: authorize the token'),
            tooltip: error.message,
            icon: 'shield',
            command: error.ssoUrl
              ? {
                  command: 'vscode.open',
                  title: l10n.t('Authorize'),
                  arguments: [vscode.Uri.parse(error.ssoUrl)],
                }
              : { command: 'fakl.github.diagnose', title: l10n.t('Diagnose') },
          },
        ];
      case 'token-sem-acesso':
      case 'escopo':
        return [
          {
            t: 'info',
            label: l10n.t("The token can't access this: diagnose"),
            tooltip: error.message,
            icon: 'warning',
            command: { command: 'fakl.github.diagnose', title: l10n.t('Diagnose') },
          },
        ];
      case 'limite':
        return [
          {
            t: 'info',
            label: l10n.t('GitHub rate limit reached'),
            tooltip: error.message,
            icon: 'watch',
          },
        ];
      default:
        break;
    }
  }
  return [{ t: 'info', label: l10n.t('Error: {0}', message(error)), tooltip: message(error) }];
}

class GitHubTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Última lista de notificações, para marcar um grupo como lido. */
  notifications: GhNotification[] = [];

  constructor(
    private readonly kind: ViewKind,
    private readonly ui: GitHubUi,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.changed.dispose();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    try {
      return await this.children(node);
    } catch (error) {
      return errorNodes(error);
    }
  }

  private async children(node?: Node): Promise<Node[]> {
    const auth = this.ui.auth;
    if (!node) {
      if (!auth.signedIn) {
        return [
          {
            t: 'info',
            label: l10n.t('Sign in to GitHub'),
            icon: 'github',
            command: { command: 'fakl.github.login', title: l10n.t('Sign in') },
          },
        ];
      }
      return await this.root();
    }
    const api = auth.api;
    switch (node.t) {
      case 'owner':
        return await this.ownerChildren(node.group);
      case 'repo':
        return (['prs', 'issues', 'actions', 'releases'] as const).map((section) => ({
          t: 'section',
          repo: node.repo,
          section,
        }));
      case 'section':
        return await this.sectionChildren(node.repo, node.section);
      case 'pr': {
        const files = await api.pullFiles(node.repo, node.pull.number);
        return files.map((file) => ({ t: 'prfile', repo: node.repo, pull: node.pull, file }));
      }
      case 'apr': {
        const pull = await api.pull(node.repo, node.item.number);
        const files = await api.pullFiles(node.repo, pull.number);
        return files.map((file) => ({ t: 'prfile', repo: node.repo, pull, file }));
      }
      case 'run': {
        const jobs = await api.jobs(node.repo, node.run.id);
        return jobs.map((job) => ({ t: 'job', repo: node.repo, run: node.run, job }));
      }
      case 'notifgroup':
        return node.group.items.map((notification) => ({ t: 'notification', notification }));
      default:
        return [];
    }
  }

  /** Raiz de cada visão: a conta inteira, sem depender do workspace. */
  private async root(): Promise<Node[]> {
    const api = this.ui.auth.api;
    const state = this.ui.state;
    switch (this.kind) {
      case 'account': {
        const [orgs, repos] = await Promise.all([api.userOrgs(), api.userRepos({ maxPages: 3 })]);
        const search: Node = state.repoFilter
          ? {
              t: 'info',
              label: l10n.t('Search: "{0}" (clear)', state.repoFilter),
              icon: 'close',
              command: {
                command: 'fakl.github.account.clearSearch',
                title: l10n.t('Clear search'),
              },
            }
          : {
              t: 'info',
              label: l10n.t('Search repositories…'),
              icon: 'search',
              command: { command: 'fakl.github.account.search', title: l10n.t('Search') },
            };
        if (state.repoFilter) {
          const found = filterRepos(repos, state.repoFilter);
          return [
            search,
            ...found.map((info): Node => ({ t: 'repo', repo: refOf(info), info })),
            ...(found.length === 0
              ? [{ t: 'info', label: l10n.t('No repositories found.') } satisfies Node]
              : []),
          ];
        }
        const groups = groupByOwner(this.ui.auth.user, orgs, repos);
        return [search, ...groups.map((group): Node => ({ t: 'owner', group }))];
      }
      case 'assigned':
        return this.items(
          await api.accountItems('assigned', 'all', { perPage: 50 }),
          l10n.t('Nothing assigned to you.'),
        );
      case 'reviews':
        return this.items(
          await api.accountItems('reviewRequested', 'pr', { perPage: 50 }),
          l10n.t('No reviews requested from you.'),
        );
      case 'myprs':
        return this.items(
          await api.accountItems('authored', 'pr', { perPage: 50 }),
          l10n.t('You have no open PRs.'),
        );
      case 'issues': {
        const filter: Node = {
          t: 'info',
          label: l10n.t('Filter: {0}', issueRelations()[state.issueRelation]),
          icon: 'filter',
          command: { command: 'fakl.github.issues.filter', title: l10n.t('Filter') },
        };
        return [
          filter,
          ...this.items(
            await api.accountItems(state.issueRelation, 'issue', { perPage: 50 }),
            l10n.t('No open issues.'),
          ),
        ];
      }
      case 'actions':
        return await this.actionsRoot();
      case 'notifications': {
        this.notifications = await api.notifications();
        this.ui.setBadge(unreadCount(this.notifications));
        return this.notifications.length === 0
          ? [{ t: 'info', label: l10n.t('No notifications.') }]
          : groupNotifications(this.notifications).map((group): Node => ({
              t: 'notifgroup',
              group,
            }));
      }
      case 'workspace': {
        const repos = await this.ui.repos();
        return repos.length === 0
          ? [{ t: 'info', label: l10n.t('No open folder has an origin on GitHub.') }]
          : repos.map((repo): Node => ({ t: 'repo', repo: repo.ref }));
      }
    }
  }

  private items(result: { total: number; items: GhAccountItem[] }, empty: string): Node[] {
    this.ui.setDescription(this.kind, result.total > 0 ? String(result.total) : undefined);
    if (result.items.length === 0) return [{ t: 'info', label: empty }];
    return result.items.map((item): Node => {
      const repo = parseRepoName(item.repo) ?? { owner: item.repo, name: '' };
      return item.kind === 'pr' ? { t: 'apr', repo, item } : { t: 'aissue', repo, item };
    });
  }

  private async actionsRoot(): Promise<Node[]> {
    const state = this.ui.state;
    const filter = RUN_FILTERS.find((f) => f.id === state.runFilter);
    const repos = state.runRepos.split(/[\s,]+/).flatMap((value) => parseRepoName(value) ?? []);
    const label = [
      filter && filter.id !== 'todas' ? runFilterLabel(filter.id) : undefined,
      repos.length > 0 ? repos.map(name).join(', ') : undefined,
    ].filter(Boolean);
    const nodes: Node[] = [
      {
        t: 'info',
        label:
          label.length > 0
            ? l10n.t('Filter: {0}', label.join(' · '))
            : l10n.t('Filter: all, most active repos'),
        icon: 'filter',
        command: { command: 'fakl.github.actions.filter', title: l10n.t('Filter') },
      },
    ];
    const result = await this.ui.auth.api.recentRuns({
      ...(repos.length > 0 ? { repos } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
      maxRepos: 15,
      perRepo: 5,
      limit: 60,
    });
    this.ui.setDescription(
      'actions',
      result.repos === 1 ? l10n.t('1 repo') : l10n.t('{0} repos', String(result.repos)),
    );
    for (const run of result.runs) {
      const repo = parseRepoName(run.repo);
      if (repo) nodes.push({ t: 'run', repo, run });
    }
    if (result.runs.length === 0) nodes.push({ t: 'info', label: l10n.t('No runs found.') });
    const summary = summarizeRunErrors(result.errors);
    if (summary) {
      nodes.push({
        t: 'info',
        label: summary,
        icon: 'warning',
        tooltip: result.errors.map((e) => `${e.repo}: ${e.message}`).join('\n'),
        command: { command: 'fakl.github.diagnose', title: l10n.t('Diagnose') },
      });
    }
    return nodes;
  }

  private async ownerChildren(group: OwnerGroup): Promise<Node[]> {
    // Organizações têm mais repositórios do que a lista recente da conta mostra.
    const repos =
      group.kind === 'org'
        ? await this.ui.auth.api.orgRepos(group.login, { maxPages: 3 })
        : group.repos;
    const visible = repos.filter((repo) => !repo.archived);
    return visible.length === 0
      ? [{ t: 'info', label: l10n.t('No repositories.') }]
      : visible.map((info): Node => ({ t: 'repo', repo: refOf(info), info }));
  }

  private async sectionChildren(repo: GhRepoRef, section: Section): Promise<Node[]> {
    const api = this.ui.auth.api;
    switch (section) {
      case 'prs': {
        const pulls = await api.pulls(repo);
        return pulls.length === 0
          ? [{ t: 'info', label: l10n.t('No open PRs.') }]
          : pulls.map((pull): Node => ({ t: 'pr', repo, pull }));
      }
      case 'issues': {
        const issues = await api.issues(repo);
        return issues.length === 0
          ? [{ t: 'info', label: l10n.t('No open issues.') }]
          : issues.map((issue): Node => ({ t: 'issue', repo, issue }));
      }
      case 'actions': {
        const runs = await api.runs(repo);
        return runs.length === 0
          ? [{ t: 'info', label: l10n.t('No runs.') }]
          : runs.map((run): Node => ({ t: 'run', repo, run }));
      }
      case 'releases': {
        const releases = await api.releases(repo);
        return releases.length === 0
          ? [{ t: 'info', label: l10n.t('No releases.') }]
          : releases.map((release): Node => ({ t: 'release', repo, release }));
      }
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.t) {
      case 'info': {
        const item = new vscode.TreeItem(node.label);
        if (node.command) item.command = node.command;
        if (node.tooltip) item.tooltip = node.tooltip;
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case 'owner': {
        const { group } = node;
        const item = new vscode.TreeItem(
          group.login,
          group.kind === 'user'
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon(
          group.kind === 'user' ? 'account' : group.kind === 'org' ? 'organization' : 'people',
        );
        if (group.kind !== 'colab')
          item.description = group.kind === 'user' ? l10n.t('you') : l10n.t('organization');
        item.contextValue = 'owner';
        return item;
      }
      case 'repo': {
        const item = new vscode.TreeItem(
          node.info ? node.info.full_name : name(node.repo),
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon(node.info?.private ? 'lock' : 'repo');
        if (node.info?.description) item.description = node.info.description;
        item.tooltip = new vscode.MarkdownString(
          `**${name(node.repo)}**${node.info?.description ? `\n\n${node.info.description}` : ''}${node.info?.pushed_at ? `\n\n${l10n.t('Last push: {0}', when(node.info.pushed_at))}` : ''}`,
        );
        item.contextValue = 'repo';
        return item;
      }
      case 'section': {
        const labels = {
          prs: ['Pull requests', 'git-pull-request'],
          issues: ['Issues', 'issues'],
          actions: ['Actions', 'play-circle'],
          releases: ['Releases', 'tag'],
        } as const;
        const [label, icon] = labels[node.section];
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.contextValue = `section-${node.section}`;
        return item;
      }
      case 'pr': {
        const { pull } = node;
        const item = new vscode.TreeItem(
          `#${String(pull.number)} ${pull.title}`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = `${pull.user?.login ?? ''} · ${pull.head.ref}`;
        item.iconPath = new vscode.ThemeIcon(
          pull.draft ? 'git-pull-request-draft' : 'git-pull-request',
        );
        item.contextValue = 'pr';
        item.tooltip = new vscode.MarkdownString(
          `**#${String(pull.number)} ${pull.title}**\n\n${pull.head.ref} → ${pull.base.ref}${pull.labels?.length ? `\n\n${l10n.t('Labels: {0}', pull.labels.map((l) => l.name).join(', '))}` : ''}`,
        );
        return item;
      }
      case 'apr': {
        const { item: data } = node;
        const item = new vscode.TreeItem(
          `#${String(data.number)} ${data.title}`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = `${data.repo}${data.author ? ` · ${data.author}` : ''}`;
        item.iconPath = new vscode.ThemeIcon(
          data.state === 'closed'
            ? 'git-pull-request-closed'
            : data.draft
              ? 'git-pull-request-draft'
              : 'git-pull-request',
        );
        item.contextValue = 'pr';
        item.tooltip = new vscode.MarkdownString(
          `**${data.repo}#${String(data.number)}**\n\n${data.title}${data.labels.length > 0 ? `\n\n${l10n.t('Labels: {0}', data.labels.join(', '))}` : ''}\n\n${l10n.t('Updated {0}', when(data.updatedAt))}`,
        );
        return item;
      }
      case 'prfile': {
        const { file } = node;
        const item = new vscode.TreeItem(file.filename.split('/').pop() ?? file.filename);
        item.description = `${file.filename.includes('/') ? file.filename.slice(0, file.filename.lastIndexOf('/')) : ''} +${String(file.additions)} -${String(file.deletions)}`;
        item.resourceUri = vscode.Uri.file(file.filename);
        item.command = {
          command: 'fakl.github.pr.openFile',
          title: l10n.t('Open diff'),
          arguments: [node],
        };
        return item;
      }
      case 'issue': {
        const { issue } = node;
        const item = new vscode.TreeItem(`#${String(issue.number)} ${issue.title}`);
        item.description = `${issue.user?.login ?? ''}${issue.comments > 0 ? ` · ${String(issue.comments)} 💬` : ''}`;
        item.iconPath = new vscode.ThemeIcon('issues');
        item.contextValue = 'issue';
        item.tooltip = new vscode.MarkdownString(
          `**#${String(issue.number)} ${issue.title}**\n\n${(issue.body ?? '').slice(0, 800)}`,
        );
        item.command = { command: 'fakl.github.show', title: l10n.t('Open'), arguments: [node] };
        return item;
      }
      case 'aissue': {
        const { item: data } = node;
        const item = new vscode.TreeItem(`#${String(data.number)} ${data.title}`);
        item.description = `${data.repo}${data.comments > 0 ? ` · ${String(data.comments)} 💬` : ''}`;
        item.iconPath = new vscode.ThemeIcon(data.state === 'closed' ? 'issue-closed' : 'issues');
        item.contextValue = 'issue';
        item.tooltip = new vscode.MarkdownString(
          `**${data.repo}#${String(data.number)}**\n\n${data.title}${data.labels.length > 0 ? `\n\n${l10n.t('Labels: {0}', data.labels.join(', '))}` : ''}\n\n${l10n.t('Updated {0}', when(data.updatedAt))}`,
        );
        item.command = { command: 'fakl.github.show', title: l10n.t('Open'), arguments: [node] };
        return item;
      }
      case 'run': {
        const { run } = node;
        const item = new vscode.TreeItem(
          `${run.name ?? run.display_title ?? 'workflow'} #${String(run.run_number)}`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        const inAccountView = this.kind === 'actions';
        item.description = `${inAccountView ? `${name(node.repo)} · ` : ''}${run.head_branch ?? ''} · ${run.event} · ${when(run.created_at)}`;
        item.iconPath = runIcon(run.status, run.conclusion);
        item.contextValue = run.status === 'completed' ? 'run-done' : 'run';
        item.tooltip = `${name(node.repo)}\n${run.display_title ?? ''}`;
        return item;
      }
      case 'job': {
        const { job } = node;
        const item = new vscode.TreeItem(job.name);
        item.iconPath = runIcon(job.status, job.conclusion);
        item.contextValue = 'job';
        item.command = {
          command: 'fakl.github.job.log',
          title: l10n.t('View log'),
          arguments: [node],
        };
        return item;
      }
      case 'release': {
        const { release } = node;
        const item = new vscode.TreeItem(release.name ?? release.tag_name);
        item.description = [
          release.tag_name,
          release.draft ? l10n.t('draft') : undefined,
          release.prerelease ? l10n.t('pre-release') : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
        item.iconPath = new vscode.ThemeIcon('tag');
        item.command = { command: 'fakl.github.show', title: l10n.t('Open'), arguments: [node] };
        return item;
      }
      case 'notifgroup': {
        const { group } = node;
        const item = new vscode.TreeItem(
          group.repo,
          group.unread > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description =
          group.unread > 0
            ? group.unread === 1
              ? l10n.t('1 unread')
              : l10n.t('{0} unread', String(group.unread))
            : group.items.length === 1
              ? l10n.t('1 read')
              : l10n.t('{0} read', String(group.items.length));
        item.iconPath = new vscode.ThemeIcon(group.unread > 0 ? 'bell-dot' : 'bell');
        item.contextValue = group.unread > 0 ? 'notifgroup' : 'notifgroup-read';
        return item;
      }
      case 'notification': {
        const n = node.notification;
        const item = new vscode.TreeItem(n.subject.title);
        item.description = `${n.reason.replace(/_/g, ' ')} · ${when(n.updated_at)}`;
        item.iconPath = new vscode.ThemeIcon(
          n.subject.type === 'PullRequest'
            ? 'git-pull-request'
            : n.subject.type === 'Issue'
              ? 'issues'
              : 'bell',
        );
        item.contextValue = n.unread ? 'notification' : 'notification-read';
        item.command = { command: 'fakl.github.show', title: l10n.t('Open'), arguments: [node] };
        return item;
      }
    }
  }
}

function refOf(repo: GhRepo): GhRepoRef {
  return parseRepoName(repo.full_name) ?? { owner: repo.full_name, name: '' };
}

/** Tela do painel em tela cheia que mostra o item da árvore. */
function routeOf(node: Node | undefined): Route | undefined {
  if (!node) return undefined;
  const repo = 'repo' in node ? { owner: node.repo.owner, name: node.repo.name } : undefined;
  switch (node.t) {
    case 'owner':
      return node.group.kind === 'colab' ? undefined : { view: 'user', login: node.group.login };
    case 'repo':
      return repo && { view: 'repo', ...repo, tab: 'code' };
    case 'section':
      return (
        repo && {
          view: 'repo',
          ...repo,
          tab: node.section === 'prs' ? 'pulls' : node.section,
        }
      );
    case 'pr':
      return repo && { view: 'pull', ...repo, number: node.pull.number, tab: 'conversation' };
    case 'apr':
      return repo && { view: 'pull', ...repo, number: node.item.number, tab: 'conversation' };
    case 'prfile':
      return repo && { view: 'pull', ...repo, number: node.pull.number, tab: 'files' };
    case 'issue':
      return repo && { view: 'issue', ...repo, number: node.issue.number };
    case 'aissue':
      return repo && { view: 'issue', ...repo, number: node.item.number };
    case 'run':
    case 'job':
      return repo && { view: 'run', ...repo, id: node.run.id };
    case 'release':
      return repo && { view: 'repo', ...repo, tab: 'releases' };
    case 'notifgroup':
      return { view: 'notifications' };
    case 'notification':
      return parseGitHubUrl(notificationUrl(node.notification)) ?? { view: 'notifications' };
    case 'info':
      return undefined;
  }
}

function issueRelations(): Record<IssueRelation, string> {
  return {
    involves: l10n.t('involving you'),
    assigned: l10n.t('assigned to you'),
    authored: l10n.t('created by you'),
  };
}

function nodeUrl(node: Node): string | undefined {
  switch (node.t) {
    case 'owner':
      return `https://github.com/${node.group.login}`;
    case 'repo':
      return node.info?.html_url ?? repoUrl(node.repo);
    case 'pr':
      return node.pull.html_url;
    case 'apr':
    case 'aissue':
      return node.item.url;
    case 'prfile':
      return `${node.pull.html_url}/files`;
    case 'issue':
      return node.issue.html_url;
    case 'run':
      return node.run.html_url;
    case 'job':
      return node.job.html_url ?? node.run.html_url;
    case 'release':
      return node.release.html_url;
    case 'notification':
      return notificationUrl(node.notification);
    default:
      return undefined;
  }
}

/** Filtros das visões, só em memória: voltam ao padrão ao reabrir a IDE. */
interface UiState {
  repoFilter: string;
  runFilter: RunFilterId;
  /** Repositórios (`dono/nome`, separados por vírgula) das Actions; vazio, os mais ativos. */
  runRepos: string;
  issueRelation: IssueRelation;
}

/**
 * Painéis do GitHub (RF-502, SDD 11.1, ADR 0020). A raiz é a conta inteira do
 * usuário: repositórios por dono e organização, o que foi atribuído a ele, as
 * revisões pedidas, os PRs e as issues dele, as Actions de todos os repos e as
 * notificações. O workspace aberto é só um atalho. PRs, issues e execuções de
 * repositórios fora do workspace abrem no navegador, mostram diff e log pela
 * API, e o checkout oferece clonar. O ETag faz as consultas sem mudança não
 * gastarem o limite da API.
 */
export class GitHubUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly trees = new Map<ViewKind, GitHubTree>();
  private readonly views = new Map<ViewKind, vscode.TreeView<Node>>();
  private readonly comments: vscode.CommentController;
  private readonly output = vscode.window.createOutputChannel('FaKL GitHub');
  private readonly full: GitHubFullPanel;
  private client: CoreClient | undefined;
  private cachedRepos: Promise<WorkspaceRepo[]> | undefined;
  private timer: NodeJS.Timeout | undefined;
  readonly state: UiState = {
    repoFilter: '',
    runFilter: 'todas',
    runRepos: '',
    issueRelation: 'involves',
  };

  constructor(
    readonly auth: GitHubAuth,
    extensionUri: vscode.Uri,
  ) {
    for (const kind of VIEW_KINDS) {
      const tree = new GitHubTree(kind, this);
      this.trees.set(kind, tree);
      const view = vscode.window.createTreeView(`fakl.github.${kind}`, {
        treeDataProvider: tree,
        showCollapseAll: kind === 'account' || kind === 'workspace' || kind === 'notifications',
      });
      this.views.set(kind, view);
      this.disposables.push(
        tree,
        view,
        view.onDidChangeVisibility(() => {
          this.schedule();
        }),
      );
    }
    this.full = new GitHubFullPanel(extensionUri, auth, {
      review: (repo, pull) => this.review({ t: 'pr', repo, pull }),
      merge: (repo, pull) => this.merge({ t: 'pr', repo, pull }),
      checkout: (repo, pull) => this.checkout({ t: 'pr', repo, pull }),
      toAgents: (repo, issue) => this.toAgents({ t: 'issue', repo, issue }),
      rerun: (repo, run) => this.rerun({ t: 'run', repo, run }),
      jobLog: (repo, run, job) => this.jobLog({ t: 'job', repo, run, job }),
      openDiff: (repo, pull, file) => this.openFile({ t: 'prfile', repo, pull, file }),
      clone: (repo) => this.clone(repo),
      newIssue: (repo) => this.newIssue({ t: 'repo', repo }),
      folderOf: (repo) => this.folderOf(repo),
      refreshTrees: () => {
        this.refresh();
      },
    });
    this.comments = vscode.comments.createCommentController('fakl-github', l10n.t('PR review'));
    this.comments.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        const info = parseFileUri(document.uri);
        if (document.uri.scheme !== SCHEME || info?.side !== 'head') return [];
        return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
      },
    };
    this.disposables.push(
      this.output,
      this.full,
      this.comments,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent: async (uri) => {
          const info = parseFileUri(uri);
          if (!info) return '';
          return (await this.auth.api.fileAt(info.repo, info.path, info.ref)) ?? '';
        },
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.uri.scheme === SCHEME) void this.loadThreads(document);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.cachedRepos = undefined;
        void this.updateWorkspaceContext();
        this.trees.get('workspace')?.refresh();
      }),
      vscode.window.onDidChangeWindowState((window) => {
        if (window.focused) this.poll();
      }),
      auth.onDidChange(() => {
        this.refresh();
      }),
      vscode.commands.registerCommand('fakl.github.refresh', () => {
        this.cachedRepos = undefined;
        this.refresh();
      }),
      vscode.commands.registerCommand('fakl.github.diagnose', () => this.diagnose()),
      vscode.commands.registerCommand('fakl.github.openFull', (node?: Node) => {
        this.full.open(routeOf(node));
      }),
      // Usado pelo café do CI: abre uma execução no painel de Actions (ou no navegador, sem login).
      vscode.commands.registerCommand(
        'fakl.github.openRun',
        (target?: { owner?: string; name?: string; id?: number; url?: string }) => {
          if (target?.owner && target.name && typeof target.id === 'number' && this.auth.signedIn) {
            this.full.open({ view: 'run', owner: target.owner, name: target.name, id: target.id });
          } else if (target?.url?.startsWith('https://github.com/')) {
            void vscode.env.openExternal(vscode.Uri.parse(target.url));
          }
        },
      ),
      vscode.commands.registerCommand('fakl.github.account.search', () => this.searchRepos()),
      vscode.commands.registerCommand('fakl.github.account.clearSearch', () => {
        this.state.repoFilter = '';
        this.trees.get('account')?.refresh();
      }),
      vscode.commands.registerCommand('fakl.github.issues.filter', () => this.filterIssues()),
      vscode.commands.registerCommand('fakl.github.actions.filter', () => this.filterRuns()),
      vscode.commands.registerCommand('fakl.github.open', (node: Node) => {
        const url = nodeUrl(node);
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
        if (node.t === 'notification' && node.notification.unread) {
          void this.markRead(node.notification.id);
        }
      }),
      // Clique no item da árvore: abre no painel; o navegador fica no botão do item.
      vscode.commands.registerCommand('fakl.github.show', (node: Node) => {
        // Notificação sem tela no painel (commit, discussão...) vai para o navegador.
        const route =
          node.t === 'notification'
            ? parseGitHubUrl(notificationUrl(node.notification))
            : routeOf(node);
        if (!route) {
          void vscode.commands.executeCommand('fakl.github.open', node);
          return;
        }
        this.full.open(route);
        if (node.t === 'notification' && node.notification.unread) {
          void this.markRead(node.notification.id);
        }
      }),
      vscode.commands.registerCommand('fakl.github.notification.markRead', (node: Node) => {
        if (node.t === 'notification') void this.markRead(node.notification.id);
      }),
      vscode.commands.registerCommand('fakl.github.notification.markGroupRead', (node: Node) => {
        if (node.t !== 'notifgroup') return;
        const repo = parseRepoName(node.group.repo);
        if (repo) void this.markAllRead(repo);
      }),
      vscode.commands.registerCommand('fakl.github.notification.markAllRead', () =>
        this.markAllRead(),
      ),
      vscode.commands.registerCommand('fakl.github.repo.clone', (node: Node) =>
        this.clone(node.t === 'repo' ? node.repo : undefined),
      ),
      vscode.commands.registerCommand('fakl.github.pr.openFile', (node: Node) =>
        this.openFile(node),
      ),
      vscode.commands.registerCommand('fakl.github.pr.review', (node: Node) => this.review(node)),
      vscode.commands.registerCommand('fakl.github.pr.merge', (node: Node) => this.merge(node)),
      vscode.commands.registerCommand('fakl.github.pr.checkout', (node: Node) =>
        this.checkout(node),
      ),
      vscode.commands.registerCommand('fakl.github.comment', (node: Node) => this.comment(node)),
      vscode.commands.registerCommand('fakl.github.issue.toAgents', (node: Node) =>
        this.toAgents(node),
      ),
      vscode.commands.registerCommand('fakl.github.issue.new', (node?: Node) =>
        this.newIssue(node),
      ),
      vscode.commands.registerCommand('fakl.github.run.rerun', (node: Node) => this.rerun(node)),
      vscode.commands.registerCommand('fakl.github.job.log', (node: Node) => this.jobLog(node)),
      vscode.commands.registerCommand('fakl.github.review.create', (reply: vscode.CommentReply) =>
        this.createReviewComment(reply),
      ),
    );
    void this.updateWorkspaceContext();
    this.schedule();
  }

  connected(client: CoreClient): void {
    this.client = client;
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  /** Repositórios do workspace: um atalho, já que a visão principal é a conta. */
  repos(): Promise<WorkspaceRepo[]> {
    this.cachedRepos ??= workspaceRepos();
    return this.cachedRepos;
  }

  refresh(): void {
    for (const tree of this.trees.values()) tree.refresh();
  }

  setBadge(unread: number): void {
    const view = this.views.get('notifications');
    if (view) {
      view.badge =
        unread > 0
          ? {
              value: unread,
              tooltip:
                unread === 1
                  ? l10n.t('1 unread notification')
                  : l10n.t('{0} unread notifications', String(unread)),
            }
          : undefined;
    }
  }

  setDescription(kind: ViewKind, text: string | undefined): void {
    const view = this.views.get(kind);
    if (view) view.description = text ?? '';
  }

  private async updateWorkspaceContext(): Promise<void> {
    const repos = await this.repos();
    await vscode.commands.executeCommand(
      'setContext',
      'fakl.github.workspaceRepo',
      repos.length > 0,
    );
  }

  /** Atualização leve: só painéis visíveis, só com a janela em foco e fora do limite da API. */
  private schedule(): void {
    const visible = [...this.views.values()].some((view) => view.visible);
    if (visible && !this.timer) {
      this.timer = setInterval(() => {
        this.poll();
      }, POLL_MS);
    } else if (!visible && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private poll(): void {
    const api = this.auth.api;
    if (!this.auth.signedIn || !vscode.window.state.focused) return;
    if (api.limitedUntil() !== undefined || api.limitedUntil('search') !== undefined) return;
    for (const [kind, tree] of this.trees) {
      if (this.views.get(kind)?.visible) tree.refresh();
    }
  }

  /** Pasta do workspace que é este repositório, se houver. */
  private async folderOf(repo: GhRepoRef): Promise<vscode.WorkspaceFolder | undefined> {
    const repos = await this.repos();
    return repos.find((r) => name(r.ref).toLowerCase() === name(repo).toLowerCase())?.folder;
  }

  /** Oferece clonar quando o repositório não está aberto. */
  private async offerClone(repo: GhRepoRef, text: string): Promise<void> {
    const clone = l10n.t('Clone');
    const pick = await vscode.window.showInformationMessage(text, clone, l10n.t('Open in browser'));
    if (pick === clone) await this.clone(repo);
    else if (pick) void vscode.env.openExternal(vscode.Uri.parse(repoUrl(repo)));
  }

  private async clone(repo: GhRepoRef | undefined): Promise<void> {
    if (!repo) return;
    await vscode.commands.executeCommand('git.clone', `${repoUrl(repo)}.git`);
  }

  private async markRead(id: string): Promise<void> {
    try {
      await this.auth.api.markNotificationRead(id);
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t("Couldn't mark the notification as read: {0}", message(error)),
      );
    }
    this.trees.get('notifications')?.refresh();
  }

  private async markAllRead(repo?: GhRepoRef): Promise<void> {
    try {
      await this.auth.api.markNotificationsRead(repo);
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t("Couldn't mark the notifications as read: {0}", message(error)),
      );
    }
    this.trees.get('notifications')?.refresh();
  }

  private async searchRepos(): Promise<void> {
    const text = await vscode.window.showInputBox({
      title: l10n.t('Search account repositories'),
      prompt: l10n.t('Part of the name or description, in any organization'),
      value: this.state.repoFilter,
    });
    if (text === undefined) return;
    this.state.repoFilter = text.trim();
    this.trees.get('account')?.refresh();
  }

  private async filterIssues(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      (Object.entries(issueRelations()) as [IssueRelation, string][]).map(([id, label]) => ({
        label,
        id,
        picked: id === this.state.issueRelation,
      })),
      { title: l10n.t('Show issues...') },
    );
    if (!picked) return;
    this.state.issueRelation = picked.id;
    this.trees.get('issues')?.refresh();
  }

  private async filterRuns(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      [
        ...RUN_FILTERS.map((f) => ({
          label: runFilterLabel(f.id),
          id: f.id,
          description: f.id === this.state.runFilter ? l10n.t('current') : '',
        })),
        {
          label: l10n.t('$(repo) Only some repositories…'),
          id: 'repos',
          description: this.state.runRepos,
        },
        { label: l10n.t('$(clear-all) Clear filters'), id: 'limpar', description: '' },
      ],
      { title: l10n.t('Actions from all repositories') },
    );
    if (!picked) return;
    if (picked.id === 'repos') {
      const text = await vscode.window.showInputBox({
        title: l10n.t('Actions repositories'),
        prompt: l10n.t(
          "owner/name, comma-separated; leave empty for the account's most active ones",
        ),
        value: this.state.runRepos,
      });
      if (text === undefined) return;
      this.state.runRepos = text.trim();
    } else if (picked.id === 'limpar') {
      this.state.runFilter = 'todas';
      this.state.runRepos = '';
    } else {
      this.state.runFilter = picked.id as RunFilterId;
    }
    this.trees.get('actions')?.refresh();
  }

  /**
   * "Diagnosticar acesso": confere o login, as organizações e, em cada uma,
   * se o token enxerga os repositórios (SSO, fine-grained), e diz o que fazer.
   * Nunca mostra o token.
   */
  private async diagnose(): Promise<void> {
    const out = this.output;
    out.clear();
    out.show(true);
    if (!this.auth.signedIn) {
      out.appendLine(l10n.t('Not signed in to GitHub. Use "FaKL: Sign in to GitHub".'));
      return;
    }
    const api = this.auth.api;
    const explain = (error: unknown): string => message(error);
    try {
      const user = await api.user();
      out.appendLine(l10n.t('Account: {0}', user.login));
    } catch (error) {
      out.appendLine(l10n.t("Couldn't read the account: {0}", explain(error)));
      return;
    }
    let orgs: { login: string }[] = [];
    try {
      orgs = await api.userOrgs();
      out.appendLine(
        orgs.length > 0
          ? l10n.t('Organizations visible to the token: {0}', orgs.map((o) => o.login).join(', '))
          : l10n.t('Organizations visible to the token: none'),
      );
      if (orgs.length === 0) {
        out.appendLine(
          `  ${l10n.t('If you belong to organizations and none show up, the token may be fine-grained without the organization, or missing the read:org scope (classic token).')}`,
        );
      }
    } catch (error) {
      out.appendLine(l10n.t('Organizations: {0}', explain(error)));
    }
    for (const org of orgs) {
      try {
        const repos = await api.orgRepos(org.login, { maxPages: 1 });
        out.appendLine(
          `  ${
            repos.length === 1
              ? l10n.t('{0}: ok (1 repository read)', org.login)
              : l10n.t('{0}: ok ({1} repositories read)', org.login, String(repos.length))
          }`,
        );
      } catch (error) {
        out.appendLine(`  ${org.login}: ${explain(error)}`);
      }
    }
    try {
      const list = await api.notifications();
      out.appendLine(l10n.t('Notifications: ok ({0})', String(list.length)));
    } catch (error) {
      out.appendLine(l10n.t('Notifications: {0}', explain(error)));
      out.appendLine(
        `  ${l10n.t("Fine-grained tokens can't access notifications; use the IDE GitHub account or a classic token with the notifications scope.")}`,
      );
    }
    try {
      const search = await api.searchIssues('is:open is:pr author:@me', { perPage: 1 });
      out.appendLine(
        search.total === 1
          ? l10n.t('PR/issue search: ok (1 open PR of yours)')
          : l10n.t('PR/issue search: ok ({0} open PRs of yours)', String(search.total)),
      );
    } catch (error) {
      out.appendLine(l10n.t('Search: {0}', explain(error)));
    }
    if (api.rateRemaining !== undefined) {
      out.appendLine(l10n.t('Requests left in this window: {0}', String(api.rateRemaining)));
    }
    out.appendLine('');
    out.appendLine(
      l10n.t(
        'SSO: if an organization requires SSO, open github.com/settings/tokens (or Authorized OAuth Apps) and use "Configure SSO" on the token. Details in docs/github.md.',
      ),
    );
  }

  private async openFile(node: Node): Promise<void> {
    if (node.t !== 'prfile') return;
    const { repo, pull, file } = node;
    const base = fileUri(repo, pull, file.previous_filename ?? file.filename, 'base');
    const head = fileUri(repo, pull, file.filename, 'head');
    await vscode.commands.executeCommand(
      'vscode.diff',
      base,
      head,
      `${name(repo)}#${String(pull.number)} ${file.filename}`,
      { preview: true },
    );
  }

  /** Comentários de revisão já feitos naquele arquivo viram threads no diff. */
  private async loadThreads(document: vscode.TextDocument): Promise<void> {
    const info = parseFileUri(document.uri);
    if (info?.side !== 'head' || !this.auth.signedIn) return;
    const comments = await this.auth.api
      .request<
        {
          id: number;
          path: string;
          line?: number | null;
          body: string;
          user: { login: string; avatar_url?: string } | null;
          in_reply_to_id?: number;
        }[]
      >('GET', `/repos/${repoPath(info.repo)}/pulls/${String(info.pr)}/comments?per_page=100`)
      .catch(() => []);
    const roots = comments.filter((c) => c.path === info.path && c.line && !c.in_reply_to_id);
    for (const root of roots) {
      const replies = comments.filter((c) => c.in_reply_to_id === root.id);
      const thread = this.comments.createCommentThread(
        document.uri,
        new vscode.Range((root.line ?? 1) - 1, 0, (root.line ?? 1) - 1, 0),
        [root, ...replies].map((c) => ({
          body: new vscode.MarkdownString(c.body),
          mode: vscode.CommentMode.Preview,
          author: {
            name: c.user?.login ?? '?',
            ...(c.user?.avatar_url ? { iconPath: vscode.Uri.parse(c.user.avatar_url) } : {}),
          },
        })),
      );
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      this.disposables.push(thread);
    }
  }

  /** Comentário novo numa linha do lado novo do diff vira comentário de revisão do PR. */
  private async createReviewComment(reply: vscode.CommentReply): Promise<void> {
    const info = parseFileUri(reply.thread.uri);
    const range = reply.thread.range;
    if (!info || !range) return;
    try {
      await this.auth.api.request(
        'POST',
        `/repos/${repoPath(info.repo)}/pulls/${String(info.pr)}/comments`,
        {
          body: reply.text,
          commit_id: info.ref,
          path: info.path,
          line: range.end.line + 1,
          side: 'RIGHT',
        },
      );
      reply.thread.comments = [
        ...reply.thread.comments,
        {
          body: new vscode.MarkdownString(reply.text),
          mode: vscode.CommentMode.Preview,
          author: { name: this.auth.user ?? l10n.t('you') },
        },
      ];
      reply.thread.canReply = false;
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t("Couldn't comment: {0}", message(error)));
    }
  }

  /** Repositório e número de um PR da lista do repo ou da busca da conta. */
  private prOf(node: Node): { repo: GhRepoRef; number: number } | undefined {
    if (node.t === 'pr') return { repo: node.repo, number: node.pull.number };
    if (node.t === 'apr') return { repo: node.repo, number: node.item.number };
    return undefined;
  }

  /** O PR completo (com branches e SHAs), buscando na API se veio da busca da conta. */
  private async pullOf(node: Node): Promise<GhPull | undefined> {
    if (node.t === 'pr') return node.pull;
    const target = this.prOf(node);
    return target ? await this.auth.api.pull(target.repo, target.number) : undefined;
  }

  private async review(node: Node): Promise<void> {
    const target = this.prOf(node);
    if (!target) return;
    const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { event: ReviewEvent }>(
      [
        { label: l10n.t('$(check) Approve'), event: 'APPROVE' },
        { label: l10n.t('$(request-changes) Request changes'), event: 'REQUEST_CHANGES' },
        { label: l10n.t('$(comment) Comment only'), event: 'COMMENT' },
      ],
      { title: l10n.t('Review {0}#{1}', name(target.repo), String(target.number)) },
    );
    if (!picked) return;
    const body = await vscode.window.showInputBox({
      title: l10n.t('Review comment'),
      prompt: picked.event === 'APPROVE' ? l10n.t('Optional') : l10n.t('Required'),
      ignoreFocusOut: true,
    });
    if (body === undefined || (picked.event !== 'APPROVE' && !body)) return;
    try {
      await this.auth.api.reviewPull(target.repo, target.number, picked.event, body);
      void vscode.window.showInformationMessage(
        l10n.t('Review submitted on #{0}.', String(target.number)),
      );
      this.trees.get('reviews')?.refresh();
      this.trees.get('myprs')?.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t("Couldn't submit the review: {0}", message(error)),
      );
    }
  }

  private async merge(node: Node): Promise<void> {
    try {
      const pull = await this.pullOf(node);
      const target = this.prOf(node);
      if (!pull || !target) return;
      const picked = await vscode.window.showQuickPick<
        vscode.QuickPickItem & { method: MergeMethod }
      >(
        [
          { label: 'Squash and merge', method: 'squash' },
          { label: 'Merge commit', method: 'merge' },
          { label: 'Rebase and merge', method: 'rebase' },
        ],
        {
          title: l10n.t(
            'Merge {0}#{1} into {2}',
            name(target.repo),
            String(pull.number),
            pull.base.ref,
          ),
        },
      );
      if (!picked) return;
      const ok = await vscode.window.showWarningMessage(
        l10n.t(
          'Merge {1}#{2} ({3}) into {4} using {0}?',
          picked.label.toLowerCase(),
          name(target.repo),
          String(pull.number),
          pull.title,
          pull.base.ref,
        ),
        { modal: true },
        l10n.t('Merge pull request'),
      );
      if (!ok) return;
      const result = await this.auth.api.mergePull(
        target.repo,
        pull.number,
        picked.method,
        picked.method === 'squash' ? `${pull.title} (#${String(pull.number)})` : undefined,
      );
      void vscode.window.showInformationMessage(result.message);
      this.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t('Merge rejected: {0}', message(error)));
    }
  }

  private async checkout(node: Node): Promise<void> {
    const target = this.prOf(node);
    if (!target) return;
    const folder = await this.folderOf(target.repo);
    if (!folder) {
      await this.offerClone(
        target.repo,
        l10n.t(
          "{0} isn't in the workspace. To check it out, clone the repository and open the folder.",
          name(target.repo),
        ),
      );
      return;
    }
    const local = `pr-${String(target.number)}`;
    const terminal = vscode.window.createTerminal({
      name: `PR #${String(target.number)}`,
      cwd: folder.uri,
    });
    terminal.show();
    terminal.sendText(
      `git fetch origin pull/${String(target.number)}/head:${local} && git checkout ${local}`,
    );
  }

  private async comment(node: Node): Promise<void> {
    const number =
      this.prOf(node)?.number ??
      (node.t === 'issue' ? node.issue.number : node.t === 'aissue' ? node.item.number : undefined);
    const repo =
      this.prOf(node)?.repo ?? (node.t === 'issue' || node.t === 'aissue' ? node.repo : undefined);
    if (number === undefined || !repo) return;
    const body = await vscode.window.showInputBox({
      title: l10n.t('Comment on {0}#{1}', name(repo), String(number)),
      prompt: 'Markdown',
      ignoreFocusOut: true,
    });
    if (!body) return;
    try {
      await this.auth.api.comment(repo, number, body);
      void vscode.window.showInformationMessage(l10n.t('Comment sent on #{0}.', String(number)));
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t("Couldn't comment: {0}", message(error)));
    }
  }

  /** "Mandar para agentes" (SDD 11.1): cria uma tarefa com origem `issue` e começa. */
  private async toAgents(node: Node): Promise<void> {
    if (node.t !== 'issue' && node.t !== 'aissue') return;
    const number = node.t === 'issue' ? node.issue.number : node.item.number;
    const title = node.t === 'issue' ? node.issue.title : node.item.title;
    if (!this.client) {
      void vscode.window.showWarningMessage(l10n.t('FaKL Core is not responding.'));
      return;
    }
    const folder = await this.folderOf(node.repo);
    if (!folder) {
      await this.offerClone(
        node.repo,
        l10n.t(
          "{0} isn't in the workspace. Agents work on a local copy: clone it and open the folder.",
          name(node.repo),
        ),
      );
      return;
    }
    const delivery = await vscode.window.showQuickPick(
      [
        {
          label: l10n.t('PR + merge into main'),
          description: l10n.t('plus the post-merge build, if configured'),
          value: 'pr-merge',
        },
        { label: l10n.t('Open PR'), value: 'pr' },
        { label: l10n.t('Leave on the branch'), value: 'branch' },
        { label: l10n.t('Merge locally'), value: 'merge' },
      ],
      { title: `#${String(number)} ${title}`, placeHolder: l10n.t('How to deliver?') },
    );
    if (!delivery) return;
    try {
      await this.client.request('tasks.fromIssue', {
        repoPath: folder.uri.fsPath,
        repo: name(node.repo),
        numero: number,
        entrega: delivery.value,
        comecar: true,
      });
      void vscode.window.showInformationMessage(
        l10n.t('Task created from #{0}; the maestro has started.', String(number)),
      );
      void vscode.commands.executeCommand('fakl.tasks.refresh');
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t("Couldn't create the task: {0}", message(error)));
    }
  }

  private async newIssue(node?: Node): Promise<void> {
    let repo: GhRepoRef | undefined =
      node?.t === 'repo' ? node.repo : node?.t === 'section' ? node.repo : undefined;
    if (!repo) {
      const [mine, open] = await Promise.all([
        this.auth.api.userRepos({ maxPages: 2 }).catch(() => []),
        this.repos(),
      ]);
      const names = [
        ...new Set([...open.map((r) => name(r.ref)), ...mine.map((r) => r.full_name)]),
      ];
      const picked = await vscode.window.showQuickPick(names, {
        title: l10n.t('Repository for the new issue'),
        placeHolder: l10n.t('Any repository in the account'),
      });
      repo = picked ? parseRepoName(picked) : undefined;
    }
    if (!repo) return;
    const title = await vscode.window.showInputBox({
      title: l10n.t('Issue title in {0}', name(repo)),
    });
    if (!title) return;
    const body = await vscode.window.showInputBox({ title: l10n.t('Description (optional)') });
    try {
      const issue = await this.auth.api.createIssue(repo, {
        title,
        ...(body ? { body } : {}),
      });
      this.trees.get('issues')?.refresh();
      const open = await vscode.window.showInformationMessage(
        l10n.t('Issue #{0} created.', String(issue.number)),
        l10n.t('Open'),
      );
      if (open) void vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t("Couldn't create the issue: {0}", message(error)));
    }
  }

  private async rerun(node: Node): Promise<void> {
    if (node.t !== 'run') return;
    try {
      await this.auth.api.rerun(node.repo, node.run.id, node.run.conclusion === 'failure');
      void vscode.window.showInformationMessage(l10n.t('Run started again.'));
      this.trees.get('actions')?.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t("Couldn't re-run: {0}", message(error)));
    }
  }

  private async jobLog(node: Node): Promise<void> {
    if (node.t !== 'job') return;
    try {
      const text = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: l10n.t('Log for {0}', node.job.name) },
        () => this.auth.api.jobLog(node.repo, node.job.id),
      );
      const document = await vscode.workspace.openTextDocument({ content: text, language: 'log' });
      const editor = await vscode.window.showTextDocument(document, { preview: true });
      const last = document.lineCount - 1;
      editor.revealRange(new vscode.Range(last, 0, last, 0));
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t('Log unavailable: {0}', message(error)));
    }
  }
}
