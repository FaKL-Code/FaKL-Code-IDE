import type { AgentSessionInfo, FaklEvent } from '@fakl/protocol';
import { describe as group, expect, it } from 'vitest';

import { actionGroup, AgentBoard, describe, formatCost } from '../src/board.js';

const session = (id: string, extra: Partial<AgentSessionInfo> = {}): AgentSessionInfo => ({
  sessionId: id,
  profileId: 'claude',
  nome: 'Claude Code',
  cwd: '/repo',
  state: 'ocioso',
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  permissoes: 'perguntar',
  opcoes: [],
  ...extra,
});

const event = (topic: FaklEvent['topic'], subject: string, data: unknown): FaklEvent => ({
  id: '01',
  ts: new Date().toISOString(),
  topic,
  subject,
  data,
});

group('AgentBoard', () => {
  it('atualiza a retomada pelo limite sem perder a sessão e limpa ao retomar', () => {
    const board = new AgentBoard();
    const original = session('01A', { state: 'pausado', cwd: '/repo/worktree' });
    board.load([original]);
    const retomada = {
      motivo: 'limite-sessao',
      mensagem: 'Limite da sessão atingido.',
      retomarEm: '2026-10-15T20:00:00Z',
      automatica: false,
    } as const;

    expect(board.apply(event('agent.recovery', '01A', { retomada }))).toBe('changed');
    expect(board.get('01A')).toEqual({ ...original, retomada });
    const automatic = { ...retomada, automatica: true };
    expect(board.apply(event('agent.recovery', '01A', { retomada: automatic }))).toBe('changed');
    expect(board.get('01A')?.retomada?.automatica).toBe(true);

    expect(board.apply(event('agent.recovery', '01A', { retomada: null }))).toBe('changed');
    expect(board.get('01A')).toEqual(original);
  });

  it('carrega retomada da lista e pede recarga para uma sessão desconhecida', () => {
    const board = new AgentBoard();
    const retomada = {
      motivo: 'limite-sessao',
      mensagem: 'Aguarde a renovação.',
      automatica: false,
    } as const;
    board.load([session('01A', { retomada })]);
    expect(board.list()[0]?.retomada).toEqual(retomada);
    expect(board.apply(event('agent.recovery', '01Z', { retomada }))).toBe('unknown');
  });

  it('acompanha estado e custo pelos eventos', () => {
    const board = new AgentBoard();
    board.load([session('01A')]);

    expect(
      board.apply(event('agent.state', '01A', { state: 'pensando', previous: 'ocioso' })),
    ).toBe('changed');
    expect(
      board.apply(
        event('cost.update', '01A', {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cost: { amount: 0.0123, currency: 'USD' },
        }),
      ),
    ).toBe('changed');

    const current = board.get('01A');
    expect(current?.state).toBe('pensando');
    expect(current && describe(current)).toBe('thinking · $0.0123');

    expect(board.apply(event('agent.mode', '01A', { permissoes: 'autopilot' }))).toBe('changed');
    const auto = board.get('01A');
    expect(auto?.permissoes).toBe('autopilot');
    expect(auto && describe(auto)).toBe('thinking · autopilot · $0.0123');
  });

  it('avisa quando o evento é de uma sessão desconhecida', () => {
    const board = new AgentBoard();
    expect(
      board.apply(event('agent.state', '01Z', { state: 'ocioso', previous: 'preparando' })),
    ).toBe('unknown');
    expect(board.apply(event('agent.output', '01Z', { kind: 'message', text: 'oi' }))).toBe(
      'unchanged',
    );
  });

  it('lista ativos primeiro, mais novos antes, e esconde encerrados', () => {
    const board = new AgentBoard();
    board.load([
      session('01A', { state: 'parado' }),
      session('01B'),
      session('01C', { state: 'concluído' }),
      session('01D', { state: 'pausado' }),
    ]);
    expect(board.list().map((s) => s.sessionId)).toEqual(['01D', '01B', '01C', '01A']);

    expect(board.clearFinished()).toBe(2);
    expect(board.list().map((s) => s.sessionId)).toEqual(['01D', '01B']);
  });

  it('soma ativos e custo por moeda', () => {
    const board = new AgentBoard();
    board.load([
      session('01A', {
        state: 'parado',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cost: { amount: 1, currency: 'USD' },
        },
      }),
      session('01B', {
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cost: { amount: 0.5, currency: 'USD' },
        },
      }),
    ]);
    const { active, cost } = board.totals();
    expect(active).toBe(1);
    expect(cost.get('USD')).toBe(1.5);
  });
});

group('apresentação', () => {
  it('agrupa estados para as ações da árvore', () => {
    expect(actionGroup('ocioso')).toBe('ativo');
    expect(actionGroup('aguardando-você')).toBe('ativo');
    expect(actionGroup('executando')).toBe('ocupado');
    expect(actionGroup('aguardando-permissão')).toBe('ocupado');
    expect(actionGroup('pausado')).toBe('pausado');
    expect(actionGroup('falhou')).toBe('encerrado');
  });

  it('formata custo', () => {
    expect(formatCost({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBeUndefined();
    expect(
      formatCost({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cost: { amount: 2.5, currency: 'EUR' },
      }),
    ).toBe('EUR 2.50');
  });
});
