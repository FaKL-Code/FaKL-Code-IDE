import { l10n } from '@fakl/i18n';
import type { AgentPermissionEventData } from '@fakl/protocol';

import type { EventBus } from '../events/bus.js';
import { ulid } from '../ulid.js';

export interface ApprovalRequest {
  /** Sessão do agente que pediu; o pedido aparece na conversa dela. */
  readonly sessionId: string;
  /** Texto curto do pedido, como "Rodar `systemctl restart app` em vps-1". */
  readonly titulo: string;
}

interface Pending {
  readonly sessionId: string;
  readonly titulo: string;
  readonly resolve: (allowed: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function options(): AgentPermissionEventData['options'] {
  return [
    { id: 'permitir', name: l10n.t('Allow'), kind: 'allow_once' },
    { id: 'negar', name: l10n.t('Deny'), kind: 'reject_once' },
  ];
}

/**
 * Pedidos de aprovação das ferramentas do Core (SDD 14.3): `ssh_exec` fora da
 * política, DNS, reinício de VPS, comentários no GitHub. Saem como
 * `agent.permission` da sessão do agente, então a IDE, a CLI e o celular os
 * mostram e respondem como os pedidos de permissão do próprio agente.
 */
export class Approvals {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly bus: EventBus,
    private readonly timeoutMs = 30 * 60_000,
  ) {}

  /** Espera a resposta; nega sozinho no prazo ou se a sessão terminar. */
  request(request: ApprovalRequest): Promise<boolean> {
    const id = `fakl-${ulid()}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(id, false);
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { ...request, resolve, timer });
      this.bus.publish<AgentPermissionEventData>('agent.permission', request.sessionId, {
        id,
        title: request.titulo,
        options: options(),
      });
    });
  }

  /** Responde um pedido do Core; `false` se o id não é daqui. */
  respond(sessionId: string, id: string, allow: boolean): boolean {
    const pending = this.pending.get(id);
    if (pending?.sessionId !== sessionId) return false;
    this.settle(id, allow);
    return true;
  }

  /** Nega os pedidos de uma sessão que terminou. */
  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle(id, false);
    }
  }

  list(): { id: string; sessionId: string; titulo: string }[] {
    return [...this.pending].map(([id, p]) => ({ id, sessionId: p.sessionId, titulo: p.titulo }));
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, false);
  }

  private settle(id: string, allow: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(allow);
  }
}
