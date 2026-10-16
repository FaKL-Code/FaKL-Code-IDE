/**
 * Tipos de `github.account.*` (ADR 0020): a visão da conta inteira do GitHub,
 * independente do repositório aberto. O token fica no Core; quem chama só vê
 * estes resultados.
 */

/** Item de busca da conta: PR ou issue de qualquer repositório. */
export interface GitHubAccountItem {
  /** `dono/nome` */
  readonly repo: string;
  readonly tipo: 'pr' | 'issue';
  readonly numero: number;
  readonly titulo: string;
  readonly estado: 'open' | 'closed';
  readonly rascunho: boolean;
  readonly autor?: string;
  readonly rotulos: readonly string[];
  readonly comentarios: number;
  readonly url: string;
  readonly atualizadoEm: string;
}

/** Resposta de `account.prs.*` e `account.issues.mine`. */
export interface GitHubAccountItems {
  /** Total que a busca encontrou (pode passar do que veio em `itens`). */
  readonly total: number;
  readonly itens: readonly GitHubAccountItem[];
}

/** Parâmetros de `account.prs.*` e `account.issues.mine`. */
export interface GitHubAccountSearchParams {
  readonly estado?: 'aberto' | 'fechado' | 'todos';
  /** Restringe a um repositório (`dono/nome`) ou organização (`org:nome`). */
  readonly repo?: string;
  readonly org?: string;
  readonly limite?: number;
}

/** Item de `account.repos.list`. */
export interface GitHubAccountRepo {
  readonly repo: string;
  readonly privado: boolean;
  readonly arquivado: boolean;
  readonly fork: boolean;
  readonly descricao?: string;
  readonly branchPadrao: string;
  readonly ultimoPushEm?: string;
  readonly url: string;
}

/** Item de `account.orgs.list`. */
export interface GitHubAccountOrg {
  readonly login: string;
  readonly descricao?: string;
}

/** Execução do Actions de `account.actions.recent`. */
export interface GitHubAccountRun {
  readonly repo: string;
  readonly id: number;
  readonly nome?: string;
  readonly branch: string | null;
  readonly status: string | null;
  readonly conclusao: string | null;
  readonly evento: string;
  readonly url: string;
  readonly criadoEm: string;
}

/** Resposta de `account.actions.recent`. */
export interface GitHubAccountRuns {
  readonly execucoes: readonly GitHubAccountRun[];
  readonly repositorios: number;
  /** Repositórios que não puderam ser lidos (SSO, Actions desligado, sem acesso). */
  readonly erros: readonly { readonly repo: string; readonly mensagem: string }[];
}

/** Notificação de `account.notifications.list`. */
export interface GitHubAccountNotification {
  readonly id: string;
  readonly repo: string;
  readonly tipo: string;
  readonly titulo: string;
  readonly motivo: string;
  readonly naoLida: boolean;
  readonly url: string;
  readonly atualizadaEm: string;
}
