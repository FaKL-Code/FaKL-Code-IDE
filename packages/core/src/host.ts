import { l10n } from '@fakl/i18n';
import type {
  AgentPermissionEventData,
  AgentSessionInfo,
  AgentState,
  AgentStateEventData,
  Decision,
  FaklEvent,
} from '@fakl/protocol';

import type { AgentRuntime } from './agents.js';
import type { EventBus, Disposable } from './events/bus.js';

/**
 * Conversa do Core com o processo principal da IDE pelo `parentPort` do
 * `utilityProcess` (patches/fakl-core-host.patch, ADR 0006). O processo
 * principal mostra as notificações nativas (RF-109) e o diálogo de fechar
 * com agentes trabalhando (RF-110); o Core diz o que mostrar.
 */
export type ToHost =
  | { readonly type: 'ready'; readonly socketPath: string }
  | {
      readonly type: 'notify';
      readonly title: string;
      readonly body: string;
      readonly sessionId: string;
      /**
       * Pedido de permissão ou decisão: o processo principal mostra mesmo com a
       * IDE em foco se não houver janela, e mostra o pet com a IDE escondida.
       */
      readonly urgent: boolean;
    }
  /** Modo minimizado (ADR 0032): mostra, esconde ou alterna o overlay. */
  | {
      readonly type: 'overlay';
      readonly action: 'show' | 'hide' | 'toggle';
      readonly minimizeIde: boolean;
    }
  /** Traz a IDE para a frente (mostra as janelas escondidas ou abre uma). */
  | { readonly type: 'reveal' }
  | { readonly type: 'busy'; readonly agents: readonly string[] }
  | { readonly type: 'idle' }
  | {
      readonly type: 'permission';
      readonly sessionId: string;
      readonly id: string;
      readonly agent: string;
      readonly title: string;
    };

export type FromHost =
  | { readonly type: 'shutdown' }
  /** O usuário pediu para fechar: o Core responde `busy` com quem está trabalhando. */
  | { readonly type: 'query-busy' }
  /** O usuário escolheu esperar: o Core avisa `idle` quando ninguém mais trabalha. */
  | { readonly type: 'wait-idle' }
  | {
      readonly type: 'permission-answer';
      readonly sessionId: string;
      readonly id: string;
      readonly allow: boolean;
    };

export interface HostPort {
  postMessage(message: ToHost): void;
}

/** Estados em que o agente está no meio de um trabalho. */
const WORKING: ReadonlySet<AgentState> = new Set([
  'preparando',
  'pensando',
  'executando',
  'aguardando-permissão',
]);

export function isWorking(state: AgentState): boolean {
  return WORKING.has(state);
}

/** Notificação nativa para um evento de agente ou decisão do maestro, ou nada (RF-109). */
export function notificationFor(
  event: FaklEvent,
  session: Pick<AgentSessionInfo, 'nome'> | undefined,
): { title: string; body: string; urgent: boolean } | undefined {
  if (event.topic === 'run.decision') {
    const decision = event.data as Decision;
    // Respondida (inclusive pelo autopilot): ninguém espera você.
    if (decision.escolha !== undefined) return undefined;
    return {
      title: l10n.t('{0} asks for a decision', session?.nome ?? 'Maestro'),
      body: decision.pergunta,
      urgent: true,
    };
  }
  const agent = session?.nome ?? l10n.t('Agent');
  if (event.topic === 'agent.permission') {
    const data = event.data as AgentPermissionEventData;
    return { title: l10n.t('{0} asks for permission', agent), body: data.title, urgent: true };
  }
  if (event.topic !== 'agent.state') return undefined;
  const { state, previous, reason } = event.data as AgentStateEventData;
  if (state === 'falhou') {
    return {
      title: l10n.t('{0} failed', agent),
      body: l10n.t('See the agent log in the IDE.'),
      urgent: false,
    };
  }
  if (state === 'concluído') {
    return {
      title: l10n.t('{0} finished', agent),
      body: l10n.t('The work is ready for review.'),
      urgent: false,
    };
  }
  if (state === 'parado' && reason === 'limite') {
    return {
      title: l10n.t('{0} stopped at the limit', agent),
      body: l10n.t('A configured limit was reached.'),
      urgent: false,
    };
  }
  if ((state === 'ocioso' || state === 'aguardando-você') && isWorking(previous)) {
    return {
      title: l10n.t('{0} finished its turn', agent),
      body:
        state === 'aguardando-você'
          ? l10n.t('It is waiting for your reply.')
          : l10n.t('Ready for the next message.'),
      urgent: state === 'aguardando-você',
    };
  }
  return undefined;
}

/** Liga o barramento e o runtime ao processo principal da IDE. */
export class HostBridge implements Disposable {
  private readonly subscription: Disposable;
  private waiting = false;
  /** Pedidos de permissão sem resposta, para levar ao diálogo ao fechar. */
  private readonly pending = new Map<string, ToHost & { type: 'permission' }>();

  constructor(
    private readonly port: HostPort,
    bus: EventBus,
    private readonly agents: AgentRuntime,
  ) {
    this.subscription = bus.subscribe(
      ['agent.state', 'agent.permission', 'run.decision'],
      (event) => {
        this.onEvent(event);
      },
    );
  }

  /** Nomes dos agentes que estão trabalhando agora. */
  busy(): string[] {
    return this.agents
      .list()
      .filter((session) => isWorking(session.state))
      .map((session) => session.nome);
  }

  handle(message: FromHost): void {
    switch (message.type) {
      case 'query-busy':
        this.port.postMessage({ type: 'busy', agents: this.busy() });
        break;
      case 'wait-idle':
        this.waiting = true;
        for (const request of this.pending.values()) this.port.postMessage(request);
        this.checkIdle();
        break;
      case 'permission-answer':
        this.pending.delete(`${message.sessionId}/${message.id}`);
        this.agents
          .respondPermission(message.sessionId, message.id, message.allow)
          .catch(() => undefined);
        break;
      case 'shutdown':
        break;
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private onEvent(event: FaklEvent): void {
    // Decisões têm a execução como assunto; o agente que pergunta vem nos dados.
    const sessionId =
      event.topic === 'run.decision' ? ((event.data as Decision).sessionId ?? '') : event.subject;
    const session = this.agents.list().find((s) => s.sessionId === sessionId);
    if (event.topic === 'agent.permission') {
      const data = event.data as AgentPermissionEventData;
      const request = {
        type: 'permission',
        sessionId: event.subject,
        id: data.id,
        agent: session?.nome ?? l10n.t('Agent'),
        title: data.title,
      } as const;
      this.pending.set(`${event.subject}/${data.id}`, request);
      // A IDE já está fechando: sem janela, a pergunta vai para um diálogo nativo.
      if (this.waiting) this.port.postMessage(request);
    } else if (event.topic === 'agent.state') {
      const { state } = event.data as AgentStateEventData;
      if (state !== 'aguardando-permissão') {
        for (const [key, request] of this.pending) {
          if (request.sessionId === event.subject) this.pending.delete(key);
        }
      }
    }
    if (!(this.waiting && event.topic === 'agent.permission')) {
      const notification = notificationFor(event, session);
      if (notification) {
        this.port.postMessage({ type: 'notify', sessionId, ...notification });
      }
    }
    if (this.waiting) this.checkIdle();
  }

  private checkIdle(): void {
    if (this.busy().length === 0) {
      this.waiting = false;
      this.port.postMessage({ type: 'idle' });
    }
  }
}
