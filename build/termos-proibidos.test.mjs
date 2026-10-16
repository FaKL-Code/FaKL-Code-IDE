import { describe, expect, it } from 'vitest';

import { candidatos, hash, lerLista, mascarar, procurar } from './termos-proibidos.mjs';

const lista = lerLista(
  [
    '# comentário',
    `${hash('ana-pc')}  # máquina`,
    hash('ana@exemplo.com'),
    hash('203.0.113.10'),
    hash('c:/src'),
    hash('silva'),
    '',
  ].join('\n'),
);

const termos = (texto) => procurar(texto, lista).map((achado) => achado.termo);

describe('termos proibidos', () => {
  it('gera a palavra inteira e as sequências das partes dela', () => {
    expect([...candidatos('relay.Exemplo.com')]).toEqual([
      'relay',
      'relay.exemplo',
      'relay.exemplo.com',
      'exemplo',
      'exemplo.com',
      'com',
    ]);
  });

  it('casa nomes, emails, IPs, máquinas e caminhos em qualquer caixa e barra', () => {
    expect(termos('host: 203.0.113.10')).toEqual(['203.0.113.10']);
    expect(termos('Autor: Ana SILVA <ana@exemplo.com>')).toEqual(['silva', 'ana@exemplo.com']);
    expect(termos('runner ana-pc-2')).toEqual(['ana-pc']);
    expect(termos("caminho: 'C:\\src\\app'")).toEqual(['c:/src']);
  });

  it('não casa pedaços de palavras', () => {
    expect(termos('C:\\srcx silvado 203.0.113.100 bana-pc')).toEqual([]);
  });

  it('informa a linha de cada ocorrência', () => {
    expect(procurar('ok\nhost 203.0.113.10\n', lista)).toEqual([
      { linha: 2, termo: '203.0.113.10' },
    ]);
  });

  it('mascara o termo no relatório', () => {
    expect(mascarar('203.0.113.10')).toBe('20••••••••••');
    expect(mascarar('ab')).toBe('ab•••');
  });
});
