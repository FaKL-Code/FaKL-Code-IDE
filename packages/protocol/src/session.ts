/** Parâmetros e resultados dos métodos de sessão e de eventos. */
import type { EventTopic, FaklEvent } from './events.js';

/** Versão do protocolo; muda quando um método existente muda de forma incompatível. */
export const PROTOCOL_VERSION = 1;

export type ClientKind = 'extension' | 'cli' | 'remote' | 'agent' | 'test';

export interface HelloParams {
  readonly token: string;
  readonly client: ClientKind;
  readonly protocolVersion: number;
  /**
   * Idioma da interface da IDE (`vscode.env.language`). Só a extensão o manda:
   * o Core passa a falar nele (erros, avisos e prompts dos agentes).
   */
  readonly locale?: string;
}

export interface HelloResult {
  readonly protocolVersion: number;
  readonly coreVersion: string;
  readonly pid: number;
  /** Idioma em que o Core está falando (`en` ou `pt-br`), já com o `locale` deste hello. */
  readonly locale?: string;
}

export interface SubscribeParams {
  /** Tópicos exatos, prefixos com curinga (`agent.*`) ou `*`. */
  readonly topics: readonly string[];
}

export interface SubscribeResult {
  readonly subscriptionId: string;
}

export interface UnsubscribeParams {
  readonly subscriptionId: string;
}

export interface ReplayParams {
  readonly topics: readonly string[];
  /** Devolve só eventos posteriores a este id. */
  readonly afterId?: string;
  readonly limit?: number;
}

export interface EventNotificationParams {
  readonly subscriptionId: string;
  readonly event: FaklEvent;
}

export type { EventTopic };
