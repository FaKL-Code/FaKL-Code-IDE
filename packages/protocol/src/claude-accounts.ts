/** Quantas contas do Claude a IDE guarda ao mesmo tempo (ADR 0021). */
export const CLAUDE_ACCOUNT_SLOTS = [1, 2, 3] as const;
export type ClaudeAccountSlot = (typeof CLAUDE_ACCOUNT_SLOTS)[number];

export function isClaudeAccountSlot(value: unknown): value is ClaudeAccountSlot {
  return (CLAUDE_ACCOUNT_SLOTS as readonly unknown[]).includes(value);
}

/** Uso de hoje de uma conta, somado das sessões que a usaram. */
export interface ClaudeAccountUsage {
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  readonly custoUsd: number;
}

/** Uma das contas do Claude; nunca carrega token, só o que o status do CLI expõe. */
export interface ClaudeAccountInfo {
  readonly slot: ClaudeAccountSlot;
  readonly apelido: string;
  /** Pasta de configuração isolada (`CLAUDE_CONFIG_DIR`) do slot. */
  readonly dir: string;
  /** `true`/`false` conforme o status do CLI; `undefined` se não deu para saber. */
  readonly logada?: boolean;
  readonly email?: string;
  readonly plano?: string;
  readonly ativa: boolean;
  readonly uso: ClaudeAccountUsage;
}

/** `claude.accounts.list`. */
export interface ClaudeAccountsState {
  /** Slot usado por padrão ao criar agentes Claude; sem ele, vale a conta padrão do CLI. */
  readonly ativa?: ClaudeAccountSlot;
  readonly contas: readonly ClaudeAccountInfo[];
  /**
   * Pasta comum das conversas do Claude Code (`projects/` de todos os slots,
   * ADR 0027). Como o histórico é um só, o uso de cada conta sai da atribuição.
   */
  readonly compartilhada?: string;
  /** Arquivo de atribuição (`ClaudeAccountAttribution`): de que conta é cada conversa, ao longo do tempo. */
  readonly atribuicao?: string;
}

/** A partir de `desde` (epoch ms), vale a conta `slot`; `null` é a conta padrão do CLI. */
export interface ClaudeAttributionEntry {
  readonly slot: ClaudeAccountSlot | null;
  readonly desde: number;
}

/**
 * Arquivo `contas.json` da pasta comum, sem segredos: diz a que conta pertence
 * o uso gravado no histórico compartilhado. Vale a entrada mais recente com
 * `desde` até o instante da resposta: primeiro a da sessão, senão a da conta ativa.
 */
export interface ClaudeAccountAttribution {
  /** Conta ativa ao longo do tempo, em ordem cronológica (terminais e agentes sem conta própria). */
  readonly ativas: readonly ClaudeAttributionEntry[];
  /** Por id de sessão do Claude Code (o nome do `.jsonl`): a conta com que o Core a rodou. */
  readonly sessoes: Readonly<Record<string, readonly ClaudeAttributionEntry[]>>;
  /** Última atividade (epoch ms) de cada sessão; sem atividade há 8 dias, a sessão sai do arquivo. */
  readonly vistas?: Readonly<Record<string, number>>;
  /** Quando o histórico antigo dos slots foi migrado (entradas com `desde: 0`). */
  readonly migradoEm?: number;
}

/** `claude.accounts.prepare`: o que a IDE precisa para abrir o terminal de login do slot. */
export interface ClaudeAccountLogin {
  readonly slot: ClaudeAccountSlot;
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly comando: string;
}

/** Conta usada por uma sessão, para o chat e a Mesa mostrarem. */
export interface ClaudeAccountRef {
  readonly slot: ClaudeAccountSlot;
  readonly apelido: string;
}

/** `claude.accounts.setActive`: a conta escolhida e se os agentes abertos devem trocar também. */
export interface ClaudeAccountSetActiveParams {
  /** `null` volta à conta padrão do CLI (`~/.claude`). */
  readonly slot: ClaudeAccountSlot | null;
  /** Troca também os agentes Claude abertos (padrão `true`); `false` vale só para os novos. */
  readonly aplicarEmAbertos?: boolean;
}

/**
 * Evento `claude.account` (assunto `claude`): a conta ativa mudou. A IDE usa
 * `env` nos terminais; a conversa dos agentes continua, porque o histórico do
 * Claude Code (`projects/`) é compartilhado entre as contas.
 */
export interface ClaudeAccountEventData {
  readonly ativa?: ClaudeAccountSlot;
  /** Pasta de configuração da conta ativa; ausente na conta padrão do CLI. */
  readonly dir?: string;
  /** Variáveis para terminais e processos novos (`CLAUDE_CONFIG_DIR`); vazio na conta padrão. */
  readonly env: Readonly<Record<string, string>>;
  /** Sessões de agente que trocaram (ou vão trocar ao fim da vez) de conta. */
  readonly sessoes: readonly string[];
}
