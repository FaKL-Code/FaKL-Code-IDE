import { l10n } from '@fakl/i18n';
import {
  isFailure,
  isNotification,
  isResponse,
  JSONRPC_VERSION,
  type EventNotificationParams,
  type FaklEvent,
  type JsonRpcRequest,
} from '@fakl/protocol';

import type { OverlayBridge, OverlayStatus } from './bridge.js';

/**
 * Cliente JSON-RPC sobre a ponte do processo principal. Cada frame é uma
 * mensagem inteira (o principal já desenquadrou o NDJSON) e a conexão chega
 * autenticada: nada de `session.hello` aqui. A cada volta ao `online`, o
 * cliente assina os tópicos de novo, porque a sessão do Core é outra.
 */

/** Os mesmos tópicos do celular: agentes, execuções, gasto e troca de conta do Claude. */
export const TOPICS: readonly string[] = ['agent.*', 'run.*', 'cost.update', 'claude.*'];

/** Pedido sem resposta por este tempo desiste, para nenhum botão ficar preso. */
const CALL_TIMEOUT_MS = 30_000;

export class CoreError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export type Connection = 'conectando' | OverlayStatus;

export class CoreClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(event: FaklEvent) => void>();
  private readonly statusListeners = new Set<(status: Connection) => void>();
  private state: Connection = 'conectando';

  constructor(
    private readonly bridge: Pick<OverlayBridge, 'send' | 'onFrame' | 'onStatus'>,
    private readonly topics: readonly string[] = TOPICS,
  ) {
    bridge.onFrame((frame) => {
      this.receive(frame);
    });
    bridge.onStatus((status) => {
      void this.changeStatus(status);
    });
  }

  get status(): Connection {
    return this.state;
  }

  /** Chama um método do Core; sem conexão, falha na hora. */
  call<T>(method: string, params?: unknown): Promise<T> {
    if (this.state !== 'online') {
      return Promise.reject(new CoreError(l10n.t('No connection to the Core.')));
    }
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CoreError(l10n.t("The Core didn't answer {0}.", method)));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.bridge.send(JSON.stringify(request));
    });
  }

  onEvent(listener: (event: FaklEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Avisado depois de assinar os tópicos (`online`) ou quando a conexão cai. */
  onStatus(listener: (status: Connection) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private async changeStatus(status: OverlayStatus): Promise<void> {
    if (status === 'offline') {
      this.state = 'offline';
      this.failPending(l10n.t('The connection to the Core dropped.'));
      this.emitStatus();
      return;
    }
    this.state = 'online';
    try {
      await this.call('events.subscribe', { topics: this.topics });
    } catch {
      // Sem a assinatura, os dados ainda chegam pelas consultas; a próxima volta tenta de novo.
    }
    // A conexão pode ter caído enquanto assinava.
    if (this.status === 'online') this.emitStatus();
  }

  private emitStatus(): void {
    for (const listener of this.statusListeners) listener(this.state);
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CoreError(message));
      this.pending.delete(id);
    }
  }

  private receive(frame: string): void {
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      return;
    }
    if (isResponse(message)) {
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (isFailure(message)) {
        pending.reject(new CoreError(message.error.message, message.error.code));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (isNotification(message) && message.method === 'events.event') {
      const event = (message.params as EventNotificationParams | undefined)?.event;
      if (!event) return;
      for (const listener of this.eventListeners) listener(event);
    }
  }
}
