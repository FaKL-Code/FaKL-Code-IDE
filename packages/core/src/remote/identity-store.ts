import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { webcrypto } from 'node:crypto';

import { writeJsonAtomic } from '../store.js';

/**
 * Armazenamento da identidade do controle remoto (ADR 0044, RNF-07). O arquivo
 * `identity.json` guarda o segredo da máquina no relay e a chave privada do
 * Core. Cifrado, ele só se abre com a chave de 32 bytes que a IDE guarda no
 * cofre do sistema; a chave nunca fica em arquivo.
 */

/** Conteúdo em claro da identidade (formato antigo do arquivo). */
export interface StoredIdentity {
  readonly segredo: string;
  readonly chave: webcrypto.JsonWebKey;
}

/** Arquivo cifrado: AES-256-GCM, com o nonce e a etiqueta de autenticação. */
interface SealedFile {
  readonly v: 1;
  readonly cifra: 'aes-256-gcm';
  readonly iv: string;
  readonly etiqueta: string;
  readonly dados: string;
}

export type IdentityRead =
  | { readonly kind: 'ausente' }
  | { readonly kind: 'claro'; readonly identity: StoredIdentity }
  | { readonly kind: 'cifrado'; readonly sealed: SealedFile }
  | { readonly kind: 'corrompido'; readonly motivo: string };

const KEY_BYTES = 32;

/** Gera a chave de 32 bytes que a IDE guarda no cofre do sistema. */
export function newIdentityKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url');
}

/** Decodifica a chave do cofre; `undefined` se não tiver exatamente 32 bytes. */
export function parseIdentityKey(text: string | undefined): Buffer | undefined {
  if (!text) return undefined;
  const key = Buffer.from(text, 'base64url');
  return key.length === KEY_BYTES && key.toString('base64url') === text ? key : undefined;
}

function isIdentity(value: unknown): value is StoredIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.segredo === 'string' && typeof v.chave === 'object' && v.chave !== null;
}

function isSealed(value: unknown): value is SealedFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    v.cifra === 'aes-256-gcm' &&
    typeof v.iv === 'string' &&
    typeof v.etiqueta === 'string' &&
    typeof v.dados === 'string'
  );
}

/** Lê o arquivo sem nunca tratar um arquivo estragado como se não existisse. */
export async function readIdentityFile(file: string): Promise<IdentityRead> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'ausente' };
    return { kind: 'corrompido', motivo: String(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'corrompido', motivo: 'invalid JSON' };
  }
  if (isSealed(parsed)) return { kind: 'cifrado', sealed: parsed };
  if (isIdentity(parsed)) return { kind: 'claro', identity: parsed };
  return { kind: 'corrompido', motivo: 'unknown format' };
}

export function sealIdentity(identity: StoredIdentity, key: Buffer): SealedFile {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const dados = Buffer.concat([cipher.update(JSON.stringify(identity), 'utf8'), cipher.final()]);
  return {
    v: 1,
    cifra: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    etiqueta: cipher.getAuthTag().toString('base64url'),
    dados: dados.toString('base64url'),
  };
}

/** Abre o arquivo cifrado; `undefined` com a chave errada ou o conteúdo alterado. */
export function openIdentity(sealed: SealedFile, key: Buffer): StoredIdentity | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(sealed.etiqueta, 'base64url'));
    const text = Buffer.concat([
      decipher.update(Buffer.from(sealed.dados, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed: unknown = JSON.parse(text);
    return isIdentity(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Grava a identidade cifrada; a troca atômica apaga o texto em claro que houvesse. */
export function writeSealedIdentity(
  file: string,
  identity: StoredIdentity,
  key: Buffer,
): Promise<void> {
  return writeJsonAtomic(file, sealIdentity(identity, key));
}
