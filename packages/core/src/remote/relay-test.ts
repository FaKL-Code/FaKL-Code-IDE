import { randomBytes } from 'node:crypto';

import type { RemoteTestResult } from '@fakl/protocol';
import {
  machineIdFromSecret,
  relaySocketUrl,
  type CoreToRelay,
  type RelayToCore,
} from '@fakl/remote';
import { l10n } from '@fakl/i18n';

import { relayUrlProblem } from '../config.js';

export interface RelayTestOptions {
  readonly relay: string;
  /** FAKL_RELAY_KEY, se houver. */
  readonly chave?: string;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly WebSocket?: typeof WebSocket;
  /** Tempo máximo de cada etapa; padrão 8 s. */
  readonly timeoutMs?: number;
}

const TIMEOUT_MS = 8_000;

function reason(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : '';
    return detail ? `${error.message}: ${detail}` : error.message;
  }
  return String(error);
}

/**
 * Confere um relay em três etapas, sem mexer na conexão do acesso remoto:
 * 1. `GET /saude` por HTTPS (DNS, certificado e proxy);
 * 2. WebSocket em `/core` (o proxy precisa repassar o upgrade);
 * 3. autenticação com a chave, usando uma identidade descartável — a da
 *    máquina derrubaria a conexão que já estiver aberta.
 */
export async function testRelay(options: RelayTestOptions): Promise<RemoteTestResult> {
  const relay = options.relay.trim().replace(/\/+$/, '');
  const problem = relayUrlProblem(relay);
  if (problem) return { ok: false, relay, etapa: 'endereco', mensagem: problem };
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  const saude = `${relay}/saude`;
  try {
    const response = await (options.fetch ?? fetch)(saude, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    const body = (await response.json().catch(() => undefined)) as { ok?: unknown } | undefined;
    if (!response.ok || body?.ok !== true) {
      return {
        ok: false,
        relay,
        etapa: 'https',
        mensagem: response.ok
          ? l10n.t('{0} responded, but it does not look like a FaKL-Code relay', saude)
          : l10n.t(
              '{0} responded HTTP {1}; is the relay up behind the proxy?',
              saude,
              String(response.status),
            ),
      };
    }
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      relay,
      etapa: 'https',
      mensagem: timeout
        ? l10n.t('{0} did not respond within {1} s', saude, String(timeoutMs / 1000))
        : l10n.t(
            'could not open {0} ({1}); check the DNS, port 443 and the certificate',
            saude,
            reason(error),
          ),
    };
  }

  const segredo = randomBytes(32).toString('base64url');
  const auth: CoreToRelay = {
    t: 'auth',
    m: await machineIdFromSecret(segredo),
    s: segredo,
    ...(options.chave ? { k: options.chave } : {}),
  };
  const Impl = options.WebSocket ?? globalThis.WebSocket;
  const started = Date.now();
  return new Promise<RemoteTestResult>((resolve) => {
    let done = false;
    let opened = false;
    let ws: WebSocket | undefined;
    const finish = (result: RemoteTestResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close(1000, 'teste');
      } catch {
        // Já fechado.
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        relay,
        etapa: 'websocket',
        mensagem: opened
          ? l10n.t(
              'the relay did not respond to authentication within {0} s',
              String(timeoutMs / 1000),
            )
          : l10n.t(
              'the WebSocket at {0}/core did not open within {1} s; does the proxy forward WebSocket?',
              relay,
              String(timeoutMs / 1000),
            ),
      });
    }, timeoutMs);
    try {
      ws = new Impl(relaySocketUrl(relay, '/core'));
    } catch (error) {
      finish({ ok: false, relay, etapa: 'endereco', mensagem: reason(error) });
      return;
    }
    const socket = ws;
    socket.addEventListener('open', () => {
      opened = true;
      socket.send(JSON.stringify(auth));
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let frame: RelayToCore;
      try {
        frame = JSON.parse(event.data) as RelayToCore;
      } catch {
        return;
      }
      if (frame.t === 'ok') {
        const push = typeof frame.vapid === 'string' && frame.vapid !== '';
        finish({
          ok: true,
          relay,
          mensagem: l10n.t('The relay responded and accepted the connection.'),
          push,
          latenciaMs: Date.now() - started,
          ...(options.chave
            ? {}
            : {
                aviso: l10n.t(
                  'The relay accepts any Core: set FAKL_RELAY_KEY in the relay .env and the same key in the IDE.',
                ),
              }),
        });
      } else if (frame.t === 'recusado') {
        finish({
          ok: false,
          relay,
          etapa: 'chave',
          mensagem:
            frame.motivo === 'chave do relay'
              ? options.chave
                ? l10n.t('The relay refused the key: it does not match FAKL_RELAY_KEY.')
                : l10n.t('The relay requires a key: enter its FAKL_RELAY_KEY.')
              : l10n.t('The relay refused the connection ({0}).', frame.motivo),
        });
      }
    });
    socket.addEventListener('close', (event: { code: number; reason: string }) => {
      finish({
        ok: false,
        relay,
        etapa: event.code === 4403 ? 'chave' : 'websocket',
        mensagem: opened
          ? l10n.t(
              'the relay closed the connection ({0})',
              `${String(event.code)}${event.reason ? `: ${event.reason}` : ''}`,
            )
          : l10n.t(
              'the WebSocket at {0}/core did not open; the proxy (Caddy or Traefik) must forward WebSocket',
              relay,
            ),
      });
    });
    socket.addEventListener('error', () => {
      // O 'close' vem em seguida com o código.
    });
  });
}
