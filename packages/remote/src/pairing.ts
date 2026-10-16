import { l10n } from '@fakl/i18n';

import { fromBase64Url, toBase64Url, utf8 } from './encoding.js';

/** O que o QR code do pareamento carrega (SDD 12.2). */
export interface PairingPayload {
  readonly v: 1;
  /** Endereço HTTPS do relay, onde o PWA é servido. */
  readonly r: string;
  /** Id da máquina no relay. */
  readonly m: string;
  /** Chave pública fixa do Core (base64url). */
  readonly k: string;
  /** Código de uso único. */
  readonly c: string;
  /** Nome da máquina, para o aparelho mostrar. */
  readonly n: string;
}

export function encodePairing(payload: PairingPayload): string {
  return toBase64Url(utf8(JSON.stringify(payload)));
}

export function decodePairing(text: string): PairingPayload {
  const value = JSON.parse(
    new TextDecoder().decode(fromBase64Url(text)),
  ) as Partial<PairingPayload>;
  if (
    value.v !== 1 ||
    typeof value.r !== 'string' ||
    typeof value.m !== 'string' ||
    typeof value.k !== 'string' ||
    typeof value.c !== 'string' ||
    typeof value.n !== 'string'
  ) {
    throw new Error(l10n.t('Invalid pairing QR code'));
  }
  return value as PairingPayload;
}

/** Link que a câmera do celular abre: o PWA no relay com o pareamento no fragmento (que não vai ao servidor). */
export function pairingUrl(payload: PairingPayload): string {
  return `${payload.r.replace(/\/+$/, '')}/#p=${encodePairing(payload)}`;
}

/** Endereço WebSocket do relay a partir do endereço HTTPS. */
export function relaySocketUrl(relay: string, path: '/core' | '/device', query = ''): string {
  const url = new URL(relay);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.search = query;
  url.hash = '';
  return url.toString();
}
