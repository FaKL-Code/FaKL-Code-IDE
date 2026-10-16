import { randomBytes } from 'node:crypto';

import { l10n } from '@fakl/i18n';

/**
 * ULID (https://github.com/ulid/spec): 48 bits de tempo e 80 de aleatoriedade
 * em Base32 de Crockford. Ids gerados no mesmo milissegundo são monotônicos.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  let value = ms;
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = (ALPHABET[value % 32] ?? '0') + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits = 16 caracteres de 5 bits.
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out = (ALPHABET[Number(bits & 31n)] ?? '0') + out;
    bits >>= 5n;
  }
  return out;
}

function increment(random: Uint8Array): Uint8Array {
  const next = Uint8Array.from(random);
  for (let i = next.length - 1; i >= 0; i--) {
    const value = next[i] ?? 0;
    if (value < 255) {
      next[i] = value + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error(l10n.t('ULID: randomness exhausted within the same millisecond'));
}

export function createUlidFactory(now: () => number = Date.now): () => string {
  let lastTime = -1;
  let lastRandom: Uint8Array = new Uint8Array(10);
  return () => {
    const time = now();
    if (time <= lastTime) {
      lastRandom = increment(lastRandom);
    } else {
      lastTime = time;
      lastRandom = randomBytes(10);
    }
    return encodeTime(lastTime) + encodeRandom(lastRandom);
  };
}

export const ulid = createUlidFactory();
