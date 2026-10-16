import { formatCost, formatTokens } from '@fakl/conversa';
import { l10n } from '@fakl/i18n';
import {
  isFinalAgentState,
  isLimitText,
  providerFamily,
  providerName,
  type AgentPermissionRequest,
  type AgentProfileEntry,
  type AgentSessionInfo,
  type ChatItem,
  type DailyCapEventData,
  type Decision,
  type FaklEvent,
  type ProviderFamily,
  type ProviderWindows,
  type Task,
  type UsageWindow,
} from '@fakl/protocol';

import {
  folderName,
  isWorking,
  stateLabel,
  type ClaudeAccountChoice,
} from '../../remote-pwa/src/model.js';

/**
 * Lógica do overlay sem DOM: o estado do pet, o que espera você, os grupos do
 * painel e o balão de mudança. O que já existe no app do celular (grupos de
 * tarefas, uso por provedor, contas do Claude, conversas) vem de lá.
 */

export {
  agentColor,
  ago,
  claudeAccountChoices,
  Conversations,
  folderName,
  groupTasks,
  latestRun,
  LiveLines,
  providerUsage,
  stateLabel,
  stateTone,
  type ClaudeAccountChoice,
  type ConversationPatch,
  type Tone,
} from '../../remote-pwa/src/model.js';

// ---------------------------------------------------------------- limites

// Os avisos de limite dos agentes são reconhecidos pelo Core também (`AgentSessionInfo.limite`).
export { isLimitText };

/**
 * Agentes parados por limite: pausados pelo teto diário (`run.limit`) ou que
 * avisaram em erro que a sessão de 5 h ou a semana acabou. Saem daqui assim
 * que voltam a trabalhar ou encerram.
 */
export class LimitTracker {
  private readonly sessions = new Map<string, string>();

