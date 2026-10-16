// Só tipos: no navegador as mesmas classes vêm do DOM.
import type { webcrypto } from 'node:crypto';

import { l10n } from '@fakl/i18n';

import { concatBytes, fromBase64Url, toBase64Url, utf8 } from './encoding.js';

/**
 * Canal cifrado entre um aparelho e o Core (SDD 12.1 e 12.2, RNF-08).
 *
 * Cada ponta tem um par de chaves P-256 de longo prazo; a do Core vai no QR
 * do pareamento e a do aparelho fica guardada no Core quando você confirma.
 * Cada conexão gera chaves efêmeras. As chaves de sessão saem de três ECDH
 * (efêmera-efêmera, fixa-fixa, efêmera do aparelho com a fixa do Core) e do
 * HKDF-SHA256, com o código de pareamento como sal quando é um pareamento.
 * Assim só o Core verdadeiro deriva as chaves, só um aparelho pareado (ou quem
 * tem o código de uso único) chega a elas, e o relay só vê bytes cifrados.
 *
 * Mensagens vão em AES-256-GCM com nonce de contador por direção; um contador
 * fora de ordem derruba o canal.
 */

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
type JsonWebKey = webcrypto.JsonWebKey;
type SubtleCrypto = webcrypto.SubtleCrypto;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const PROTOCOL = 'fakl-remote-v1';

export const CHANNEL_VERSION = 1;

export interface KeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  /** Chave pública crua (65 bytes), o que vai no QR e no handshake. */
  readonly raw: Uint8Array<ArrayBuffer>;
}

export type HandshakeMode = 'parear' | 'entrar';

/** Primeira mensagem do aparelho, em claro. */
export interface DeviceHello {
  readonly t: 'hello';
  readonly v: number;
  readonly modo: HandshakeMode;
  /** Chave fixa do aparelho. */
  readonly dev: string;
  /** Chave efêmera do aparelho. */
  readonly eph: string;
}

/** Resposta do Core, em claro. */
export interface CoreHello {
  readonly t: 'hello';
  readonly eph: string;
}

/** Recusa em claro, antes de haver chaves. */
export interface PlainError {
  readonly t: 'erro';
  readonly motivo: 'offline' | 'desconhecido' | 'codigo' | 'versao' | 'protocolo' | 'revogado';
}

export interface Box {
  readonly t: 'box';
  readonly n: number;
  readonly c: string;
}

export async function generateKeyPair(extractable = false): Promise<KeyPair> {
  const pair: CryptoKeyPair = await subtle().generateKey(ECDH, extractable, ['deriveBits']);
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, raw };
}

/** Para guardar a chave fixa do Core num arquivo (só o Core faz isso). */
export async function exportKeyPair(pair: KeyPair): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', pair.privateKey);
}

export async function importKeyPair(jwk: JsonWebKey): Promise<KeyPair> {
  const privateKey = await subtle().importKey('jwk', jwk, ECDH, true, ['deriveBits']);
  const publicJwk: JsonWebKey = { ...jwk, key_ops: [] };
  delete publicJwk.d;
  const publicKey = await subtle().importKey('jwk', publicJwk, ECDH, true, []);
  const raw = new Uint8Array(await subtle().exportKey('raw', publicKey));
  return { publicKey, privateKey, raw };
}

export async function importPublicKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error(l10n.t('invalid public key'));
  return subtle().importKey('raw', raw, ECDH, true, []);
}

async function dh(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256),
  );
}

/** Impressão curta de uma chave, para mostrar ao usuário. */
export async function fingerprint(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await subtle().digest('SHA-256', raw));
  return toBase64Url(hash.slice(0, 6));
}

export interface HandshakeKeys {
  /** Chave fixa de quem deriva. */
  readonly mine: KeyPair;
  readonly ephemeral: KeyPair;
  /** Chave fixa da outra ponta. */
  readonly peerStatic: Uint8Array<ArrayBuffer>;
  readonly peerEphemeral: Uint8Array<ArrayBuffer>;
  readonly role: 'aparelho' | 'core';
  readonly mode: HandshakeMode;
  /** Código de uso único do QR; obrigatório ao parear. */
  readonly code?: string;
}

