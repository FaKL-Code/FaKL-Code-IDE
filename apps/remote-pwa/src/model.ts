import { currentLocale, l10n } from '@fakl/i18n';
import { Transcript, usageRing, type UsageRing } from '@fakl/conversa';
import {
  isFinalAgentState,
  providerFamily,
  type AgentSessionInfo,
  type AgentState,
  type AgentTranscriptResult,
  type ChatItem,
  type ClaudeAccountSlot,
  type ClaudeAccountsState,
  type CostSummary,
  type FaklEvent,
  type ProviderFamily,
  type Run,
  type RunStatus,
  type Task,
} from '@fakl/protocol';

/**
 * Lógica do app sem DOM: agrupar agentes, tons de estado, uso do dia e o
 * cache das conversas. Fica aqui para ser testada com Vitest.
 */

export type Tone = 'atencao' | 'ativo' | 'ocioso' | 'pausa' | 'bom' | 'ruim' | 'neutro';

export function stateLabel(state: AgentState): string {
  switch (state) {
    case 'preparando':
      return l10n.t('Preparing');
    case 'ocioso':
      return l10n.t('Waiting for a message');
    case 'pensando':
      return l10n.t('Thinking');
    case 'executando':
      return l10n.t('Working');
    case 'aguardando-permissão':
      return l10n.t('Needs permission');
    case 'aguardando-você':
      return l10n.t('Needs you');
    case 'pausado':
      return l10n.t('Paused');
    case 'concluído':
      return l10n.t('Finished');
    case 'falhou':
      return l10n.t('Failed');
    case 'parado':
      return l10n.t('Stopped');
  }
}

export function stateTone(state: AgentState): Tone {
  switch (state) {
    case 'aguardando-permissão':
    case 'aguardando-você':
      return 'atencao';
    case 'preparando':
    case 'pensando':
    case 'executando':
      return 'ativo';
    case 'ocioso':
      return 'ocioso';
    case 'pausado':
      return 'pausa';
    case 'concluído':
      return 'bom';
    case 'falhou':
      return 'ruim';
    case 'parado':
      return 'neutro';
  }
}

/** O agente está trabalhando agora (para o indicador de digitação). */
export function isWorking(state: AgentState): boolean {
  return stateTone(state) === 'ativo';
}

export interface AgentGroups {
  /** Esperando você: permissão ou resposta. */
  readonly atencao: readonly AgentSessionInfo[];
  /** Vivos: trabalhando, ociosos ou pausados. */
  readonly ativos: readonly AgentSessionInfo[];
  /** Já encerrados; não voltam. */
  readonly encerrados: readonly AgentSessionInfo[];
}

const byNewest =
  (pick: (agent: AgentSessionInfo) => string | undefined) =>
  (a: AgentSessionInfo, b: AgentSessionInfo): number =>
    (pick(b) ?? '').localeCompare(pick(a) ?? '');

/**
 * Separa os agentes vivos dos encerrados, com quem espera você primeiro. Uma
 * sessão com pedido de permissão pendente vai para a atenção mesmo que o
 * estado ainda não tenha chegado.
 */
export function groupAgents(
  agents: readonly AgentSessionInfo[],
  pending: ReadonlySet<string> = new Set(),
): AgentGroups {
  const atencao: AgentSessionInfo[] = [];
  const ativos: AgentSessionInfo[] = [];
  const encerrados: AgentSessionInfo[] = [];
  for (const agent of agents) {
    if (isFinalAgentState(agent.state)) encerrados.push(agent);
    else if (stateTone(agent.state) === 'atencao' || pending.has(agent.sessionId))
      atencao.push(agent);
    else ativos.push(agent);
  }
  const activity = byNewest((a) => a.atividadeEm ?? a.iniciadaEm);
  atencao.sort(activity);
  // Quem está trabalhando vem antes de quem está parado esperando.
  ativos.sort((a, b) => {
    const rank = (agent: AgentSessionInfo): number => (isWorking(agent.state) ? 0 : 1);
    return rank(a) - rank(b) || activity(a, b);
  });
  encerrados.sort(byNewest((a) => a.encerradaEm ?? a.atividadeEm ?? a.iniciadaEm));
  return { atencao, ativos, encerrados };
}

/** "agora", "há 5 min", "há 2 h", "ontem" ou a data. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return l10n.t('now');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return l10n.t('{0} min ago', minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return l10n.t('{0} h ago', hours);
  if (hours < 48) return l10n.t('yesterday');
  return new Date(then).toLocaleDateString(currentLocale() === 'pt-br' ? 'pt-BR' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
  });
}

/** Última pasta de um caminho, em Windows ou Unix. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

const FAMILY_COLORS: Readonly<Record<ProviderFamily, string>> = {
  claude: '#fbbf24',
  codex: '#34d399',
  gemini: '#a78bfa',
  local: '#f472b6',
  outro: '#22d3ee',
};

/** Cor do agente pelo provedor do perfil, a mesma dos cartões da Mesa. */
export function agentColor(agent: Pick<AgentSessionInfo, 'provedor'>): string {
  return FAMILY_COLORS[providerFamily(agent.provedor)];
}

