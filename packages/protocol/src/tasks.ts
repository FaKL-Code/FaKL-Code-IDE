/** Tarefas, execuções e rodadas do orquestrador (SDD 7 e 9). */

import type { AgentRecoveryInfo, PermissionPolicyName } from './agents.js';

/** `chat`: execução implícita de uma sessão do chat que chamou outros agentes. */
export type TaskOrigin = 'manual' | 'issue' | 'nota' | 'remoto' | 'cli' | 'chat';

export type LimitAction = 'perguntar' | 'rascunho' | 'escalar' | 'descartar';

export interface LimitRule {
  readonly valor: number;
  readonly acao?: LimitAction;
}

/** Limites de uma execução (RF-206); o mais específico vence: tarefa, playbook, global. */
export interface RunLimits {
  readonly rodadas?: LimitRule;
  readonly tempoMin?: LimitRule;
  readonly tokens?: LimitRule;
  readonly custoUsd?: LimitRule;
  /** Perfil do novo maestro na política `escalar`. */
  readonly perfilEscalada?: string;
  /** Multiplica os limites ao escalar; padrão 1,5. */
  readonly orcamentoExtra?: number;
  /** Até onde subagentes podem virar maestros (RF-203); padrão 2. */
  readonly profundidadeMaxima?: number;
}

export type LimitName = 'rodadas' | 'tempoMin' | 'tokens' | 'custoUsd';

/** Critério de pronto (SDD 9.4). */
export interface DoneCriteria {
  readonly comandos?: readonly string[];
  readonly checklist?: readonly string[];
  readonly revisao?: { readonly perfil?: string; readonly exigeAprovacao?: boolean };
}

/**
 * Como entregar o trabalho aprovado. `pr-merge` (o padrão) envia o branch,
 * abre o PR, faz o merge dele no GitHub e, se o config.yaml pedir
 * (`buildAposMerge`), dispara um workflow.
 */
export type Delivery = 'pr-merge' | 'merge' | 'pr' | 'branch';

export const DELIVERIES: readonly Delivery[] = ['pr-merge', 'merge', 'pr', 'branch'];

/** Entrega quando nem a tarefa nem o config.yaml escolhem uma. */
export const DEFAULT_DELIVERY: Delivery = 'pr-merge';

/** Workflow disparado no GitHub depois do merge da entrega `pr-merge`. */
export interface PostMergeBuild {
  /** Arquivo em `.github/workflows/`, por exemplo `build.yml`. */
  readonly workflow: string;
  /** Entradas do `workflow_dispatch`; só vão as que o workflow declara. */
  readonly inputs?: Readonly<Record<string, string>>;
}

export interface TaskDefinition {
  readonly titulo: string;
  readonly descricao?: string;
  readonly origem?: TaskOrigin;
  /** Pasta do repositório. */
  readonly repoPath: string;
  /** Branch de partida; padrão, o atual. */
  readonly branchBase?: string;
  readonly criterio?: DoneCriteria;
  readonly limites?: RunLimits;
  /** Perfis que o maestro pode chamar como subagentes; ausente permite todos. */
  readonly perfisPermitidos?: readonly string[];
  readonly maestroProfileId?: string;
  /** Papel → perfil obrigatório (RF-204), por exemplo `{ revisor: 'claude' }`. */
  readonly papeisFixados?: Readonly<Record<string, string>>;
  readonly playbook?: string;
  readonly entrega?: Delivery;
  /** Política de permissão dos agentes da tarefa; padrão, a da configuração. */
  readonly permissoes?: PermissionPolicyName;
  /** Link de origem: issue, nota do vault. */
  readonly referencia?: string;
}

export type TaskStatus = 'nova' | 'executando' | 'pausada' | 'concluída' | 'falhou' | 'cancelada';

export interface Task extends TaskDefinition {
  readonly id: string;
  readonly status: TaskStatus;
  readonly criadaEm: string;
  readonly runs: readonly string[];
}

export type RunStatus =
  'executando' | 'pausada' | 'aguardando-decisão' | 'concluída' | 'falhou' | 'descartada';

export interface CheckResult {
  readonly nome: string;
  readonly ok: boolean;
  /** Fim da saída, para o maestro e o usuário verem o que falhou. */
  readonly saida: string;
  readonly duracaoMs: number;
}

export interface Round {
  readonly numero: number;
  readonly inicio: string;
  readonly fim?: string;
  readonly verificacoes: readonly CheckResult[];
  readonly veredito?: 'passou' | 'falhou';
}

export interface DecisionOption {
  readonly id: string;
  readonly rotulo: string;
}

export interface Decision {
  readonly id: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly pergunta: string;
  readonly opcoes: readonly DecisionOption[];
  readonly escolha?: string;
  /** `autopilot`: a execução seguiu sozinha pela opção segura. */
  readonly origemResposta?: 'ide' | 'remoto' | 'cli' | 'autopilot';
  readonly criadaEm: string;
  readonly respondidaEm?: string;
  /** Decisão criada por um limite estourado. */
  readonly limite?: LimitName;
}

export interface RunAgent {
  readonly sessionId: string;
  readonly profileId: string;
  /** `maestro`, `executor`, `revisor` ou outro papel que o maestro escolher. */
  readonly papel: string;
  readonly parentSessionId?: string;
  readonly profundidade: number;
  readonly branch?: string;
}

export interface Run {
  readonly id: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly inicio: string;
  readonly fim?: string;
  /** Branch da tarefa, onde o maestro integra o trabalho. */
  readonly branch: string;
  readonly maestroSessionId?: string;
  readonly agentes: readonly RunAgent[];
  readonly rodadas: readonly Round[];
  readonly decisoes: readonly Decision[];
  readonly escalou?: boolean;
  readonly resultado?: 'merge' | 'pr' | 'rascunho' | 'branch' | 'descartado';
  readonly resumo?: string;
  readonly prUrl?: string;
  /** Build disparado depois do merge do PR (entrega `pr-merge`). */
  readonly buildUrl?: string;
  readonly motivo?: string;
  /** Execução preservada enquanto o provedor aguarda a renovação do limite. */
  readonly retomada?: AgentRecoveryInfo & { readonly sessionId: string };
  /** Início da espera atual, para não gastar o limite de tempo da tarefa. */
  readonly suspensaEm?: string;
  readonly esperaLimiteMs?: number;
}

/** Evento `run.limit` de uma execução. */
export interface RunLimitEventData {
  readonly tipo: 'execucao';
  readonly runId: string;
  readonly limite: LimitName;
  readonly valor: number;
  readonly atual: number;
  readonly acao: LimitAction;
}
