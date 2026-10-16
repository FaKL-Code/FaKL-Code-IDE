import { describe, expect, it } from 'vitest';

import { createUlidFactory, ulid } from '../src/index.js';

describe('ulid', () => {
  it('tem 26 caracteres de Base32 de Crockford', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('codifica o tempo nos 10 primeiros caracteres', () => {
    const make = createUlidFactory(() => 0);
    expect(make().slice(0, 10)).toBe('0000000000');
    const later = createUlidFactory(() => 1_700_000_000_000);
    expect(later().slice(0, 10)).toBe('01HF7YAT00');
  });

  it('é monotônico no mesmo milissegundo e ordenável entre milissegundos', () => {
    let now = 1_000;
    const make = createUlidFactory(() => now);
    const ids = [make(), make(), make()];
    now = 1_001;
    ids.push(make());
    now = 999; // relógio voltou: continua crescente
    ids.push(make());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
