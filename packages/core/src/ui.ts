import type {
  OverlayAction,
  UiOverlayParams,
  UiRevealEventData,
  UiRevealParams,
  UiTakeRevealResult,
} from '@fakl/protocol';

import type { EventBus } from './events/bus.js';
import type { HostPort } from './host.js';
import { l10n } from '@fakl/i18n';

import { objectParams, RpcError, type Router } from './rpc/router.js';

const ACTIONS: readonly OverlayAction[] = ['show', 'hide', 'toggle'];

/**
 * Por quanto tempo a conversa pedida por um `ui.reveal` espera uma janela da
 * IDE reclamá-la. Abrir uma janela nova leva segundos; depois disso o pedido
 * é velho e não deve abrir uma conversa do nada.
 */
export const REVEAL_TTL_MS = 2 * 60_000;

function optionalSessionId(params: unknown): string | undefined {
  const p = params === undefined ? {} : objectParams(params);
  const sessionId = p.sessionId;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId === '')) {
    throw RpcError.invalidParams(l10n.t('sessionId must be non-empty text'));
  }
  return sessionId;
}

/**
 * Métodos `ui.*` (ADR 0032): a extensão pede o modo minimizado e a volta à
 * IDE; o Core repassa ao processo principal, dono das janelas. Sem processo
 * principal (Core avulso, testes), os pedidos são aceitos e nada acontece.
 *
 * "Abrir na IDE" pode chegar sem nenhuma janela aberta: o evento `ui.reveal`
 * sai antes de a janela nova existir. Por isso o Core guarda a conversa
 * pedida e a entrega uma vez, a quem a reclamar com `ui.takeReveal` (a
 * extensão ao receber o evento ou ao conectar numa janela nova).
 */
export function registerUi(router: Router, bus: EventBus, host: HostPort | undefined): void {
  let pending: { readonly sessionId: string; readonly at: number } | undefined;

  router.register('ui.reveal', (params): null => {
    const sessionId = optionalSessionId(params);
    const request: UiRevealParams = sessionId === undefined ? {} : { sessionId };
    // O pedido mais novo vale: "Abrir IDE" sem agente descarta a conversa pendente.
    pending = sessionId === undefined ? undefined : { sessionId, at: Date.now() };
    const data: UiRevealEventData = request;
    bus.publish('ui.reveal', request.sessionId ?? 'ide', data);
    host?.postMessage({ type: 'reveal' });
    return null;
  });

  router.register('ui.takeReveal', (params): UiTakeRevealResult => {
    const sessionId = optionalSessionId(params);
    if (pending && Date.now() - pending.at > REVEAL_TTL_MS) pending = undefined;
    if (!pending || (sessionId !== undefined && pending.sessionId !== sessionId)) return null;
    const taken = pending.sessionId;
    pending = undefined;
    return { sessionId: taken };
  });

  router.register('ui.overlay', (params): null => {
    const p = objectParams(params) as Partial<UiOverlayParams> & Record<string, unknown>;
    const action = p.action;
    if (action === undefined || !ACTIONS.includes(action)) {
      throw RpcError.invalidParams(l10n.t('action must be show, hide or toggle'));
    }
    if (p.minimizeIde !== undefined && typeof p.minimizeIde !== 'boolean') {
      throw RpcError.invalidParams(l10n.t('minimizeIde must be a boolean'));
    }
    host?.postMessage({
      type: 'overlay',
      action,
      minimizeIde: p.minimizeIde === true,
    });
    return null;
  });
}
