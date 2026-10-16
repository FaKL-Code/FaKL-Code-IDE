import { toBase64Url, utf8 } from './encoding.js';

/**
 * Quadros entre o Core e o relay (SDD 12.1). O Core mantém uma conexão de
 * saída e o relay multiplexa nela um canal por aparelho conectado. O
 * conteúdo dos canais já vem cifrado de ponta a ponta.
 */
export type CoreToRelay =
  | {
      readonly t: 'auth';
      /** Id da máquina; o relay confere que é o hash do segredo. */
      readonly m: string;
      readonly s: string;
      /** Chave de acesso ao relay, se ele exigir uma. */
      readonly k?: string;
    }
  | { readonly t: 'data'; readonly ch: string; readonly d: string }
  | { readonly t: 'close'; readonly ch: string }
  | {
      readonly t: 'push';
      readonly id: string;
      readonly sub: PushSubscriptionData;
      readonly msg: PushMessage;
    };

export type RelayToCore =
  | { readonly t: 'ok'; readonly vapid?: string }
  | { readonly t: 'recusado'; readonly motivo: string }
  | { readonly t: 'open'; readonly ch: string }
  | { readonly t: 'data'; readonly ch: string; readonly d: string }
  | { readonly t: 'close'; readonly ch: string }
  | { readonly t: 'push'; readonly id: string; readonly ok: boolean; readonly expirada?: boolean };

/** Assinatura Web Push do navegador (PushSubscription.toJSON()). */
export interface PushSubscriptionData {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** Conteúdo mínimo da notificação (SDD 12.4): os detalhes só dentro do app. */
export interface PushMessage {
  readonly titulo: string;
  readonly texto: string;
  readonly tag?: string;
}

/** Id da máquina: 22 caracteres do SHA-256 do segredo, que só o Core conhece. */
export async function machineIdFromSecret(secret: string): Promise<string> {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8(secret)));
  return toBase64Url(hash).slice(0, 22);
}

export const MACHINE_ID = /^[A-Za-z0-9_-]{22}$/;