/**
 * O uso de hoje por provedor, com os que têm teto mesmo sem gasto. Quem bateu
 * o teto vem primeiro, depois quem está mais perto dele.
 */
export function providerUsage(summary: CostSummary | undefined): UsageRing[] {
  if (!summary) return [];
  const names = new Set([...Object.keys(summary.porProvedor), ...Object.keys(summary.tetos)]);
  const zero = { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };
  return [...names]
    .map((provedor) =>
      usageRing(
        provedor,
        summary.porProvedor[provedor] ?? zero,
        summary.tetos[provedor],
        summary.bloqueados.includes(provedor),
      ),
    )
    .sort(
      (a, b) =>
        Number(b.bloqueado) - Number(a.bloqueado) ||
        (b.fracao ?? -1) - (a.fracao ?? -1) ||
        a.provedor.localeCompare(b.provedor),
    );
}

/** O provedor mais perto do teto, para o anel do topo; sem tetos, nada. */
export function closestCap(summary: CostSummary | undefined): UsageRing | undefined {
  return providerUsage(summary).find((ring) => ring.bloqueado || ring.fracao !== undefined);
}

/** Uma opção da troca de conta do Claude; `slot` `null` é a conta padrão do CLI. */
export interface ClaudeAccountChoice {
  readonly slot: ClaudeAccountSlot | null;
  readonly nome: string;
  readonly email?: string;
  readonly plano?: string;
  /** `false` só quando o CLI disse que não há login; sem saber, vale como logada. */
  readonly logada: boolean;
  /** O Core não informa o login da conta padrão: o celular avisa antes de trocar. */
  readonly semStatus?: boolean;
  readonly ativa: boolean;
  /** Tokens de hoje gastos pelos agentes nesta conta. */
  readonly tokensHoje: number;
  /** Agentes vivos rodando nesta conta agora. */
  readonly agentes: number;
}

/**
 * As contas do Claude para o celular escolher: os slots da IDE e, por último,
 * a conta padrão do Claude Code (`~/.claude`), que vale quando nenhum slot
 * está ativo. Sem contas configuradas, nada. `isClaude` diz quais agentes
 * rodam o Claude Code; os que não têm slot estão na conta padrão.
 */
export function claudeAccountChoices(
  state: ClaudeAccountsState | undefined,
  agents: readonly AgentSessionInfo[],
  isClaude: (agent: AgentSessionInfo) => boolean = (agent) => agent.contaClaude !== undefined,
): ClaudeAccountChoice[] {
  if (!state || state.contas.length === 0) return [];
  const live = agents.filter((a) => !isFinalAgentState(a.state) && isClaude(a));
  const running = (slot: ClaudeAccountSlot | null): number =>
    live.filter((a) => (a.contaClaude?.slot ?? null) === slot).length;
  const choices: ClaudeAccountChoice[] = state.contas.map((conta) => ({
    slot: conta.slot,
    nome: conta.apelido,
    ...(conta.email ? { email: conta.email } : {}),
    ...(conta.plano ? { plano: conta.plano } : {}),
    logada: conta.logada !== false,
    ativa: state.ativa === conta.slot,
    tokensHoje: conta.uso.tokensEntrada + conta.uso.tokensSaida,
    agentes: running(conta.slot),
  }));
  return [
    ...choices,
    {
      slot: null,
      nome: l10n.t('Default Claude Code account'),
      logada: true,
      semStatus: true,
      ativa: state.ativa === undefined,
      tokensHoje: 0,
      agentes: running(null),
    },
  ];
}

const LIVE_RUNS: ReadonlySet<RunStatus> = new Set(['executando', 'pausada', 'aguardando-decisão']);

export function latestRun(task: Task, runs: ReadonlyMap<string, Run>): Run | undefined {
  const id = task.runs.at(-1);
  return id ? runs.get(id) : undefined;
}

/** Tarefas em andamento e as recentes, cada grupo da mais nova para a mais velha. */
export function groupTasks(
  tasks: readonly Task[],
  runs: ReadonlyMap<string, Run>,
): { andamento: Task[]; recentes: Task[] } {
  const andamento: Task[] = [];
  const recentes: Task[] = [];
  const sorted = [...tasks].sort((a, b) => b.criadaEm.localeCompare(a.criadaEm));
  for (const task of sorted) {
    const run = latestRun(task, runs);
    const live = run ? LIVE_RUNS.has(run.status) : task.status === 'executando';
    (live ? andamento : recentes).push(task);
  }
  return { andamento, recentes };
}