/** Deriva o canal das duas pontas; as duas chegam às mesmas chaves ou o primeiro box falha. */
export async function deriveChannel(keys: HandshakeKeys): Promise<SecureChannel> {
  const peerStatic = await importPublicKey(keys.peerStatic);
  const peerEphemeral = await importPublicKey(keys.peerEphemeral);
  const device = keys.role === 'aparelho';
  // Sempre na mesma ordem nas duas pontas: ee, ss, e(aparelho)-s(core).
  const ee = await dh(keys.ephemeral.privateKey, peerEphemeral);
  const ss = await dh(keys.mine.privateKey, peerStatic);
  const es = device
    ? await dh(keys.ephemeral.privateKey, peerStatic)
    : await dh(keys.mine.privateKey, peerEphemeral);
  const [devStatic, devEph, coreEph, coreStatic] = device
    ? [keys.mine.raw, keys.ephemeral.raw, keys.peerEphemeral, keys.peerStatic]
    : [keys.peerStatic, keys.peerEphemeral, keys.ephemeral.raw, keys.mine.raw];
  const transcript = new Uint8Array(
    await subtle().digest(
      'SHA-256',
      concatBytes(utf8(PROTOCOL), devStatic, devEph, coreEph, coreStatic),
    ),
  );
  if (keys.mode === 'parear' && !keys.code) throw new Error(l10n.t('pairing without a code'));
  const salt = keys.mode === 'parear' ? utf8(`${PROTOCOL}:${keys.code ?? ''}`) : new Uint8Array(32);
  const ikm = await subtle().importKey('raw', concatBytes(ee, ss, es), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = new Uint8Array(
    await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: transcript }, ikm, 512),
  );
  const aes = (bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
    subtle().importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const toCore = await aes(bits.slice(0, 32));
  const toDevice = await aes(bits.slice(32, 64));
  return device
    ? new SecureChannel(toCore, DIRECTION_TO_CORE, toDevice, DIRECTION_TO_DEVICE)
    : new SecureChannel(toDevice, DIRECTION_TO_DEVICE, toCore, DIRECTION_TO_CORE);
}

const DIRECTION_TO_CORE = 1;
const DIRECTION_TO_DEVICE = 2;
/** Contador máximo antes de exigir uma conexão nova (bem abaixo de 2^53). */
const MAX_COUNTER = 2 ** 48;

function nonce(direction: number, counter: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, direction);
  view.setUint32(4, Math.floor(counter / 2 ** 32));
  view.setUint32(8, counter >>> 0);
  return bytes;
}

export class ChannelError extends Error {
  override readonly name = 'ChannelError';
}

/** Sela e abre mensagens JSON depois do handshake. */
export class SecureChannel {
  private sent = 0;
  private received = 0;
  /** Encadeia as cifragens para os contadores saírem em ordem. */
  private sending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sendKey: CryptoKey,
    private readonly sendDirection: number,
    private readonly receiveKey: CryptoKey,
    private readonly receiveDirection: number,
  ) {}

  seal(message: unknown): Promise<string> {
    const result = this.sending.then(async () => {
      const n = this.sent++;
      if (n >= MAX_COUNTER) throw new ChannelError(l10n.t('channel exhausted; reconnect'));
      const cipher = await subtle().encrypt(
        { name: 'AES-GCM', iv: nonce(this.sendDirection, n) },
        this.sendKey,
        utf8(JSON.stringify(message)),
      );
      const box: Box = { t: 'box', n, c: toBase64Url(new Uint8Array(cipher)) };
      return JSON.stringify(box);
    });
    this.sending = result.catch(() => undefined);
    return result;
  }

  /** Abre um box; contador repetido, fora de ordem ou cifra adulterada lança ChannelError. */
  async open(box: Box): Promise<unknown> {
    if (box.n !== this.received) throw new ChannelError(l10n.t('message out of order'));
    this.received++;
    let plain: ArrayBuffer;
    try {
      plain = await subtle().decrypt(
        { name: 'AES-GCM', iv: nonce(this.receiveDirection, box.n) },
        this.receiveKey,
        fromBase64Url(box.c),
      );
    } catch {
      throw new ChannelError(l10n.t('could not open the message'));
    }
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  }
}

/** Lê uma mensagem do canal em claro ou cifrada; o resto é erro de protocolo. */
export function parseFrame(text: string): DeviceHello | CoreHello | PlainError | Box {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ChannelError(l10n.t('invalid frame'));
  }
  if (typeof value !== 'object' || value === null) throw new ChannelError(l10n.t('invalid frame'));
  const frame = value as Record<string, unknown>;
  switch (frame.t) {
    case 'box':
      if (typeof frame.n !== 'number' || typeof frame.c !== 'string') break;
      return frame as unknown as Box;
    case 'hello':
      if (typeof frame.eph !== 'string') break;
      return frame as unknown as DeviceHello | CoreHello;
    case 'erro':
      return frame as unknown as PlainError;
    default:
      break;
  }
  throw new ChannelError(l10n.t('invalid frame'));
}

export function encodeKey(raw: Uint8Array): string {
  return toBase64Url(raw);
}

export function decodeKey(text: string): Uint8Array<ArrayBuffer> {
  return fromBase64Url(text);
}
