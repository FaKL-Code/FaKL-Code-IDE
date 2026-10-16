import { describe, expect, it } from 'vitest';

import { parseSessionLimit } from '../src/session-limit.js';

const now = Date.parse('2026-10-15T18:00:00Z');

describe('limite de sessão: parser puro', () => {
  it.each([
    ["You've hit your limit · resets 5pm (America/Sao_Paulo)", '2026-10-15T20:00:00.000Z'],
    ["You've hit your limit · resets 1pm (America/Sao_Paulo)", '2026-10-16T16:00:00.000Z'],
    ['Rate limit exceeded. Retry after 120 seconds', '2026-10-15T18:02:00.000Z'],
    ['Usage limit reached; resets at 2026-10-16T03:00:00Z', '2026-10-16T03:00:00.000Z'],
    ['Rate limit exceeded; reset: 1792108800', '2026-10-16T00:00:00.000Z'],
    ['Rate limit exceeded; reset: 1792108800000', '2026-10-16T00:00:00.000Z'],
    ['Internal error: Rate limit exceeded. Retry after 60 seconds', '2026-10-15T18:01:00.000Z'],
    ['429: Too Many Requests. Retry after 2 minutes', '2026-10-15T18:02:00.000Z'],
  ])('interpreta %s', (message, retomarEm) => {
    expect(parseSessionLimit(message, now)).toMatchObject({
      motivo: 'limite-sessao',
      retomarEm,
      automatica: false,
    });
  });

  it('aceita limite sem horário e ignora horário inválido', () => {
    expect(parseSessionLimit('Session limit reached', now)).toEqual({
      motivo: 'limite-sessao',
      mensagem: 'Session limit reached',
      automatica: false,
    });
    expect(
      parseSessionLimit("You've hit your limit · resets 5pm (Invalid/Zone)", now)?.retomarEm,
    ).toBeUndefined();
  });

  it.each([
    'rate_limit_error: too many requests',
    'usage_limit_reached',
    'RESOURCE_EXHAUSTED: quota exceeded',
    'You have hit your usage limit',
  ])('aceita erros conhecidos do provedor: %s', (message) => {
    expect(parseSessionLimit(message, now)?.motivo).toBe('limite-sessao');
  });

  it.each([
    'O limite de sessão deve aparecer aqui.',
    'I will handle rate limit errors in the code.',
    '```ts\nthrow new Error("Rate limit exceeded")\n```',
    'const text = "You\'ve hit your limit · resets 5pm (America/Sao_Paulo)";',
    "The documentation says: You've hit your limit · resets 5pm (America/Sao_Paulo)",
    'Network connection failed',
  ])('não confunde código ou menções com falha: %s', (message) => {
    expect(parseSessionLimit(message, now)).toBeUndefined();
  });
});