// ---------------------------------------------------------------- conversas

/** Itens guardados por conversa no celular. */
export const MAX_ITEMS = 1_500;

export interface ConversationPatch {
  readonly sessionId: string;
  /** Índices que mudaram; com `reset`, redesenhe tudo. */
  readonly indexes: readonly number[];
  readonly reset: boolean;
}

interface Conversation {
  transcript?: Transcript;
  /** Eventos que chegaram enquanto a conversa carregava. */
  buffer: FaklEvent[];
  lastEvent?: string;
  omitidos: number;
}

/**
 * As conversas abertas no celular. Cada uma começa pelo que o Core montou
 * (`agents.transcript`) e segue com os eventos ao vivo; um evento já contado
 * no retrato (id até `ultimoEvento`) não entra de novo.
 */
export class Conversations {
  private readonly map = new Map<string, Conversation>();
  /** Conversas que não carregaram, com o motivo; não tentam de novo sozinhas. */
  private readonly failures = new Map<string, string>();

  /** A conversa está pronta para mostrar. */
  items(sessionId: string): readonly ChatItem[] | undefined {
    return this.map.get(sessionId)?.transcript?.items;
  }

  omitidos(sessionId: string): number {
    return this.map.get(sessionId)?.omitidos ?? 0;
  }

  /** Aberta, carregando ou com falha: em todos os casos, não peça de novo sozinho. */
  has(sessionId: string): boolean {
    return this.map.has(sessionId) || this.failures.has(sessionId);
  }

  failure(sessionId: string): string | undefined {
    return this.failures.get(sessionId);
  }

  /** Não carregou; fica assim até `retry` ou uma conexão nova. */
  fail(sessionId: string, reason: string): void {
    this.map.delete(sessionId);
    this.failures.set(sessionId, reason);
  }

  retry(sessionId: string): void {
    this.failures.delete(sessionId);
  }

  /** Começa a carregar: os eventos a partir daqui esperam o retrato. */
  begin(sessionId: string): void {
    this.map.set(sessionId, { buffer: [], omitidos: 0 });
  }

  /** Chegou o retrato do Core; aplica por cima o que veio enquanto carregava. */
  load(sessionId: string, result: AgentTranscriptResult): ConversationPatch {
    const entry = this.map.get(sessionId) ?? { buffer: [], omitidos: 0 };
    const transcript = Transcript.from(result.items);
    entry.transcript = transcript;
    entry.omitidos = result.omitidos;
    if (result.ultimoEvento) entry.lastEvent = result.ultimoEvento;
    const buffer = entry.buffer;
    entry.buffer = [];
    this.map.set(sessionId, entry);
    for (const event of buffer) this.apply(event);
    return { sessionId, indexes: [], reset: true };
  }

  clear(): void {
    this.map.clear();
    this.failures.clear();
  }

  /** Aplica um evento ao vivo; nada quando a conversa não está aberta. */
  apply(event: FaklEvent): ConversationPatch | undefined {
    const entry = this.map.get(event.subject);
    if (!entry) return undefined;
    const transcript = entry.transcript;
    if (!transcript) {
      entry.buffer.push(event);
      return undefined;
    }
    if (entry.lastEvent !== undefined && event.id <= entry.lastEvent) return undefined;
    entry.lastEvent = event.id;
    const indexes = transcript.apply(event);
    if (indexes.length === 0) return undefined;
    const dropped = transcript.trim(MAX_ITEMS);
    if (dropped > 0) {
      entry.omitidos += dropped;
      return { sessionId: event.subject, indexes: [], reset: true };
    }
    return { sessionId: event.subject, indexes, reset: false };
  }
}

/**
 * O que cada agente está dizendo agora, montado dos pedaços de `agent.output`
 * para a lista não precisar pedir a conversa inteira.
 */
export class LiveLines {
  private readonly text = new Map<string, string>();
  private readonly speaking = new Set<string>();

  apply(event: FaklEvent): boolean {
    if (event.topic !== 'agent.output') {
      // Depois de uma ferramenta ou de uma mensagem, a fala seguinte é outra.
      if (event.topic === 'agent.prompt' || event.topic === 'agent.tool') {
        this.speaking.delete(event.subject);
      }
      return false;
    }
    const data = event.data as { kind?: string; text?: string };
    if (data.kind !== 'message' || typeof data.text !== 'string') {
      this.speaking.delete(event.subject);
      return false;
    }
    const before = this.speaking.has(event.subject) ? (this.text.get(event.subject) ?? '') : '';
    // Só o fim interessa: a última linha.
    this.text.set(event.subject, (before + data.text).slice(-2_000));
    this.speaking.add(event.subject);
    return true;
  }

  get(sessionId: string): string | undefined {
    return this.text.get(sessionId);
  }
}
