/**
 * Protocolo do GitHub em tela cheia (ADR 0030): rotas internas, modelos das
 * telas e mensagens entre a extensão e a webview. Só tipos; a lógica fica em
 * github-full-model.ts. O token nunca entra aqui: a webview recebe dados já
 * lidos da API pela extensão.
 */

export type RepoTab = 'code' | 'issues' | 'pulls' | 'actions' | 'releases';
export type PullTab = 'conversation' | 'files' | 'checks';
export type ListState = 'open' | 'closed';
/** Abas do perfil; `people` é a de organizações (membros). */
export type UserTab = 'overview' | 'repositories' | 'stars' | 'followers' | 'following' | 'people';
/** Filtro "Tipo" da lista de repositórios, como no GitHub. */
export type RepoType = 'all' | 'public' | 'private' | 'sources' | 'forks' | 'archived';
export type RepoSort = 'updated' | 'name' | 'stars';

/** Busca e filtros da aba Repositórios; ausentes valem o padrão (tudo, por atualização). */
export interface RepoFilters {
  readonly q?: string;
  readonly type?: RepoType;
  readonly language?: string;
  readonly sort?: RepoSort;
}

/** Endereço de uma tela do painel. */
export type Route =
  | { readonly view: 'home' }
  | { readonly view: 'search'; readonly q: string }
  | { readonly view: 'notifications' }
  | ({
      readonly view: 'user';
      readonly login: string;
      /** Sem aba, a visão geral. */
      readonly tab?: UserTab;
    } & RepoFilters)
  | {
      readonly view: 'repo';
      readonly owner: string;
      readonly name: string;
      readonly tab: RepoTab;
      /** Branch, tag ou SHA; sem ele, o branch padrão. */
      readonly ref?: string;
      /** Pasta aberta na aba Código. */
      readonly path?: string;
      /** Filtro das abas Issues e Pull requests. */
      readonly state?: ListState;
    }
  | {
      readonly view: 'file';
      readonly owner: string;
      readonly name: string;
      readonly path: string;
      readonly ref?: string;
    }
  | {
      readonly view: 'pull';
      readonly owner: string;
      readonly name: string;
      readonly number: number;
      readonly tab: PullTab;
    }
  | {
      readonly view: 'issue';
      readonly owner: string;
      readonly name: string;
      readonly number: number;
    }
  | { readonly view: 'run'; readonly owner: string; readonly name: string; readonly id: number };

export type ItemState = 'open' | 'closed' | 'merged' | 'draft';
export type RunState = 'success' | 'failure' | 'running' | 'queued' | 'cancelled' | 'neutral';

export interface Person {
  readonly login: string;
  readonly avatar?: string;
}

export interface LabelView {
  readonly name: string;
  /** `#rrggbb`, quando o GitHub mandou a cor. */
  readonly color?: string;
  /** Texto escuro ou claro sobre a cor do rótulo. */
  readonly ink: 'dark' | 'light';
}

export interface ItemRow {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly kind: 'pr' | 'issue';
  readonly title: string;
  readonly state: ItemState;
  readonly author?: string;
  readonly labels: readonly LabelView[];
  readonly comments: number;
  readonly updatedAt: string;
}

export interface RepoRow {
  readonly owner: string;
  readonly name: string;
  readonly description?: string;
  readonly private: boolean;
  readonly fork: boolean;
  readonly archived: boolean;
  readonly language?: string;
  /** Cor da linguagem, quando a API manda (fixados). */
  readonly languageColor?: string;
  readonly stars: number;
  readonly forks: number;
  readonly updatedAt?: string;
}

export interface RepoHeader extends RepoRow {
  readonly defaultBranch: string;
  readonly openIssues: number;
  readonly topics: readonly string[];
  readonly homepage?: string;
  readonly license?: string;
  readonly url: string;
}

export interface RunRow {
  readonly owner: string;
  readonly name: string;
  readonly id: number;
  readonly title: string;
  readonly workflow: string;
  readonly number: number;
  readonly branch?: string;
  readonly event: string;
  readonly state: RunState;
  readonly createdAt: string;
}

export interface NotificationRow {
  readonly id: string;
  readonly unread: boolean;
  readonly reason: string;
  readonly title: string;
  readonly type: string;
  readonly repo: string;
  readonly updatedAt: string;
  /** Rota no painel, quando o assunto é PR, issue ou repositório. */
  readonly route?: Route;
  readonly url: string;
}

export interface NotificationGroupView {
  readonly repo: string;
  readonly unread: number;
  readonly items: readonly NotificationRow[];
}

export interface EntryView {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'dir' | 'symlink' | 'submodule';
  readonly size: number;
}

export interface CommitView {
  readonly sha: string;
  readonly message: string;
  readonly author?: string;
  readonly avatar?: string;
  readonly date?: string;
}

export interface LanguageShare {
  readonly name: string;
  /** 0–100, com uma casa. */
  readonly percent: number;
}

export interface ReleaseView {
  readonly tag: string;
  readonly name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly publishedAt?: string;
  readonly body?: string;
  readonly author?: string;
  readonly url: string;
}

