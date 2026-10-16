import { useLocale } from '@fakl/i18n';
import type { ResourceSource } from '@fakl/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  gitUrlProblem,
  groupOffered,
  namesBySource,
  sourceCounts,
  sourceDescription,
} from '../src/resource-sources-model.js';

const source = (patch: Partial<ResourceSource>): ResourceSource => ({
  id: 'base',
  nome: 'Base',
  tipo: 'git',
  caminho: '/fontes/base',
  agents: 0,
  skills: 0,
  mcps: 0,
  ...patch,
});

describe('fontes de recursos na extensão', () => {
  afterEach(() => useLocale('en'));

  it('valida a URL antes de mandar ao Core', () => {
    expect(gitUrlProblem('https://github.com/org/recursos.git')).toBeUndefined();
    expect(gitUrlProblem('git@github.com:org/recursos.git')).toBeUndefined();
    expect(gitUrlProblem('  ')).toBe('Enter the repository URL.');
    expect(gitUrlProblem('ext::sh -c x')).toBe('Invalid URL.');
    expect(gitUrlProblem('/pasta/local')).toMatch(/https:/);
  });

  it('descreve tipo, branch e o que a fonte oferece', () => {
    expect(sourceCounts(source({}))).toBe('no resources');
    expect(sourceCounts(source({ agents: 1, skills: 2, mcps: 1 }))).toBe(
      '1 agent, 2 skills, 1 MCP',
    );
    expect(sourceDescription(source({ branch: 'main', agents: 3 }))).toBe('git · main · 3 agents');
    expect(sourceDescription(source({ tipo: 'pasta', mcps: 2 }))).toBe('folder · 2 MCPs');
    expect(sourceDescription(source({ erro: 'git fetch falhou' }))).toBe('git fetch falhou');
  });

  it('descreve e valida em pt-BR', () => {
    useLocale('pt-br');
    expect(gitUrlProblem('  ')).toBe('Informe a URL do repositório.');
    expect(gitUrlProblem('/pasta/local')).toBe(
      'Use https://, ssh://, git://, file:// ou usuario@host:caminho.',
    );
    expect(sourceCounts(source({}))).toBe('nenhum recurso');
    expect(sourceCounts(source({ agents: 1, skills: 2, mcps: 1 }))).toBe(
      '1 agente, 2 skills, 1 MCP',
    );
    expect(sourceDescription(source({ tipo: 'pasta', agents: 3 }))).toBe('pasta · 3 agentes');
  });

  it('agrupa o que falta instalar por fonte, recomendados primeiro', () => {
    const items = [
      { name: 'zeta', fonte: 'b', instalado: false },
      { name: 'opcional', fonte: 'a', padrao: false, instalado: false },
      { name: 'beta', fonte: 'a', instalado: false },
      { name: 'ja-tem', fonte: 'a', instalado: true },
      { name: 'orfao', fonte: 'sumiu', instalado: false },
    ];
    const groups = groupOffered(items, [
      { id: 'a', nome: 'Fonte A' },
      { id: 'b', nome: 'Fonte B' },
    ]);
    expect(groups.map((g) => [g.nome, g.items.map((i) => i.name)])).toEqual([
      ['Fonte A', ['beta', 'opcional']],
      ['Fonte B', ['zeta']],
      ['sumiu', ['orfao']],
    ]);
    expect(groupOffered([{ name: 'x', fonte: 'a', instalado: true }], [])).toEqual([]);
  });

  it('separa os escolhidos por fonte, sem repetir nomes', () => {
    expect([
      ...namesBySource([
        { name: 'a', fonte: 'f1' },
        { name: 'b', fonte: 'f2' },
        { name: 'c', fonte: 'f1' },
        { name: 'a', fonte: 'f1' },
      ]),
    ]).toEqual([
      ['f1', ['a', 'c']],
      ['f2', ['b']],
    ]);
  });
});
