import { useLocale } from '@fakl/i18n';
import type { AgentState } from '@fakl/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  Announcer,
  describeRoom,
  describeSeat,
  statusKind,
  statusText,
  type SeatInfo,
} from '../src/anuncios-model.js';

function seat(id: string, state: AgentState, extra: Partial<SeatInfo> = {}): SeatInfo {
  return { id, name: id.toUpperCase(), state, limited: false, ...extra };
}

beforeEach(() => {
  useLocale('en');
});

describe('statusKind', () => {
  it('trata pensar e executar como trabalhando', () => {
    expect(statusKind('pensando')).toBe('trabalhando');
    expect(statusKind('executando')).toBe('trabalhando');
  });

  it('o limite estourado vale mais que o estado, menos nos finais', () => {
    expect(statusKind('executando', true)).toBe('limite');
    expect(statusKind('aguardando-você', true)).toBe('limite');
    expect(statusKind('falhou', true)).toBe('falhou');
    expect(statusKind('concluído', true)).toBe('intervalo');
  });

  it('distingue pedir permissão de esperar o usuário', () => {
    expect(statusKind('aguardando-permissão')).toBe('permissao');
    expect(statusKind('aguardando-você')).toBe('voce');
  });
});

describe('textos', () => {
  it('descreve o agente com o estado e o detalhe', () => {
    expect(describeSeat(seat('ana', 'executando'))).toBe('ANA, working');
    expect(describeSeat(seat('ana', 'pausado', { detail: 'tests' }))).toBe('ANA, paused, tests');
    expect(describeSeat(seat('ana', 'executando', { limited: true }))).toBe('ANA, limit reached');
  });

  it('resume a sala por urgência', () => {
    const text = describeRoom([
      seat('a', 'executando'),
      seat('b', 'aguardando-você'),
      seat('c', 'pensando'),
    ]);
    expect(text).toBe('3 agents: 1 waiting for you, 2 working');
    expect(describeRoom([seat('a', 'ocioso')])).toBe('1 agent: 1 idle');
    expect(describeRoom([])).toBe('Nobody in the café.');
    expect(describeRoom([seat('a', 'ocioso')], true)).toBe('Café disconnected.');
  });

  it('tem texto para todo estado', () => {
    for (const kind of [
      'chegando',
      'trabalhando',
      'ocioso',
      'permissao',
      'voce',
      'pausado',
      'intervalo',
      'falhou',
      'parado',
      'limite',
    ] as const) {
      expect(statusText(kind)).not.toBe('');
    }
  });
});

describe('Announcer', () => {
  it('a primeira leitura só fixa o ponto de partida', () => {
    const announcer = new Announcer();
    announcer.observe([seat('a', 'executando'), seat('b', 'ocioso')]);
    expect(announcer.waiting).toBe(false);
    expect(announcer.take(0)).toBeUndefined();
  });

  it('anuncia a mudança de estado e não a repete', () => {
    const announcer = new Announcer();
    announcer.observe([seat('a', 'executando')]);
    announcer.observe([seat('a', 'aguardando-você')]);
    expect(announcer.take(0)).toBe('A: waiting for you');
    announcer.observe([seat('a', 'aguardando-você')]);
    expect(announcer.take(10_000)).toBeUndefined();
  });

  it('pensar e executar não geram anúncio', () => {
    const announcer = new Announcer();
    announcer.observe([seat('a', 'pensando')]);
    announcer.observe([seat('a', 'executando')]);
    announcer.observe([seat('a', 'pensando')]);
    expect(announcer.waiting).toBe(false);
  });

  it('respeita o intervalo mínimo e agrupa o que chegou nesse meio tempo', () => {
    const announcer = new Announcer({ minIntervalMs: 5_000 });
    announcer.observe([seat('a', 'executando'), seat('b', 'executando')]);
    announcer.observe([seat('a', 'pausado'), seat('b', 'executando')]);
    expect(announcer.take(1_000)).toBe('A: paused');
    announcer.observe([seat('a', 'pausado'), seat('b', 'falhou')]);
    expect(announcer.waitMs(2_000)).toBe(4_000);
    expect(announcer.take(2_000)).toBeUndefined();
    announcer.observe([seat('a', 'executando'), seat('b', 'falhou')]);
    expect(announcer.take(6_000)).toBe('B: failed; A: working');
  });

  it('uma mudança que volta ao que já foi dito some', () => {
    const announcer = new Announcer();
    announcer.observe([seat('a', 'executando')]);
    announcer.observe([seat('a', 'pausado')]);
    announcer.observe([seat('a', 'executando')]);
    expect(announcer.waiting).toBe(false);
  });

  it('só o último estado de cada agente conta', () => {
    const announcer = new Announcer();
    announcer.observe([seat('a', 'executando')]);
    announcer.observe([seat('a', 'aguardando-permissão')]);
    announcer.observe([seat('a', 'pausado')]);
    expect(announcer.take(0)).toBe('A: paused');
  });

  it('limita os nomes e conta o resto', () => {
    const announcer = new Announcer({ maxNames: 2 });
    const ids = ['a', 'b', 'c', 'd'];
    announcer.observe(ids.map((id) => seat(id, 'executando')));
    announcer.observe(ids.map((id) => seat(id, 'pausado')));
    expect(announcer.take(0)).toBe('A: paused; B: paused; and 2 more changes');
  });

  it('anuncia limite estourado antes de tudo', () => {
    const announcer = new Announcer();
    announcer.observe([seat('a', 'executando'), seat('b', 'executando')]);
    announcer.observe([seat('a', 'ocioso'), seat('b', 'executando', { limited: true })]);
    expect(announcer.take(0)).toBe('B: limit reached; A: idle');
  });

  it('anuncia chegada e saída, mas não a saída de quem já tinha terminado', () => {
    const announcer = new Announcer();
    announcer.observe([seat('a', 'executando'), seat('b', 'concluído')]);
    announcer.observe([seat('a', 'executando'), seat('c', 'preparando')]);
    expect(announcer.take(0)).toBe('C: arriving');
    announcer.observe([seat('c', 'preparando')]);
    expect(announcer.take(10_000)).toBe('A left the café');
  });

  it('não há espera sem pendência', () => {
    const announcer = new Announcer();
    expect(announcer.waitMs(0)).toBeUndefined();
  });
});
