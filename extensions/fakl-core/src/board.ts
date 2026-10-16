import { l10n } from '@fakl/i18n';
import {
  isFinalAgentState,
  type AgentSessionInfo,
  type AgentState,
  type AgentStateEventData,
  type AgentModeEventData,
  type AgentOptionsEventData,
  type AgentUsageInfo,
  type FaklEvent,
} from '@fakl/protocol';

/** Grupo de ações da mesa de controle conforme o estado (RF-108). */
export type AgentActionGroup = 'ativo' | 'ocupado' | 'pausado' | 'encerrado';

export function actionGroup(state: AgentState): AgentActionGroup {
  if (isFinalAgentState(state)) return 'encerrado';
  if (state === 'pausado') return 'pausado';
  if (state === 'pensando' || state === 'executando' || state === 'aguardando-permissão') {
    return 'ocupado';
  }
  return 'ativo';
}

/** Ícone (codicon) de cada estado. */
export const STATE_ICONS: Record<AgentState, string> = {
  preparando: 'loading~spin',
  ocioso: 'circle-outline',
  pensando: 'sync~spin',
  executando: 'gear~spin',
  'aguardando-permissão': 'shield',
  'aguardando-você': 'comment-discussion',
  pausado: 'debug-pause',
  concluído: 'pass',
  falhou: 'error',
  parado: 'circle-slash',
};

/**
 * Estado do agente como aparece na árvore e nas listas. Em pt-BR é o próprio
 * valor do protocolo, menos a pausa, que é "em pausa" para servir também às
 * tarefas e execuções.
 */
export function stateLabel(state: AgentState): string {
  switch (state) {
    case 'preparando':
      return l10n.t('starting');
    case 'ocioso':
      return l10n.t('idle');
    case 'pensando':
      return l10n.t('thinking');
    case 'executando':
      return l10n.t('running');
    case 'aguardando-permissão':
      return l10n.t('awaiting permission');
    case 'aguardando-você':
      return l10n.t('waiting for you');
    case 'pausado':
      return l10n.t('paused');
    case 'concluído':
      return l10n.t('finished');
    case 'falhou':
      return l10n.t('failed');
    case 'parado':
      return l10n.t('stopped');
  }
}

export function formatCost(usage: AgentUsageInfo): string | undefined {
  if (!usage.cost) return undefined;
  const { amount, currency } = usage.cost;
  const text = amount.toFixed(amount < 1 ? 4 : 2);
  return currency === 'USD' ? l10n.t('${0}', text) : `${currency} ${text}`;
}

export function formatUsage(usage: AgentUsageInfo): string {
  const cost = formatCost(usage);
  return cost ? `${usage.totalTokens} tokens, ${cost}` : `${usage.totalTokens} tokens`;
}

/** Linha curta ao lado do nome do agente na árvore. */
export function describe(session: AgentSessionInfo): string {
  const cost = formatCost(session.usage);
  const mode = session.permissoes === 'autopilot' ? ' · autopilot' : '';
  const resumable = session.retomavel === true ? ` · ${l10n.t('resumable')}` : '';
  const state = stateLabel(session.state);
  return cost ? `${state}${mode}${resumable} · ${cost}` : `${state}${mode}${resumable}`;
}

/**
 * Estado das sessões de agente que a mesa de controle mostra. Começa com
 * `agents.list` e segue só pelos eventos do Core (SDD 6.4: sem polling).
 */
export class AgentBoard {
  private readonly sessions = new Map<string, AgentSessionInfo>();
  private readonly hidden = new Set<string>();

  /** Troca tudo pelo resultado de `agents.list`. */
  load(list: readonly AgentSessionInfo[]): void {
    this.sessions.clear();
    for (const session of list) this.sessions.set(session.sessionId, session);
  }

  /**
   * Aplica um evento. Devolve `unknown` quando o evento é de uma sessão que a
   * mesa ainda não conhece (iniciada por outro cliente): aí convém recarregar.
   */
  apply(event: FaklEvent): 'changed' | 'unchanged' | 'unknown' {
    const session = this.sessions.get(event.subject);
    if (event.topic === 'agent.state') {
      if (!session) return 'unknown';
      const data = event.data as AgentStateEventData;
      this.sessions.set(event.subject, { ...session, state: data.state });
      return 'changed';
    }
    if (event.topic === 'agent.mode') {
      if (!session) return 'unknown';
      const { permissoes } = event.data as AgentModeEventData;
      this.sessions.set(event.subject, { ...session, permissoes });
      return 'changed';
    }
    if (event.topic === 'agent.recovery') {
      if (!session) return 'unknown';
      const { retomada } = event.data as { retomada: AgentSessionInfo['retomada'] | null };
      const updated = { ...session };
      if (retomada) updated.retomada = retomada;
      else delete updated.retomada;
      this.sessions.set(event.subject, updated);
      return 'changed';
    }
    if (event.topic === 'agent.options') {
      if (!session) return 'unknown';
      const { opcoes } = event.data as AgentOptionsEventData;
      this.sessions.set(event.subject, { ...session, opcoes });
      return 'changed';
    }
    if (event.topic === 'cost.update') {
      if (!session) return 'unknown';
      this.sessions.set(event.subject, { ...session, usage: event.data as AgentUsageInfo });
      return 'changed';
    }
    return 'unchanged';
  }

  get(sessionId: string): AgentSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /** Sessões visíveis, as que ainda rodam primeiro, depois as mais novas. */
  list(): AgentSessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => !this.hidden.has(s.sessionId))
      .sort((a, b) => {
        const finalA = isFinalAgentState(a.state) ? 1 : 0;
        const finalB = isFinalAgentState(b.state) ? 1 : 0;
        // Ids são ULIDs: a ordem do texto é a ordem de criação.
        return finalA - finalB || b.sessionId.localeCompare(a.sessionId);
      });
  }

  /** Esconde da mesa as sessões encerradas. */
  clearFinished(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (isFinalAgentState(session.state) && !this.hidden.has(session.sessionId)) {
        this.hidden.add(session.sessionId);
        count++;
      }
    }
    return count;
  }

  /** Quantos agentes ainda rodam e o custo somado por moeda. */
  totals(): { active: number; cost: Map<string, number> } {
    let active = 0;
    const cost = new Map<string, number>();
    for (const session of this.sessions.values()) {
      if (!isFinalAgentState(session.state)) active++;
      if (session.usage.cost) {
        const { amount, currency } = session.usage.cost;
        cost.set(currency, (cost.get(currency) ?? 0) + amount);
      }
    }
    return { active, cost };
  }
}
