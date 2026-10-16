import type { FaklEvent } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import { Transcript } from '../src/transcript.js';

const event = (topic: FaklEvent['topic'], data: unknown): FaklEvent => ({
  id: '01',
  ts: new Date().toISOString(),
  topic,
  subject: 's1',
  data,
});

describe('Transcript', () => {
  it('junta os pedaços da resposta do agente num item só', () => {
    const t = new Transcript();
    t.addUser('oi');
    expect(t.apply(event('agent.output', { kind: 'message', text: 'Olá' }))).toEqual([1]);
    expect(t.apply(event('agent.output', { kind: 'message', text: ', tudo bem?' }))).toEqual([1]);
    expect(t.items).toEqual([
      { kind: 'user', text: 'oi' },
      { kind: 'agent', text: 'Olá, tudo bem?' },
    ]);
  });

  it('atualiza a mesma ferramenta pelo id', () => {
    const t = new Transcript();
    t.apply(event('agent.tool', { toolCallId: 't1', title: 'Ler a.txt', status: 'pending' }));
    t.apply(event('agent.output', { kind: 'message', text: 'lendo' }));
    expect(t.apply(event('agent.tool', { toolCallId: 't1', status: 'completed' }))).toEqual([0]);
    expect(t.items[0]).toEqual({ kind: 'tool', id: 't1', title: 'Ler a.txt', status: 'completed' });
    // Depois de uma ferramenta, a resposta seguinte começa outro item.
    expect(t.apply(event('agent.output', { kind: 'message', text: 'feito' }))).toEqual([1]);
  });

  it('registra e responde pedidos de permissão', () => {
    const t = new Transcript();
    t.apply(event('agent.permission', { id: 'p1', title: 'Escrever b.txt', options: [] }));
    expect(t.pendingPermissions()).toEqual(['p1']);
    expect(t.answer('p1', false)).toEqual([0]);
    expect(t.items[0]).toEqual({
      kind: 'permission',
      id: 'p1',
      title: 'Escrever b.txt',
      answer: 'negado',
    });
    expect(t.pendingPermissions()).toEqual([]);
    expect(t.answer('outro', true)).toEqual([]);
  });

  it('guarda os argumentos da chamada no pedido de permissão', () => {
    const t = new Transcript();
    t.apply(
      event('agent.permission', {
        id: 'p1',
        title: 'mcp__fakl__ssh_exec',
        detail: 'host: 203.0.113.10\ncomando: uptime; df -h',
        options: [],
      }),
    );
    expect(t.items[0]).toEqual({
      kind: 'permission',
      id: 'p1',
      title: 'mcp__fakl__ssh_exec',
      detail: 'host: 203.0.113.10\ncomando: uptime; df -h',
    });
  });

  it('marca o pedido respondido em outro lugar e avisa o que o autopilot aplicou', () => {
    const t = new Transcript();
    t.apply(event('agent.permission', { id: 'p1', title: 'Rodar testes', options: [] }));
    expect(t.apply(event('agent.answer', { id: 'p1', allow: true }))).toEqual([0]);
    expect(t.items[0]).toMatchObject({ answer: 'permitido' });
    expect(t.apply(event('agent.answer', { id: 'p1', allow: false }))).toEqual([]);
    t.apply(event('agent.applied', { aplicados: ['a.txt'], pendentes: ['b.txt'] }));
    expect(t.items[1]).toMatchObject({ kind: 'notice', tone: 'info' });
    expect((t.items[1] as { text: string }).text).toContain('a.txt');
    expect((t.items[1] as { text: string }).text).toContain('b.txt');
    expect(t.apply(event('agent.applied', { aplicados: [], pendentes: [] }))).toEqual([]);
  });

  it('avisa erros e estados finais, mas não os de trabalho', () => {
    const t = new Transcript();
    expect(t.apply(event('agent.state', { state: 'pensando', previous: 'ocioso' }))).toEqual([]);
    t.apply(event('agent.output', { kind: 'error', text: 'caiu' }));
    t.apply(event('agent.state', { state: 'falhou', previous: 'pensando', reason: 'saiu com 1' }));
    expect(t.items).toEqual([
      { kind: 'notice', text: 'caiu', tone: 'error' },
      { kind: 'notice', text: 'Agente falhou. (saiu com 1)', tone: 'error' },
    ]);
  });
  it('reconstrói a conversa guardada pelo Core, com o aviso de retomada', () => {
    const ts = new Date().toISOString();
    const t = Transcript.replay('s1', [
      { t: 'user', text: 'oi', ts },
      { t: 'event', topic: 'agent.output', data: { kind: 'message', text: 'Olá' }, ts },
      { t: 'event', topic: 'agent.tool', data: { toolCallId: 't1', title: 'Ler a.txt' }, ts },
      {
        t: 'event',
        topic: 'agent.state',
        data: { state: 'parado', previous: 'ocioso', reason: 'ide-fechando' },
        ts,
      },
      {
        t: 'event',
        topic: 'agent.state',
        data: { state: 'ocioso', previous: 'parado', reason: 'retomada com a sessão do agente' },
        ts,
      },
    ]);
    expect(t.items).toEqual([
      { kind: 'user', text: 'oi' },
      { kind: 'agent', text: 'Olá' },
      { kind: 'tool', id: 't1', title: 'Ler a.txt' },
      { kind: 'notice', text: 'Agente parado. (ide-fechando)', tone: 'info' },
      { kind: 'notice', text: 'Sessão retomada (retomada com a sessão do agente).', tone: 'info' },
    ]);
  });

  it('mostra o que foi pedido ao agente, de onde quer que tenha vindo', () => {
    const t = new Transcript();
    expect(t.apply(event('agent.prompt', { text: 'corrige o teste' }))).toEqual([0]);
    t.apply(event('agent.output', { kind: 'message', text: 'feito' }));
    expect(t.items).toEqual([
      { kind: 'user', text: 'corrige o teste' },
      { kind: 'agent', text: 'feito' },
    ]);
    expect(t.lastAnswer()).toBe('feito');
  });

  it('retoma de itens prontos e descarta os mais antigos', () => {
    const t = Transcript.from([
      { kind: 'user', text: 'a' },
      { kind: 'agent', text: 'b' },
      { kind: 'user', text: 'c' },
    ]);
    expect(t.apply(event('agent.output', { kind: 'message', text: 'd' }))).toEqual([3]);
    expect(t.trim(2)).toBe(2);
    expect(t.items).toEqual([
      { kind: 'user', text: 'c' },
      { kind: 'agent', text: 'd' },
    ]);
    expect(t.trim(5)).toBe(0);
  });
});
