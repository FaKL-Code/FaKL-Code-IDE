/**
 * Recortes dos objetos da API REST do GitHub: só os campos que a IDE e o
 * Core usam. Os nomes seguem a API (snake_case).
 */

export interface GhRepoRef {
  readonly owner: string;
  readonly name: string;
}

export interface GhUser {
  readonly login: string;
  readonly id: number;
  readonly name?: string | null;
  readonly avatar_url?: string;
  readonly html_url?: string;
}

export interface GhRepo {
  readonly full_name: string;
  readonly default_branch: string;
  readonly private: boolean;
  readonly html_url: string;
  readonly name?: string;
  readonly owner?: { readonly login: string };
  readonly description?: string | null;
  readonly fork?: boolean;
  readonly archived?: boolean;
  readonly pushed_at?: string | null;
  readonly updated_at?: string | null;
  readonly open_issues_count?: number;
  readonly has_issues?: boolean;
  readonly language?: string | null;
  readonly stargazers_count?: number;
  readonly forks_count?: number;
  readonly watchers_count?: number;
  readonly topics?: readonly string[];
  readonly homepage?: string | null;
  readonly license?: { readonly spdx_id?: string | null; readonly name: string } | null;
  /** Cor da linguagem (`#rrggbb`); só vem nos fixados, lidos pelo GraphQL. */
  readonly language_color?: string | null;
}

/** O que o perfil do GitHub mostra e a REST não tem: fixados e total de estrelas. */
export interface GhProfileExtras {
  /** Repositórios fixados no perfil, na ordem escolhida pelo dono. */
  readonly pinned: GhRepo[];
  /** Repositórios com estrela (só para usuários). */
  readonly stars?: number;
}

/** Perfil público de um usuário ou organização (`/users/{login}`). */
export interface GhProfile {
  readonly login: string;
  readonly id: number;
  readonly type: 'User' | 'Organization' | 'Bot';
  readonly name?: string | null;
  readonly avatar_url?: string;
  readonly html_url: string;
  readonly bio?: string | null;
  readonly company?: string | null;
  readonly blog?: string | null;
  readonly location?: string | null;
  readonly public_repos?: number;
  readonly followers?: number;
  readonly following?: number;
  readonly created_at?: string;
}

/** Item de `contents`: arquivo, pasta, link simbólico ou submódulo. */
export interface GhContent {
  readonly type: 'file' | 'dir' | 'symlink' | 'submodule';
  readonly name: string;
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly html_url?: string | null;
  readonly download_url?: string | null;
  /** Só num arquivo pedido sozinho: o conteúdo, em geral base64. */
  readonly content?: string;
  readonly encoding?: string;
}

export interface GhCommit {
  readonly sha: string;
  readonly html_url: string;
  readonly commit: {
    readonly message: string;
    readonly author?: { readonly name?: string; readonly date?: string } | null;
  };
  readonly author?: GhUser | null;
}

export interface GhBranch {
  readonly name: string;
  readonly protected?: boolean;
}

/** Check run de um commit (CI que não é só Actions). */
export interface GhCheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url?: string | null;
  readonly details_url?: string | null;
  readonly app?: { readonly name?: string } | null;
}

export interface GhOrg {
  readonly login: string;
  readonly id: number;
  readonly description?: string | null;
  readonly avatar_url?: string;
}

/** Item de `search/issues`: issue ou PR de qualquer repositório da conta. */
export interface GhSearchItem extends GhIssue {
  readonly repository_url: string;
  readonly draft?: boolean;
  readonly assignees?: readonly GhUser[];
  readonly created_at?: string;
}

/** Item da busca da conta já com o repositório e o tipo resolvidos. */
export interface GhAccountItem {
  readonly repo: string;
  readonly kind: 'pr' | 'issue';
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly draft: boolean;
  readonly author: string | undefined;
  readonly labels: readonly string[];
  readonly comments: number;
  readonly url: string;
  readonly updatedAt: string;
}

/** Execução do Actions com o repositório de onde veio. */
export type GhAccountRun = GhWorkflowRun & { readonly repo: string };

export interface GhLabel {
  readonly name: string;
  readonly color?: string;
}

export interface GhPull {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: 'open' | 'closed';
  readonly draft?: boolean;
  readonly merged?: boolean;
  readonly merged_at?: string | null;
  readonly mergeable?: boolean | null;
  readonly mergeable_state?: string;
  readonly html_url: string;
  readonly user: GhUser | null;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha: string };
  readonly labels?: readonly GhLabel[];
  readonly updated_at: string;
  readonly created_at?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changed_files?: number;
}

export interface GhPullFile {
  readonly filename: string;
  readonly previous_filename?: string;
  readonly status:
    'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface GhReview {
  readonly id: number;
  readonly user: GhUser | null;
  readonly state: string;
  readonly body?: string | null;
  readonly submitted_at?: string;
}

export interface GhIssue {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: 'open' | 'closed';
  readonly html_url: string;
  readonly user: GhUser | null;
  readonly labels: readonly (GhLabel | string)[];
  readonly comments: number;
  readonly updated_at: string;
  /** Presente quando o item é um PR. */
  readonly pull_request?: unknown;
}

export interface GhComment {
  readonly id: number;
  readonly body: string;
  readonly user: GhUser | null;
  readonly created_at: string;
  readonly html_url: string;
}

export interface GhWorkflowRun {
  readonly id: number;
  readonly name?: string | null;
  readonly display_title?: string;
  readonly head_branch: string | null;
  readonly head_sha: string;
  readonly event: string;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly run_number: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface GhJob {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string | null;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
}

export interface GhRelease {
  readonly id: number;
  readonly tag_name: string;
  readonly name?: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly html_url: string;
  readonly published_at?: string | null;
  readonly body?: string | null;
  readonly author?: GhUser | null;
}

export interface GhNotification {
  readonly id: string;
  readonly unread: boolean;
  readonly reason: string;
  readonly updated_at: string;
  readonly subject: {
    readonly title: string;
    readonly type: string;
    readonly url?: string | null;
  };
  readonly repository: { readonly full_name: string; readonly html_url: string };
}
