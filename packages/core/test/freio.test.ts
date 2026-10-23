import { describe, expect, it } from 'vitest';

import { FREIO_PADRAO, FreioDaRodada } from '../src/freio.js';

describe('freio da rodada', () => {
  it('para quando a mesma ferramenta é chamada várias vezes seguidas', () => {
    const freio = new FreioDaRodada(() => ({ ...FREIO_PADRAO, repeticoes: 3 }));
    expect(freio.ferramenta('a', 'Ler docs.md')).toBeUndefined();
    expect(freio.ferramenta('b', 'Ler docs.md')).toBeUndefined();
    const parada = freio.ferramenta('c', 'Ler docs.md');
    expect(parada?.motivo).toBe('repeticao');
    // Só uma parada por rodada.
    expect(freio.ferramenta('d', 'Ler docs.md')).toBeUndefined();
  });

  it('uma ferramenta diferente no meio zera a sequência', () => {
    const freio = new FreioDaRodada(() => ({ ...FREIO_PADRAO, repeticoes: 3 }));
    for (const [i, titulo] of ['A', 'A', 'B', 'A', 'A'].entries()) {
      expect(freio.ferramenta(`t${i}`, titulo)).toBeUndefined();
    }
  });

  it('compara pelo título completo que chega no update, não pelo genérico', () => {
    // O ACP abre toda chamada de shell como "Terminal" e manda o comando depois.
    const freio = new FreioDaRodada(() => ({ ...FREIO_PADRAO, repeticoes: 3 }));
    for (const [i, comando] of ['ls', 'npm test', 'cat a.js', 'npm test', 'git diff'].entries()) {
      expect(freio.ferramenta(`t${i}`, 'Terminal')).toBeUndefined();
      expect(freio.ferramenta(`t${i}`, comando)).toBeUndefined();
      expect(freio.ferramenta(`t${i}`, undefined)).toBeUndefined();
    }
    expect(freio.ferramenta('r1', 'Terminal')).toBeUndefined();
    expect(freio.ferramenta('r1', 'npm test')).toBeUndefined();
    expect(freio.ferramenta('r2', 'Terminal')).toBeUndefined();
    expect(freio.ferramenta('r2', 'npm test')).toBeUndefined();
    expect(freio.ferramenta('r3', 'Terminal')).toBeUndefined();
    expect(freio.ferramenta('r3', 'npm test')?.motivo).toBe('repeticao');
    expect(freio.gasto().passos).toBe(8);
  });

  it('edições diferentes do mesmo arquivo não são repetição; iguais são', () => {
    // O título é o mesmo ("Edit config.ts"); o que muda são os argumentos.
    const freio = new FreioDaRodada(() => ({ ...FREIO_PADRAO, repeticoes: 3 }));
    for (let i = 0; i < 8; i++) {
      expect(freio.ferramenta(`e${i}`, 'Edit config.ts')).toBeUndefined();
      expect(freio.ferramenta(`e${i}`, 'Edit config.ts', `args${i}`)).toBeUndefined();
      expect(freio.ferramenta(`e${i}`, undefined)).toBeUndefined();
    }
    expect(freio.ferramenta('r1', 'Edit config.ts', 'igual')).toBeUndefined();
    expect(freio.ferramenta('r2', 'Edit config.ts', 'igual')).toBeUndefined();
    const parada = freio.ferramenta('r3', 'Edit config.ts', 'igual');
    expect(parada?.motivo).toBe('repeticao');
    expect(parada?.mensagem).toContain('(Edit config.ts)');
  });

  it('atualizações da mesma chamada não contam como passo novo', () => {
    const freio = new FreioDaRodada(() => ({ ...FREIO_PADRAO, passos: 3, repeticoes: 0 }));
    freio.ferramenta('x', 'Ler a');
    freio.ferramenta('x', 'Ler a');
    freio.ferramenta('x', 'Ler a');
    expect(freio.gasto().passos).toBe(1);
  });

  it('para no limite de passos', () => {
    const freio = new FreioDaRodada(() => ({ ...FREIO_PADRAO, passos: 3, repeticoes: 0 }));
    expect(freio.ferramenta('1', 'a')).toBeUndefined();
    expect(freio.ferramenta('2', 'b')).toBeUndefined();
    expect(freio.ferramenta('3', 'c')?.motivo).toBe('passos');
  });

  it('soma o contexto de cada requisição, com o cache a um décimo, e para no limite de tokens', () => {
    const freio = new FreioDaRodada(() => ({ ...FREIO_PADRAO, tokens: 60_000 }));
    expect(freio.contexto(40_000)).toBeUndefined();
    // O mesmo valor repetido é o mesmo evento, não outra requisição.
    expect(freio.contexto(40_000)).toBeUndefined();
    expect(freio.gasto().entrada).toBe(40_000);
    // 10 mil novos inteiros e os 40 mil do cache a um décimo.
    expect(freio.contexto(50_000)).toBeUndefined();
    expect(freio.gasto().entrada).toBe(54_000);
    const parada = freio.contexto(60_000);
    expect(parada?.motivo).toBe('tokens');
    expect(parada?.mensagem).toContain('69.000');
  });

  it('não para um maestro normal: 26 requisições de 34 mil a 80 mil de contexto', () => {
    // O que o benchmark mediu: somando o contexto cheio, eram 1,57 milhão e o freio parava.
    const freio = new FreioDaRodada();
    for (let i = 0; i < 26; i++) {
      expect(freio.contexto(34_000 + Math.round((i * 46_000) / 25))).toBeUndefined();
    }
    expect(freio.gasto().entrada).toBeLessThan(300_000);
  });

  it('depois de compactar, o contexto menor conta inteiro', () => {
    const freio = new FreioDaRodada();
    freio.contexto(80_000);
    freio.contexto(20_000);
    expect(freio.gasto().entrada).toBe(100_000);
    // E o cache segue entre rodadas: a próxima já começa com o prefixo.
    freio.iniciar();
    freio.contexto(25_000);
    expect(freio.gasto().entrada).toBe(7_000);
  });

  it('zero desliga o limite e iniciar zera a rodada', () => {
    const livre = new FreioDaRodada(() => ({ tokens: 0, passos: 0, repeticoes: 0 }));
    for (let i = 0; i < 500; i++) expect(livre.ferramenta(`t${i}`, 'igual')).toBeUndefined();
    expect(livre.contexto(900_000_000)).toBeUndefined();

    const freio = new FreioDaRodada(() => ({ ...FREIO_PADRAO, passos: 2, repeticoes: 0 }));
    freio.ferramenta('1', 'a');
    expect(freio.ferramenta('2', 'b')?.motivo).toBe('passos');
    freio.iniciar();
    expect(freio.gasto()).toEqual({ passos: 0, entrada: 0 });
    expect(freio.ferramenta('3', 'c')).toBeUndefined();
  });
});
