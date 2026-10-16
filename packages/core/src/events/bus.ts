import { topicMatches, type EventTopic, type FaklEvent } from '@fakl/protocol';

import { ulid } from '../ulid.js';

export interface Disposable {
  dispose(): void;
}

export type EventListener = (event: FaklEvent) => void;

interface Subscription {
  readonly patterns: readonly string[];
  readonly listener: EventListener;
}

function matchesAny(patterns: readonly string[], topic: EventTopic): boolean {
  return patterns.some((pattern) => topicMatches(pattern, topic));
}

/**
 * Barramento de eventos em memória (SDD 6.4). Guarda os eventos recentes num
 * buffer circular para que um cliente que reconecta possa pedir o que perdeu
 * (`events.replay`). A persistência em disco entra com o módulo `store`.
 */
export class EventBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly history: FaklEvent[] = [];

  constructor(
    private readonly capacity = 10_000,
    private readonly newId: () => string = ulid,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  publish<TData>(topic: EventTopic, subject: string, data: TData): FaklEvent<TData> {
    const event: FaklEvent<TData> = {
      id: this.newId(),
      ts: this.clock().toISOString(),
      topic,
      subject,
      data,
    };
    this.history.push(event);
    if (this.history.length > this.capacity) this.history.shift();
    for (const subscription of [...this.subscriptions]) {
      if (!matchesAny(subscription.patterns, topic)) continue;
      try {
        subscription.listener(event);
      } catch {
        // Um assinante com defeito não pode impedir os outros de receber.
      }
    }
    return event;
  }

  subscribe(patterns: readonly string[], listener: EventListener): Disposable {
    const subscription: Subscription = { patterns: [...patterns], listener };
    this.subscriptions.add(subscription);
    return { dispose: () => this.subscriptions.delete(subscription) };
  }

  /** Eventos guardados que casam com os padrões, em ordem, após `afterId`. */
  replay(patterns: readonly string[], afterId?: string, limit = 1_000): FaklEvent[] {
    // ULIDs são ordenáveis como texto, então "depois de" é comparação simples.
    return this.history
      .filter(
        (event) =>
          (afterId === undefined || event.id > afterId) && matchesAny(patterns, event.topic),
      )
      .slice(-limit);
  }

  get subscriberCount(): number {
    return this.subscriptions.size;
  }
}
