import type { FaklEvent, UiRevealEventData } from '@fakl/protocol';

/**
 * Agente cuja conversa abrir quando o Core manda o evento `ui.reveal`; sem
 * `sessionId` (ou com um valor que não é texto), só a IDE vem para a frente.
 */
export function revealSession(event: Pick<FaklEvent, 'topic' | 'data'>): string | undefined {
  if (event.topic !== 'ui.reveal') return undefined;
  const sessionId = (event.data as UiRevealEventData | undefined)?.sessionId;
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
}