  /** Aplica um evento; `true` quando o conjunto mudou. */
  apply(event: FaklEvent): boolean {
    switch (event.topic) {
      case 'run.limit': {
        const data = event.data as Partial<DailyCapEventData>;
        if (data.tipo !== 'teto-diario' || data.pausadas === undefined) return false;
        const motivo =
          data.provedor === undefined
            ? l10n.t('Daily cap reached for a provider')
            : l10n.t('Daily cap reached for {0}', data.provedor);
        for (const sessionId of data.pausadas) this.sessions.set(sessionId, motivo);
        return data.pausadas.length > 0;
      }
      case 'agent.output': {
        const data = event.data as { kind?: string; text?: string };
        if (data.kind !== 'error' || typeof data.text !== 'string' || !isLimitText(data.text)) {
          return false;
        }
        this.sessions.set(event.subject, firstLine(data.text));
        return true;
      }
      case 'agent.state': {
        const state = (event.data as { state?: AgentSessionInfo['state'] }).state;
        if (!state || !this.sessions.has(event.subject)) return false;
        if (isWorking(state) || isFinalAgentState(state)) {
          this.sessions.delete(event.subject);
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  /**
   * Traz o que o Core guardou: um limite anterior à abertura do overlay não
   * passou por aqui como evento. `true` quando o conjunto mudou.
   */
  sync(agents: readonly AgentSessionInfo[]): boolean {
    let changed = false;
    for (const agent of agents) {
      if (!agent.limite || isFinalAgentState(agent.state) || this.sessions.has(agent.sessionId)) {
        continue;
      }
      this.sessions.set(agent.sessionId, agent.limite.motivo);
      changed = true;
    }
    return changed;
  }

  /** Esquece quem não está mais na lista de agentes vivos. */
  prune(agents: readonly AgentSessionInfo[]): void {
    const live = new Set(
      agents.filter((a) => !isFinalAgentState(a.state)).map((agent) => agent.sessionId),
    );
    for (const sessionId of this.sessions.keys()) {
      if (!live.has(sessionId)) this.sessions.delete(sessionId);
    }
  }

  reason(sessionId: string): string | undefined {
    return this.sessions.get(sessionId);
  }

  ids(): ReadonlySet<string> {
    return new Set(this.sessions.keys());
  }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? text;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line.trim();
}

/** Provedores do teto diário que bateram o limite: os agentes pausados deles também contam. */
export function blockedByCap(
  agent: AgentSessionInfo,
  blocked: readonly string[],
  profiles: readonly AgentProfileEntry[],
): boolean {
  if (agent.state !== 'pausado' || blocked.length === 0) return false;
  const provider = profiles.find((p) => p.profile.id === agent.profileId)?.profile.provedor;
  return provider !== undefined && blocked.includes(provider);
}

// ---------------------------------------------------------------- o retrato

/** O que o overlay sabe agora; o pet, o painel e o balão saem daqui. */
export interface Snapshot {
  readonly agents: readonly AgentSessionInfo[];
  readonly permissions: readonly AgentPermissionRequest[];
  /** Decisões das execuções ainda sem escolha. */
  readonly decisions: readonly Decision[];
  /** Sessões paradas por limite. */
  readonly limited: ReadonlySet<string>;
  /** Sessões que falharam desde a última vez que o painel abriu. */
  readonly failed: ReadonlySet<string>;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  agents: [],
  permissions: [],
  decisions: [],
  limited: new Set(),
  failed: new Set(),
};

// ---------------------------------------------------------------- esperando você

export type Waiting =
  | {
      readonly kind: 'permissao';
      readonly request: AgentPermissionRequest;
      readonly agent?: AgentSessionInfo;
    }
  | { readonly kind: 'decisao'; readonly decision: Decision; readonly task?: Task }
  | { readonly kind: 'limite'; readonly agent: AgentSessionInfo }
  | { readonly kind: 'resposta'; readonly agent: AgentSessionInfo };

/** Chave estável de um item, para o painel não refazer o que não mudou. */
export function waitingKey(item: Waiting): string {
  switch (item.kind) {
    case 'permissao':
      return `p:${item.request.sessionId}/${item.request.id}`;
    case 'decisao':
      return `d:${item.decision.id}`;
    case 'limite':
      return `l:${item.agent.sessionId}`;
    case 'resposta':
      return `r:${item.agent.sessionId}`;
  }
}

/**
 * Tudo o que trava um agente até você agir, na ordem do painel: permissões,
 * decisões do maestro, agentes parados por limite e quem pediu uma resposta
 * sem pedido de permissão (o `ask` do agente).
 */
export function waitingFor(snapshot: Snapshot, tasks: readonly Task[] = []): Waiting[] {
  const byId = new Map(snapshot.agents.map((agent) => [agent.sessionId, agent]));
  const asked = new Set(snapshot.permissions.map((p) => p.sessionId));
  const items: Waiting[] = [];
  for (const request of snapshot.permissions) {
    const agent = byId.get(request.sessionId);
    items.push(agent ? { kind: 'permissao', request, agent } : { kind: 'permissao', request });
  }
  for (const decision of [...snapshot.decisions].sort((a, b) =>
    a.criadaEm.localeCompare(b.criadaEm),
  )) {
    if (decision.escolha !== undefined) continue;
    const task = tasks.find((t) => t.runs.includes(decision.runId));
    items.push(task ? { kind: 'decisao', decision, task } : { kind: 'decisao', decision });
  }
  for (const agent of snapshot.agents) {
    if (isFinalAgentState(agent.state)) continue;
    if (snapshot.limited.has(agent.sessionId)) items.push({ kind: 'limite', agent });
    else if (agent.state === 'aguardando-você' && !asked.has(agent.sessionId)) {
      items.push({ kind: 'resposta', agent });
    }
  }
  return items;
}

// ---------------------------------------------------------------- o pet

/**
 * Anel do pet: `quieto` (ninguém trabalhando), `trabalhando`, `espera`
 * (alguém espera você) e `falha` (falhou ou parou por limite, o que trava
 * mais e por isso vence).
 */
export type PetRing = 'quieto' | 'trabalhando' | 'espera' | 'falha';

export interface PetStatus {
  readonly ring: PetRing;
  /** Número do selo: quem espera você ou, sem ninguém esperando, quem trabalha. */
  readonly count: number;
  /** O que o pet diz a um leitor de tela. */
  readonly label: string;
}

export function petStatus(snapshot: Snapshot): PetStatus {
  const waiting = waitingFor(snapshot).length;
  const working = snapshot.agents.filter((agent) => isWorking(agent.state)).length;
  const blocked = snapshot.limited.size + snapshot.failed.size;
  const parts: string[] = [];
  const failed = snapshot.failed.size;
  if (waiting > 0) {
    parts.push(
      waiting === 1
        ? l10n.t('1 request waiting for you')
        : l10n.t('{0} requests waiting for you', waiting),
    );
  }
  if (working > 0) {
    parts.push(working === 1 ? l10n.t('1 agent working') : l10n.t('{0} agents working', working));
  }
  if (failed > 0) {
    parts.push(failed === 1 ? l10n.t('1 agent failed') : l10n.t('{0} agents failed', failed));
  }
  const label = parts.length > 0 ? parts.join(', ') : l10n.t('No agents working');
  if (blocked > 0) return { ring: 'falha', count: waiting || snapshot.failed.size, label };
  if (waiting > 0) return { ring: 'espera', count: waiting, label };
  if (working > 0) return { ring: 'trabalhando', count: working, label };
  return { ring: 'quieto', count: 0, label };
}

// ---------------------------------------------------------------- grupos do painel

export interface PanelGroups {
  readonly trabalhando: readonly AgentSessionInfo[];
  /** Vivos sem trabalhar: ociosos, pausados e os que esperam você. */
  readonly ociosos: readonly AgentSessionInfo[];
  readonly encerrados: readonly AgentSessionInfo[];
}

const activity = (agent: AgentSessionInfo): string =>
  agent.atividadeEm ?? agent.iniciadaEm ?? agent.encerradaEm ?? '';

export function panelGroups(agents: readonly AgentSessionInfo[]): PanelGroups {
  const newest = (a: AgentSessionInfo, b: AgentSessionInfo): number =>
    activity(b).localeCompare(activity(a));
  return {
    trabalhando: agents.filter((a) => isWorking(a.state)).sort(newest),
    ociosos: agents.filter((a) => !isWorking(a.state) && !isFinalAgentState(a.state)).sort(newest),
    encerrados: agents
      .filter((a) => isFinalAgentState(a.state))
      .sort((a, b) => (b.encerradaEm ?? activity(b)).localeCompare(a.encerradaEm ?? activity(a))),
  };
}

/** O nome da linha do agente: o perfil e a pasta, para dois Claudes não se confundirem. */
export function agentTitle(agent: AgentSessionInfo): string {
  return agent.titulo ?? folderName(agent.worktree?.branch ?? agent.cwd);
}

// ---------------------------------------------------------------- balão

/** Rótulo curto de um agente no balão. */
function who(agent: AgentSessionInfo | undefined): string {
  return agent?.nome ?? l10n.t('An agent');
}

/**
 * O balão do pet quando algo muda entre dois retratos, do mais urgente ao
 * menos; nada quando não há o que contar.
 */
export function balloon(before: Snapshot, after: Snapshot): string | undefined {
  const byId = new Map(after.agents.map((agent) => [agent.sessionId, agent]));
  const known = new Set(before.permissions.map((p) => `${p.sessionId}/${p.id}`));
  const permission = after.permissions.find((p) => !known.has(`${p.sessionId}/${p.id}`));
  if (permission)
    return l10n.t('{0} is asking for permission', who(byId.get(permission.sessionId)));

  const decided = new Set(before.decisions.map((d) => d.id));
  if (after.decisions.some((d) => !decided.has(d.id) && d.escolha === undefined)) {
    return l10n.t('The maestro is asking for a decision');
  }

  const limited = [...after.limited].find((id) => !before.limited.has(id));
  if (limited) return l10n.t('{0} hit the limit', who(byId.get(limited)));

  const previous = new Map(before.agents.map((agent) => [agent.sessionId, agent.state]));
  for (const agent of after.agents) {
    const was = previous.get(agent.sessionId);
    if (was === undefined || was === agent.state) continue;
    if (agent.state === 'falhou') return l10n.t('{0} has failed', agent.nome);
    if (agent.state === 'aguardando-você') return l10n.t('{0} is waiting for you', agent.nome);
  }
  for (const agent of after.agents) {
    const was = previous.get(agent.sessionId);
    if (was === undefined || !isWorking(was) || isWorking(agent.state)) continue;
    if (agent.state === 'ocioso' || agent.state === 'concluído') {
      return l10n.t('{0} finished', agent.nome);
    }
  }
  return undefined;
}

/** Quem passou a falhar entre dois retratos, para o anel ficar vermelho até você olhar. */
export function newFailures(before: Snapshot, after: Snapshot): string[] {
  const previous = new Map(before.agents.map((agent) => [agent.sessionId, agent.state]));
  return after.agents
    .filter((agent) => {
      const was = previous.get(agent.sessionId);
      return agent.state === 'falhou' && was !== undefined && was !== 'falhou';
    })
    .map((agent) => agent.sessionId);
}

// ---------------------------------------------------------------- nova conversa

/**
 * Pastas para uma conversa nova, a mais recente primeiro. Os worktrees da IDE
 * ficam de fora: começar ali seria trabalhar no branch de outro agente.
 */
export function recentFolders(agents: readonly AgentSessionInfo[], max = 8): string[] {
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const agent of [...agents].sort((a, b) => activity(b).localeCompare(activity(a)))) {
    // Num worktree, a pasta do projeto vem à parte; só um Core antigo deixa o worktree em `cwd`.
    const folder = agent.pastaOrigem ?? agent.cwd;
    const cwd = folder.replace(/\\/g, '/');
    if (cwd.includes('/.fakl/worktrees/')) continue;
    const key = cwd.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(folder);
    if (folders.length === max) break;
  }
  return folders;
}

/**
 * A conta para "Trocar de conta e continuar": a logada que não é a ativa,
 * com menos uso hoje. A conta padrão do CLI só entra se não houver outra.
 */
export function nextAccount(
  choices: readonly ClaudeAccountChoice[],
): ClaudeAccountChoice | undefined {
  const free = choices.filter((choice) => !choice.ativa && choice.logada);
  const slots = free.filter((choice) => choice.slot !== null);
  return [...(slots.length > 0 ? slots : free)].sort((a, b) => a.tokensHoje - b.tokensHoje)[0];
}

// ---------------------------------------------------------------- conversa compacta

/** Um passo da conversa compacta: uma fala, ou ferramentas e pensamentos recolhidos. */
export type CompactItem =
  | { readonly kind: 'fala'; readonly index: number; readonly item: ChatItem }
  | {
      readonly kind: 'passos';
      readonly tools: number;
      readonly thoughts: number;
      /** Título da última ferramenta, para dar uma ideia do que foi feito. */
      readonly last?: string;
      readonly running: boolean;
    };

/**
 * As últimas falas de uma conversa, com cada sequência de ferramentas e
 * pensamentos recolhida numa linha só. `max` conta só as falas.
 */
export function compactTranscript(items: readonly ChatItem[], max = 12): CompactItem[] {
  const out: CompactItem[] = [];
  let tools = 0;
  let thoughts = 0;
  let last: string | undefined;
  let running = false;
  const flush = (): void => {
    if (tools + thoughts === 0) return;
    out.push({ kind: 'passos', tools, thoughts, ...(last ? { last } : {}), running });
    tools = 0;
    thoughts = 0;
    last = undefined;
    running = false;
  };
  items.forEach((item, index) => {
    if (item.kind === 'tool') {
      tools++;
      last = item.title;
      running = item.status === 'in_progress' || item.status === 'pending';
    } else if (item.kind === 'thought') {
      thoughts++;
    } else {
      flush();
      out.push({ kind: 'fala', index, item });
    }
  });
  flush();
  let falas = 0;
  let start = out.length;
  while (start > 0 && falas < max) {
    start--;
    if (out[start]?.kind === 'fala') falas++;
  }
  return out.slice(start);
}

/** "3 ferramentas e 1 pensamento", para a linha recolhida. */
export function stepsLabel(step: Extract<CompactItem, { kind: 'passos' }>): string {
  const tools =
    step.tools === 0 ? '' : step.tools === 1 ? l10n.t('1 tool') : l10n.t('{0} tools', step.tools);
  const thoughts =
    step.thoughts === 0
      ? ''
      : step.thoughts === 1
        ? l10n.t('1 thought')
        : l10n.t('{0} thoughts', step.thoughts);
  return tools && thoughts ? l10n.t('{0} and {1}', tools, thoughts) : tools || thoughts;
}

/** Família do agente pelo provedor do perfil, para a cor (a mesma dos cartões da Mesa). */
export function family(agent: Pick<AgentSessionInfo, 'provedor'>): ProviderFamily {
  return providerFamily(agent.provedor);
}

/** Custo da sessão quando o agente informa; senão, os tokens. */
export function usageText(agent: AgentSessionInfo): string {
  return formatCost(agent.usage.cost) || `${formatTokens(agent.usage.totalTokens)} tok`;
}

/**
 * Dá para escrever ao agente: vivo, ou encerrado mas retomável (o Core reabre a
 * sessão em `agents.send`).
 */
export function canSend(agent: AgentSessionInfo | undefined): boolean {
  return agent !== undefined && (!isFinalAgentState(agent.state) || agent.retomavel === true);
}

/** O pedido oferece "permitir sempre nesta sessão" (ACP `allow_always`). */
export function offersAlways(request: AgentPermissionRequest): boolean {
  return request.options.some((option) => option.kind === 'allow_always');
}

/** Estado de um agente na linha do painel, com o limite quando há. */
export function agentStateText(agent: AgentSessionInfo, limited: boolean): string {
  return limited ? l10n.t('Hit the limit') : stateLabel(agent.state);
}

// ---------------------------------------------------------------- rascunhos

/** Rascunhos do compositor, por conversa; `nova` é o da conversa nova. */
export class Drafts {
  private readonly map = new Map<string, string>();

  get(key: string): string {
    return this.map.get(key) ?? '';
  }

  set(key: string, text: string): void {
    if (text === '') this.map.delete(key);
    else this.map.set(key, text);
  }
}

// ---------------------------------------------------------------- janelas dos planos

/** "2h 15min", "40min" ou "agora" até o instante dado. */
export function untilReset(resetaEm: number | undefined, now: number): string {
  if (resetaEm === undefined) return '';
  const minutes = Math.max(0, Math.ceil((resetaEm - now) / 60_000));
  if (minutes === 0) return l10n.t('now');
  if (minutes >= 24 * 60) {
    const days = Math.floor(minutes / (24 * 60));
    return `${String(days)}d ${String(Math.floor((minutes % (24 * 60)) / 60))}h`;
  }
  return minutes >= 60
    ? `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}min`
    : `${String(minutes)}min`;
}

/** "42%" com percentual, "12 req · 380k tok" na cota diária, "380k tok" só com tokens, "—" sem dado. */
export function describeWindow(window: UsageWindow | undefined): string {
  if (!window) return '—';
  if (window.fracao !== undefined) return `${String(Math.round(window.fracao * 100))}%`;
  const tokens = window.tokens === undefined ? '' : `${formatTokens(window.tokens)} tok`;
  if (window.requisicoes !== undefined) {
    return [`${String(window.requisicoes)} req`, tokens].filter(Boolean).join(' · ');
  }
  return tokens || '—';
}

export interface WindowLine {
  readonly rotulo: string;
  /** Percentual ou tokens. */
  readonly valor: string;
  /** Tempo até renovar, quando o provedor diz. */
  readonly zera: string;
  readonly fracao?: number;
}

export interface WindowRow {
  readonly nome: string;
  readonly origem: ProviderWindows['origem'];
  readonly linhas: readonly WindowLine[];
}

/** As janelas do Core como linhas do painel, uma por provedor ou conta. */
export function windowRows(windows: readonly ProviderWindows[], now: number): WindowRow[] {
  return windows.map((row) => {
    const line = (rotulo: string, window: UsageWindow): WindowLine => ({
      rotulo,
      valor: describeWindow(window),
      zera: untilReset(window.resetaEm, now),
      ...(window.fracao === undefined ? {} : { fracao: window.fracao }),
    });
    return {
      nome: row.nome ?? providerName(row.provedor),
      origem: row.origem,
      // Provedor configurado sem registro de uso: aparece, em vez de sumir do painel.
      linhas: row.semDados
        ? [{ rotulo: l10n.t('Usage'), valor: l10n.t('no data'), zera: '' }]
        : [
            ...(row.sessao ? [line(l10n.t('5h session'), row.sessao)] : []),
            ...(row.dia ? [line(l10n.t('Today'), row.dia)] : []),
            ...(row.semana ? [line(l10n.t('Week'), row.semana)] : []),
          ],
    };
  });
}
