import { l10n } from '@fakl/i18n';

import type { PermissionPolicy } from '../types.js';
import { stripAnsi } from './ansi.js';

/**
 * Política do agente de terminal (ADR 0047). Sem ACP não há pedido de permissão
 * estruturado: a CLI pergunta no próprio terminal, onde o Core não enxerga nem
 * responde. Por isso o Core só digita num terminal quando o usuário escolheu,
 * de forma explícita, aprovar tudo (ou autopilot): nos outros modos a única
 * entrada é a do próprio usuário, no terminal.
 */
export function canSendToTerminal(policy: PermissionPolicy): boolean {
  return policy === 'aprovar-tudo';
}

/** Por que uma mensagem do Core foi recusada; `undefined` quando pode seguir. */
export function terminalInputRefusal(policy: PermissionPolicy): string | undefined {
  if (canSendToTerminal(policy)) return undefined;
  return l10n.t(
    'a terminal agent has no structured permission requests, so the IDE only types into its terminal in the approve-all or autopilot modes; use "Take over the agent" to type yourself',
  );
}

/**
 * O que vai ao terminal: uma linha só, sem controles. Quebras de linha viram
 * espaço (um Enter no meio enviaria a mensagem em pedaços, ou executaria cada
 * pedaço como comando de shell se a CLI já tivesse saído) e escapes são
 * descartados (nada vindo de um agente move o cursor nem aciona teclas).
 */
export function sanitizeTerminalInput(message: string): string {
  return (
    stripAnsi(message)
      .replace(/\s*[\r\n]+\s*/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .trim()
  );
}
