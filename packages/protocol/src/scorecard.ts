/** Placar dos agentes por perfil (ADR 0043). Tudo fica na máquina. */

/** Períodos que o placar sabe somar: os últimos 7 dias, os últimos 30 e o total guardado. */
export const SCORECARD_PERIODS = ['7d', '30d', 'total'] as const;
export type ScorecardPeriod = (typeof SCORECARD_PERIODS)[number];

export function isScorecardPeriod(value: unknown): value is ScorecardPeriod {
  return typeof value === 'string' && (SCORECARD_PERIODS as readonly string[]).includes(value);
}

/** Amostra mínima de tarefas para o placar ser usado como sinal pelo maestro. */
export const SCORECARD_MIN_TASKS = 5;

/** Uma linha do placar: um perfil de agente num período. */
export interface ScorecardEntry {
  readonly perfilId: string;
  /** Último nome conhecido do perfil; vale mesmo depois de ele ser apagado. */
  readonly nome: string;
  /** O perfil não existe mais; o histórico continua até zerar ou sair da retenção. */
  readonly removido?: boolean;
  readonly sessoes: number;
  /** Tarefas que terminaram com este perfil participando (concluídas, falhas e canceladas). */
  readonly tarefas: number;
  readonly tarefasConcluidas: number;
  readonly tarefasFalhas: number;
  readonly tarefasCanceladas: number;
  /** Duração de ponta a ponta das tarefas terminadas; ausente sem tarefas. */
  readonly duracaoMediaMs?: number;
  readonly duracaoMedianaMs?: number;
  readonly tokensEntrada: number;
  readonly tokensSaida: number;
  readonly custoUsd: number;
  /** Custo das sessões que pertencem a tarefas, dividido pelas tarefas terminadas. */
  readonly custoMedioTarefaUsd?: number;
  readonly arquivosAceitos: number;
  readonly arquivosRejeitados: number;
  /** aceitos / (aceitos + rejeitados), de 0 a 1; ausente quando nenhum arquivo foi decidido. */
  readonly taxaAprovacao?: number;
  /** Vezes que o perfil bateu um limite de uso (janela do plano ou teto diário). */
  readonly limites: number;
}

/** `scorecard.get`: parâmetros. Sem `periodo`, vale `30d`. */
export interface ScorecardGetParams {
  readonly periodo?: ScorecardPeriod;
}

export interface ScorecardResult {
  readonly periodo: ScorecardPeriod;
  /** Primeiro dia somado (AAAA-MM-DD, fuso local); ausente no total. */
  readonly desde?: string;
  /** Tarefas necessárias para um perfil contar como amostra suficiente. */
  readonly amostraMinima: number;
  /** Perfis com atividade no período, os de mais tarefas primeiro. */
  readonly perfis: readonly ScorecardEntry[];
}

/** Evento `agent.review`: arquivos do diff que o usuário aceitou ou rejeitou. */
export interface AgentReviewEventData {
  readonly aceitos: number;
  readonly rejeitados: number;
}

/**
 * Resumo curto do placar de um perfil, como o `list_profiles` do maestro o
 * entrega: um sinal, não uma regra. Abaixo da amostra mínima, só "poucos dados".
 */
export type ScorecardSummary =
  | {
      readonly periodo: ScorecardPeriod;
      readonly amostra: 'poucos dados';
      readonly tarefas: number;
    }
  | {
      readonly periodo: ScorecardPeriod;
      readonly amostra: 'suficiente';
      readonly tarefas: number;
      /** 0 a 1; ausente se nenhum arquivo foi decidido no diff. */
      readonly taxaAprovacao?: number;
      readonly duracaoMediaMin?: number;
      readonly custoMedioUsd?: number;
    };
