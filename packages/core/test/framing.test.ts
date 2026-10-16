import { describe, expect, it } from 'vitest';

import { encodeMessage, LineDecoder } from '../src/index.js';

describe('framing', () => {
  it('junta pedaços e separa mensagens por linha', () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(decoder.push(':2}\n\n')).toEqual(['{"b":2}']);
    expect(decoder.push('')).toEqual([]);
  });

  it('codifica sem quebras de linha internas', () => {
    const text = encodeMessage({ s: 'linha1\nlinha2' });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(0, -1)).not.toContain('\n');
  });

  it('recusa mensagem acima do limite', () => {
    const decoder = new LineDecoder(8);
    expect(() => decoder.push('0123456789')).toThrow(/maior que 8/);
    expect(decoder.push('{}\n')).toEqual(['{}']);
  });
});
