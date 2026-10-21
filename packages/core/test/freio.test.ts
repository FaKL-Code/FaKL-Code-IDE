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

  it('soma o contexto de cada requisição e para no limite de tokens', () => {
    const freio = new FreioDaRodada(() => ({ ...FREIO_PADRAO, tokens: 100_000 }));
    expect(freio.contexto(40_000)).toBeUndefined();
    // O mesmo valor repetido é o mesmo evento, não outra requisição.
    expect(freio.contexto(40_000)).toBeUndefined();
    expect(freio.gasto().entrada).toBe(40_000);
    expect(freio.contexto(50_000)).toBeUndefined();
    const parada = freio.contexto(60_000);
    expect(parada?.motivo).toBe('tokens');
    expect(parada?.mensagem).toContain('150.000');
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
