import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import { lineDiff } from '../src/diff.js';

describe('diff por linhas', () => {
  afterEach(() => useLocale('en'));

  it('mostra o que entrou e saiu com contexto', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j'].join('\n');
    expect(lineDiff(before, after, 1)).toEqual([
      { tipo: 'pulo', texto: '3 unchanged lines' },
      { tipo: 'igual', texto: 'd' },
      { tipo: 'menos', texto: 'e' },
      { tipo: 'mais', texto: 'E' },
      { tipo: 'igual', texto: 'f' },
      { tipo: 'pulo', texto: '2 unchanged lines' },
      { tipo: 'igual', texto: 'i' },
      { tipo: 'mais', texto: 'j' },
    ]);
  });

  it('o trecho pulado fala de uma linha no singular e em pt-BR', () => {
    const before = ['a', 'b', 'c'].join('\n');
    const after = ['a', 'b', 'C'].join('\n');
    expect(lineDiff(before, after, 1)[0]).toEqual({ tipo: 'pulo', texto: '1 unchanged line' });
    useLocale('pt-br');
    expect(lineDiff(before, after, 1)[0]).toEqual({ tipo: 'pulo', texto: '1 linha igual' });
    expect(lineDiff('a\nb\nc\nd', 'a\nb\nc\nD', 1)[0]).toEqual({
      tipo: 'pulo',
      texto: '2 linhas iguais',
    });
  });

  it('arquivo novo e arquivo apagado', () => {
    expect(lineDiff('', 'x\ny')).toEqual([
      { tipo: 'mais', texto: 'x' },
      { tipo: 'mais', texto: 'y' },
    ]);
    expect(lineDiff('x', '')).toEqual([{ tipo: 'menos', texto: 'x' }]);
  });

  it('iguais não geram nada', () => {
    expect(lineDiff('a\nb', 'a\r\nb')).toEqual([]);
  });
});