/** Markdown e o lugar dele no repositório, para resolver links relativos. */
export interface MarkdownDoc {
  readonly markdown: string;
  /** Pasta do arquivo (`''` na raiz). */
  readonly dir: string;
  readonly ref: string;
}

export interface TimelineEntry {
  readonly kind: 'comment' | 'review';
  readonly author?: Person;
  readonly date: string;
  readonly body: string;
  /** Nas revisões: APPROVED, CHANGES_REQUESTED, COMMENTED... */
  readonly review?: string;
}

export interface PullFileView {
  readonly filename: string;
  readonly previous?: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface CheckView {
  readonly name: string;
  readonly state: RunState;
  readonly url?: string;
  readonly app?: string;
}

export interface JobView {
  readonly id: number;
  readonly name: string;
  readonly state: RunState;
  readonly startedAt?: string;
  readonly seconds?: number;
}

export type RepoBody =
  | {
      readonly tab: 'code';
      readonly ref: string;
      readonly path: string;
      readonly branches: readonly string[];
      readonly entries: readonly EntryView[];
      readonly readme?: MarkdownDoc & { readonly path: string };
      readonly lastCommit?: CommitView;
      readonly languages: readonly LanguageShare[];
      readonly releases: readonly ReleaseView[];
      readonly contributors: readonly Person[];
    }
  | {
      readonly tab: 'issues' | 'pulls';
      readonly state: ListState;
      readonly items: readonly ItemRow[];
      readonly hasMore: boolean;
    }
  | { readonly tab: 'actions'; readonly runs: readonly RunRow[]; readonly hasMore: boolean }
  | {
      readonly tab: 'releases';
      readonly releases: readonly ReleaseView[];
      readonly hasMore: boolean;
    }
  /** Repositório sem nenhum commit: a API de conteúdo responde 404 ou 409. */
  | { readonly tab: 'empty'; readonly cloneUrl: string };

/** Mais uma página de uma lista da tela atual ("Carregar mais"). */
export type MoreRows =
  | { readonly kind: 'items'; readonly items: readonly ItemRow[] }
  | { readonly kind: 'runs'; readonly runs: readonly RunRow[] }
  | { readonly kind: 'repos'; readonly repos: readonly RepoRow[] }
  | { readonly kind: 'releases'; readonly releases: readonly ReleaseView[] }
  | { readonly kind: 'people'; readonly people: readonly Person[] };

export interface ProfileView extends Person {
  readonly name?: string;
  readonly kind: 'User' | 'Organization' | 'Bot';
  readonly bio?: string;
  readonly company?: string;
  readonly blog?: string;
  readonly location?: string;
  readonly followers?: number;
  readonly following?: number;
  readonly publicRepos?: number;
  readonly url: string;
  /** É a conta logada: a lista de repositórios inclui os privados. */
  readonly mine: boolean;
}

/** Conteúdo da aba aberta do perfil. */
export type UserBody =
  | {
      readonly tab: 'overview';
      /** README do perfil (`login/login`, ou `.github/profile` numa organização). */
      readonly readme?: MarkdownDoc & {
        readonly owner: string;
        readonly name: string;
        readonly path: string;
      };
      /** Fixados pelo dono; sem fixados, os mais populares. */
      readonly repos: readonly RepoRow[];
      readonly reposKind: 'pinned' | 'popular';
    }
  | {
      readonly tab: 'repositories';
      readonly filters: Required<Omit<RepoFilters, 'language'>> & { readonly language?: string };
      /** Linguagens de todos os repositórios lidos, para o filtro. */
      readonly languages: readonly string[];
      /** Quantos passam nos filtros. */
      readonly total: number;
      readonly repos: readonly RepoRow[];
      readonly hasMore: boolean;
      /** A lista parou no limite de leitura; o resto fica no GitHub. */
      readonly truncated: boolean;
    }
  | { readonly tab: 'stars'; readonly repos: readonly RepoRow[]; readonly hasMore: boolean }
  | {
      readonly tab: 'followers' | 'following' | 'people';
      readonly people: readonly Person[];
      readonly hasMore: boolean;
    };

export type FileBody =
  | { readonly kind: 'markdown'; readonly doc: MarkdownDoc }
  | { readonly kind: 'code'; readonly text: string; readonly lang: string }
  | { readonly kind: 'image'; readonly src: string }
  | { readonly kind: 'binary' | 'large' };

/** Dados de uma tela, já no formato da webview. */
export type Page =
  | {
      readonly view: 'home';
      readonly me: Person & { readonly name?: string };
      readonly reviews: readonly ItemRow[];
      readonly mine: readonly ItemRow[];
      readonly assigned: readonly ItemRow[];
      /** Totais da busca: as listas mostram só os primeiros. */
      readonly totals: {
        readonly reviews: number;
        readonly mine: number;
        readonly assigned: number;
      };
      readonly notifications: readonly NotificationRow[];
      /** `undefined` quando o token não lê notificações (fine-grained). */
      readonly notificationsError?: string;
      readonly repos: readonly RepoRow[];
    }
  | {
      readonly view: 'search';
      readonly q: string;
      readonly total: number;
      readonly repos: readonly RepoRow[];
      readonly hasMore: boolean;
    }
  | {
      readonly view: 'notifications';
      readonly groups: readonly NotificationGroupView[];
      /** A lista foi cortada no limite de páginas; o resto fica no GitHub. */
      readonly truncated: boolean;
    }
  | {
      readonly view: 'user';
      readonly profile: ProfileView;
      /** Organizações do usuário, ou membros (os primeiros) da organização. */
      readonly circle: readonly Person[];
      /** Totais das abas, quando conhecidos. */
      readonly counts: {
        readonly repositories?: number;
        readonly stars?: number;
      };
      readonly body: UserBody;
    }
  | { readonly view: 'repo'; readonly repo: RepoHeader; readonly body: RepoBody }
  | {
      readonly view: 'file';
      readonly repo: RepoHeader;
      readonly path: string;
      readonly ref: string;
      readonly size: number;
      readonly body: FileBody;
      /** Há uma pasta do workspace com este repositório. */
      readonly local: boolean;
    }
  | {
      readonly view: 'pull';
      readonly repo: RepoHeader;
      readonly tab: PullTab;
      readonly number: number;
      readonly title: string;
      readonly state: ItemState;
      readonly author?: Person;
      readonly createdAt?: string;
      readonly base: string;
      readonly head: string;
      readonly body: MarkdownDoc;
      readonly labels: readonly LabelView[];
      readonly additions: number;
      readonly deletions: number;
      readonly changedFiles: number;
      readonly mergeable?: boolean;
      readonly timeline: readonly TimelineEntry[];
      readonly files: readonly PullFileView[];
      readonly checks: readonly CheckView[];
      readonly url: string;
    }
  | {
      readonly view: 'issue';
      readonly repo: RepoHeader;
      readonly number: number;
      readonly title: string;
      readonly state: ItemState;
      readonly author?: Person;
      readonly createdAt?: string;
      readonly body: MarkdownDoc;
      readonly labels: readonly LabelView[];
      readonly timeline: readonly TimelineEntry[];
      readonly url: string;
    }
  | {
      readonly view: 'run';
      readonly repo: RepoHeader;
      readonly run: RunRow & { readonly sha: string; readonly url: string };
      readonly jobs: readonly JobView[];
    }
  | { readonly view: 'signedOut' };

/** Mensagens da extensão para a webview. */
export type FullToWebview =
  | {
      readonly type: 'navigate';
      readonly route: Route;
      readonly canBack: boolean;
      readonly canForward: boolean;
      /** Conta logada, para o atalho do perfil no topo. */
      readonly viewer?: Person;
    }
  | { readonly type: 'page'; readonly key: string; readonly page: Page }
  | {
      readonly type: 'error';
      readonly key: string;
      readonly message: string;
      /** Próximo passo sugerido, quando há um. */
      readonly fix?: 'login' | 'diagnose' | 'sso';
      /** Link para autorizar o token na organização (SSO). */
      readonly url?: string;
    }
  | { readonly type: 'notice'; readonly text: string }
  | {
      readonly type: 'more';
      readonly key: string;
      readonly rows: MoreRows;
      readonly hasMore: boolean;
    }
  /** Resposta a um comentário, pelo id que a webview mandou. */
  | {
      readonly type: 'commentResult';
      readonly id: string;
      readonly ok: boolean;
      readonly error?: string;
    }
  /** A notificação foi marcada como lida no GitHub. */
  | { readonly type: 'markedRead'; readonly id: string };

/** Ações sobre a tela atual; a extensão acha o item no que ela mesma carregou. */
export type FullAction =
  | 'review'
  | 'merge'
  | 'checkout'
  | 'toAgents'
  | 'rerun'
  | 'clone'
  | 'newIssue'
  | 'openInEditor'
  | 'markAllRead'
  | 'login'
  | 'diagnose';

/** Maior comentário que o GitHub aceita. */
export const COMMENT_LIMIT = 65_536;

/** Mensagens da webview para a extensão. Toda mensagem é validada antes de usar. */
export type FullFromWebview =
  | { readonly type: 'ready' }
  | {
      readonly type: 'navigate';
      readonly route: Route;
      /** Troca a entrada atual do histórico em vez de empilhar (busca digitada). */
      readonly replace?: boolean;
    }
  | { readonly type: 'back' }
  | { readonly type: 'forward' }
  | { readonly type: 'reload' }
  | { readonly type: 'external'; readonly url: string }
  | { readonly type: 'action'; readonly action: FullAction }
  | {
      readonly type: 'comment';
      /** Id da requisição, devolvido em `commentResult`. */
      readonly id: string;
      /** Chave da tela onde o comentário foi escrito: só vale se ainda for a atual. */
      readonly key: string;
      readonly number: number;
      readonly body: string;
    }
  | { readonly type: 'more'; readonly key: string }
  | { readonly type: 'openDiff'; readonly filename: string }
  | { readonly type: 'jobLog'; readonly jobId: number }
  | { readonly type: 'markRead'; readonly id: string };
