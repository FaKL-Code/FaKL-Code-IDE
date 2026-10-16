import type { CafeState, FaklEvent } from '@fakl/protocol';

/** Mensagens da extensão para o café. */
export type ToCafe =
  | { readonly type: 'state'; readonly state: CafeState }
  | { readonly type: 'event'; readonly event: FaklEvent }
  | { readonly type: 'offline' };

/** Mensagens do café para a extensão. */
export type FromCafe =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | { readonly type: 'open'; readonly sessionId: string }
  /** Botões da sala: conversar com um agente novo ou abrir uma tarefa com maestro. */
  | { readonly type: 'newAgent' }
  | { readonly type: 'newTask' };
