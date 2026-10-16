import { describe, expect, it } from 'vitest';

import { contextShare, formatTokens, lastLine, usageRing } from '../src/usage.js';

describe('uso', () => {
  it('formata tokens', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1_500)).toBe('1.5k');
    expect(formatTokens(84_000)).toBe('84k');
    expect(formatTokens(1_900_000)).toBe('1.9M');
  });

  it('fração do contexto ocupado, só quando o agente informa', () => {
    const base = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    expect(contextShare(base)).toBeUndefined();
    expect(contextShare({ ...base, context: { used: 50, size: 0 } })).toBeUndefined();
    expect(contextShare({ ...base, context: { used: 50_000, size: 200_000 } })).toBe(0.25);
    expect(contextShare({ ...base, context: { used: 300, size: 200 } })).toBe(1);
  });

  it('teto em tokens usa a mesma escala dos números', () => {
    const ring = usageRing(
      'openai',
      { tokensEntrada: 1_800_000, tokensSaida: 100_000, custoUsd: 0 },
      { tokens: 2_000_000 },
      false,
    );
    expect(ring).toMatchObject({ fracao: 0.95, gasto: '1.9M tok', teto: '2M tok' });
  });

  it('última linha com texto, sem marcação', () => {
    expect(lastLine('primeiro\n\n- **feito**: o `teste` passou\n')).toBe('feito: o teste passou');
    expect(lastLine('## Título')).toBe('Título');
    expect(lastLine('texto\n```ts\ncodigo()\n```')).toBe('codigo()');
    expect(lastLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(lastLine('')).toBe('');
  });
});
