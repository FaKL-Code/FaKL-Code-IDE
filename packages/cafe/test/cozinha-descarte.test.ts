import type { CiRun } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import { Descarte, terminou } from '../src/index.js';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const minAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

function run(id: number, estado: CiRun['estado'], endedMinAgo = 1): CiRun {
  return {
    repo: 'FaKL-Code/FaKL-Code-IDE',
    id,
    numero: id,
    nome: `fluxo ${String(id)}`,
    evento: 'push',
    estado,
    url: `https://github.com/x/y/actions/runs/${String(id)}`,
    inicio: minAgo(endedMinAgo + 2),
    fim: minAgo(endedMinAgo),
    jobs: [],
  };
}

describe('cozinha do CI: o que sai da tela', () => {
  it('só as execuções terminadas contam como concluídas', () => {
    expect(terminou(run(1, 'sucesso'))).toBe(true);
    expect(terminou(run(2, 'falha'))).toBe(true);
    expect(terminou(run(3, 'cancelada'))).toBe(true);
    expect(terminou(run(4, 'trabalhando'))).toBe(false);
    expect(terminou(run(5, 'fila'))).toBe(false);
    expect(terminou(run(6, 'aguardando'))).toBe(false);
  });

  it('dispensar esconde a execução, e ela volta se o estado mudar', () => {
    const descarte = new Descarte({ saemAposMs: 0 });
    descarte.dispensar(run(1, 'falha'));
    expect(descarte.visiveis([run(1, 'falha'), run(2, 'falha')], NOW).map((r) => r.id)).toEqual([
      2,
    ]);
    // Reexecutada: a mesma execução passou a rodar, então volta à bancada.
    expect(descarte.visiveis([run(1, 'trabalhando')], NOW)).toHaveLength(1);
  });

  it('limpar concluídas tira o que terminou e deixa o que está em andamento', () => {
    const descarte = new Descarte({ saemAposMs: 0 });
    const runs = [run(1, 'sucesso'), run(2, 'falha'), run(3, 'trabalhando'), run(4, 'aguardando')];
    expect(descarte.limparConcluidas(runs)).toBe(2);
    expect(descarte.visiveis(runs, NOW).map((r) => r.id)).toEqual([3, 4]);
    expect(descarte.limparConcluidas(runs)).toBe(0);
    expect(descarte.quantasEscondidas(runs)).toBe(2);
  });

  it('restaurar traz tudo de volta', () => {
    const descarte = new Descarte({ saemAposMs: 0 });
    const runs = [run(1, 'sucesso'), run(2, 'falha')];
    descarte.limparConcluidas(runs);
    descarte.restaurar();
    expect(descarte.visiveis(runs, NOW)).toHaveLength(2);
  });

  it('sucesso e cancelada saem sozinhas depois do prazo; falha fica', () => {
    const descarte = new Descarte({ saemAposMs: 10 * 60_000 });
    const runs = [
      run(1, 'sucesso', 30),
      run(2, 'cancelada', 30),
      run(3, 'falha', 30),
      run(4, 'sucesso', 5),
      run(5, 'trabalhando', 30),
    ];
    expect(descarte.visiveis(runs, NOW).map((r) => r.id)).toEqual([3, 4, 5]);
  });

  it('prazo 0 desliga a saída automática', () => {
    const descarte = new Descarte({ saemAposMs: 0 });
    expect(descarte.visiveis([run(1, 'sucesso', 600)], NOW)).toHaveLength(1);
  });

  it('guarda e recupera o que foi dispensado, e poda o que não existe mais', () => {
    const descarte = new Descarte({ saemAposMs: 0 });
    descarte.dispensar(run(1, 'falha'));
    descarte.dispensar(run(2, 'sucesso'));
    const outro = new Descarte({ saemAposMs: 0 }, descarte.salvar());
    expect(outro.visiveis([run(1, 'falha'), run(2, 'sucesso')], NOW)).toEqual([]);
    outro.podar([run(1, 'falha')]);
    expect(Object.keys(outro.salvar())).toHaveLength(1);
  });
});
