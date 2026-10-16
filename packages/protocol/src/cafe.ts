/** Cyber café (SDD 13): miniaturas sintéticas das telas e o estado da sala. */

import type { AgentState } from './agents.js';

export type ThumbnailKind = 'arquivo' | 'comando' | 'testes' | 'pensando' | 'resposta' | 'ocioso';

/** Evento `agent.thumbnail`: o que o monitor do PC do agente mostra (SDD 13.2). */
export interface AgentThumbnailEventData {
  readonly tipo: ThumbnailKind;
  /** Nome do arquivo, comando ou rótulo curto. */
  readonly titulo: string;
  /** Até 8 linhas de texto, já cortadas. */
  readonly linhas: readonly string[];
  /** Testes: passaram, falharam ou ainda rodando. */
  readonly resultado?: 'ok' | 'falhou' | 'rodando';
}

/** Um agente na sala. */
export interface CafeAgent {
  readonly sessionId: string;
  readonly nome: string;
  readonly profileId: string;
  readonly provedor: string;
  readonly state: AgentState;
  readonly papel?: string;
  readonly parentSessionId?: string;
  readonly runId?: string;
  readonly miniatura?: AgentThumbnailEventData;
}

/** Placar do dia (RF-606). */
export interface CafeScore {
  readonly dia: string;
  readonly tarefas: number;
  readonly prs: number;
  readonly custoUsd: number;
  /** Maior número de agentes numa execução hoje, para as conquistas. */
  readonly maxAgentes: number;
  /** PRs abertos por agentes desde sempre. */
  readonly prsTotal: number;
}

/** `cafe.state`. */
export interface CafeState {
  readonly agentes: readonly CafeAgent[];
  readonly placar: CafeScore;
  /** Execuções com limite estourado agora (relógio vermelho). */
  readonly limites: readonly string[];
}
