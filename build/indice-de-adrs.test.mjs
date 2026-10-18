import { describe, expect, it } from 'vitest';

import {
  arquivosDeAdr,
  carregar,
  descricoesDoIndice,
  montarTabela,
  reescreverIndice,
  tituloDoAdr,
} from './indice-de-adrs.mjs';

describe('índice de ADRs', () => {
  it('lê descrições e títulos', () => {
    const texto =
      '| [0001](adr/0001-a.md) | Fork do VSCodium |\n| [0002](adr/0002-b.md)  | Monorepo |\n';
    expect(descricoesDoIndice(texto)).toEqual({
      '0001-a.md': 'Fork do VSCodium',
      '0002-b.md': 'Monorepo',
    });
    expect(tituloDoAdr('# 0042. Varredura de recursos\n\n- Status')).toBe('Varredura de recursos');
  });

  it('monta uma linha por arquivo, com a descrição curada ou o título', () => {
    const tabela = montarTabela(
      ['0001-a.md', '0002-b.md'],
      { '0001-a.md': 'Curada' },
      { '0002-b.md': 'Do título' },
    );
    expect(tabela.split('\n')).toEqual([
      '| ADR | Decisão |',
      '| --- | --- |',
      '| [0001](adr/0001-a.md) | Curada |',
      '| [0002](adr/0002-b.md) | Do título |',
    ]);
  });

  it('troca todas as tabelas duplicadas por uma só e preserva o resto', () => {
    const texto = [
      '- lista',
      '',
      '| ADR | Decisão |',
      '| --- | --- |',
      '| [0001](adr/0001-a.md) | A |',
      '| ADR | Decisão |',
      '| --- | --- |',
      '| [0001](adr/0001-a.md) | A |',
      '',
      'fim',
    ].join('\n');
    const novo = reescreverIndice(
      texto,
      montarTabela(['0001-a.md', '0002-b.md'], {}, { '0001-a.md': 'A', '0002-b.md': 'B' }),
    );
    expect(novo.match(/\| ADR \|/g)).toHaveLength(1);
    expect(novo).toContain('| [0002](adr/0002-b.md) | B |');
    expect(novo.startsWith('- lista\n')).toBe(true);
    expect(novo.endsWith('\nfim')).toBe(true);
  });

  it('o docs/README.md do repositório lista cada ADR uma única vez, com um só cabeçalho', () => {
    const { texto, arquivos } = carregar();
    const linhas = texto.split(/\r?\n/);
    expect(linhas.filter((l) => /^\|\s*ADR\s*\|/.test(l))).toHaveLength(1);
    for (const arquivo of arquivos) {
      const ocorrencias = linhas.filter((l) => l.includes(`](adr/${arquivo})`));
      expect(ocorrencias, arquivo).toHaveLength(1);
    }
    expect(arquivosDeAdr().length).toBeGreaterThan(40);
  });
});
