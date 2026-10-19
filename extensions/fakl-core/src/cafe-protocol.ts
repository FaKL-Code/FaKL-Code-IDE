import type { CafeState, ExternalListResult, FaklEvent } from '@fakl/protocol';

/** Mensagens da extensão para o café. */
export type ToCafe =
  | { readonly type: 'state'; readonly state: CafeState }
  | { readonly type: 'event'; readonly event: FaklEvent }
  | ({ readonly type: 'externas' } & ExternalListResult)
  | { readonly type: 'offline' };

/** Mensagens do café para a extensão. */
export type FromCafe =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | { readonly type: 'open'; readonly sessionId: string }
  /** Abre a conversa de uma extensão (Codex ou Claude Code) na própria extensão. */
  | { readonly type: 'externasAbrir'; readonly id: string }
  /** Botões da sala: conversar com um agente novo ou abrir uma tarefa com maestro. */
  | { readonly type: 'newAgent' }
  | { readonly type: 'newTask' }
  /** Abre a cozinha do CI, que tem tela própria (ADR 0053). */
  | { readonly type: 'abrirCozinha' };
