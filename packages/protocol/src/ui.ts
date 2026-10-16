/**
 * Interface do usuário: pedidos da extensão ao processo principal da IDE,
 * passando pelo Core (modo minimizado, ADR 0032).
 */

export type OverlayAction = 'show' | 'hide' | 'toggle';

export interface UiRevealParams {
  /** Agente cuja conversa abrir na IDE; sem ele, só traz a IDE para a frente. */
  readonly sessionId?: string;
}

export interface UiOverlayParams {
  readonly action: OverlayAction;
  /** Com `show`, esconde as janelas da IDE ao mostrar o overlay. */
  readonly minimizeIde?: boolean;
}

/** Dados do evento `ui.reveal`; o `subject` do evento é o `sessionId` ou `ide`. */
export interface UiRevealEventData {
  readonly sessionId?: string;
}

/**
 * `ui.takeReveal`: a extensão reclama a conversa pedida pelo último
 * `ui.reveal`. Com `sessionId`, só reclama se for a mesma (resposta ao evento);
 * sem ele, reclama qualquer uma (janela nova ao conectar).
 */
export interface UiTakeRevealParams {
  readonly sessionId?: string;
}

/** Resposta de `ui.takeReveal`: a conversa a abrir, entregue uma vez só, ou `null`. */
export type UiTakeRevealResult = { readonly sessionId: string } | null;
