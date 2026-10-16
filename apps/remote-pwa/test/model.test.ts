import type {
  AgentSessionInfo,
  ClaudeAccountsState,
  CostSummary,
  FaklEvent,
  Run,
  Task,
} from '@fakl/protocol';
import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ago,
  claudeAccountChoices,
  closestCap,
  Conversations,
  folderName,
  groupAgents,
  groupTasks,
  LiveLines,
  MAX_ITEMS,
  providerUsage,
  stateLabel,
  stateTone,
} from '../src/model.js';

const agent = (
  sessionId: string,
  state: AgentSessionInfo['state'],
  extra: Partial<AgentSessionInfo> = {},
): AgentSessionInfo => ({
  sessionId,
  profileId: 'claude',
  nome: 'Claude Code',
  cwd: '/repo',
  state,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  permissoes: 'perguntar',
  opcoes: [],
  ...extra,
});

let seq = 0;
const event = (
  topic: FaklEvent['topic'],
  data: unknown,
  subject = 's1',
  id = `01${String(++seq).padStart(24, '0')}`,
): FaklEvent => ({ id, ts: new Date().toISOString(), topic, subject, data });

describe('agentes', () => {
  afterEach(() => useLocale('en'));

  it('separa quem espera você, os vivos e os encerrados', () => {
    const groups = groupAgents(
      [
        agent('fim-velho', 'parado', { encerradaEm: '2026-10-12T10:00:00Z' }),
        agent('ocioso', 'ocioso', { atividadeEm: '2026-10-13T10:05:00Z' }),
        agent('trabalhando', 'executando', { atividadeEm: '2026-10-13T10:00:00Z' }),
        agent('pede', 'aguardando-permissão'),
        agent('fim-novo', 'concluído', { encerradaEm: '2026-10-13T09:00:00Z' }),
        agent('pendente', 'pensando'),
      ],
      new Set(['pendente']),
    );
    expect(groups.atencao.map((a) => a.sessionId).sort()).toEqual(['pede', 'pendente']);
    // Quem trabalha vem antes de quem está ocioso, mesmo com atividade mais velha.
    expect(groups.ativos.map((a) => a.sessionId)).toEqual(['trabalhando', 'ocioso']);
    expect(groups.encerrados.map((a) => a.sessionId)).toEqual(['fim-novo', 'fim-velho']);
  });

  it('dá um tom a cada estado', () => {
    expect(stateTone('executando')).toBe('ativo');
    expect(stateTone('aguardando-você')).toBe('atencao');
    expect(stateTone('pausado')).toBe('pausa');
    expect(stateTone('falhou')).toBe('ruim');
    expect(stateTone('parado')).toBe('neutro');
  });

  it('tempo relativo e rótulos em pt-BR', () => {
    useLocale('pt-br');
    const now = Date.parse('2026-10-13T12:00:00Z');
    expect(ago('2026-10-13T11:59:50Z', now)).toBe('agora');
    expect(ago('2026-10-13T11:55:00Z', now)).toBe('há 5 min');
    expect(ago('2026-10-13T09:00:00Z', now)).toBe('há 3 h');
    expect(ago('2026-10-12T09:00:00Z', now)).toBe('ontem');
    expect(ago('2026-10-01T09:00:00Z', now)).toBe('01/10');
    expect(stateLabel('aguardando-você')).toBe('Espera você');
    expect(stateLabel('parado')).toBe('Encerrado');
  });

  it('tempo relativo e nome da pasta', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    expect(ago('2026-10-13T11:59:50Z', now)).toBe('now');
    expect(ago('2026-10-13T11:55:00Z', now)).toBe('5 min ago');
    expect(ago('2026-10-13T09:00:00Z', now)).toBe('3 h ago');
    expect(ago('2026-10-12T09:00:00Z', now)).toBe('yesterday');
    expect(ago('2026-10-01T09:00:00Z', now)).toBe('10/01');
    expect(ago(undefined, now)).toBe('');
    expect(folderName('C:\\dev\\loja\\')).toBe('loja');
    expect(stateLabel('aguardando-você')).toBe('Needs you');
    expect(folderName('/home/eu/site')).toBe('site');
  });
});

describe('conversas', () => {
  it('não conta duas vezes o evento que já estava no retrato', () => {
    const conversations = new Conversations();
    conversations.begin('s1');
    // Chegam enquanto o retrato carrega: um já contado, um novo.
    const counted = event('agent.output', { kind: 'message', text: ' mundo' }, 's1', '0005');
    const fresh = event('agent.output', { kind: 'message', text: '!' }, 's1', '0006');
    expect(conversations.apply(counted)).toBeUndefined();
    expect(conversations.apply(fresh)).toBeUndefined();
    const patch = conversations.load('s1', {
      items: [
        { kind: 'user', text: 'oi' },
        { kind: 'agent', text: 'olá mundo' },
      ],
      omitidos: 3,
      ultimoEvento: '0005',
    });
    expect(patch.reset).toBe(true);
    expect(conversations.items('s1')).toEqual([
      { kind: 'user', text: 'oi' },
      { kind: 'agent', text: 'olá mundo!' },
    ]);
    expect(conversations.omitidos('s1')).toBe(3);
    // Ao vivo, depois de carregada.
    const next = conversations.apply(event('agent.prompt', { text: 'valeu' }, 's1', '0007'));
    expect(next).toEqual({ sessionId: 's1', indexes: [2], reset: false });
  });

  it('lembra a falha e só tenta de novo quando pedem', () => {
    const conversations = new Conversations();
    conversations.begin('s1');
    conversations.fail('s1', 'resposta grande demais');
    expect(conversations.has('s1')).toBe(true);
    expect(conversations.failure('s1')).toBe('resposta grande demais');
    expect(conversations.items('s1')).toBeUndefined();
    conversations.retry('s1');
    expect(conversations.has('s1')).toBe(false);
    conversations.fail('s1', 'x');
    conversations.clear();
    expect(conversations.failure('s1')).toBeUndefined();
  });

  it('ignora conversas que não estão abertas', () => {
    const conversations = new Conversations();
    expect(conversations.apply(event('agent.output', { kind: 'message', text: 'x' }))).toBe(
      undefined,
    );
    expect(conversations.has('s1')).toBe(false);
  });

  it('descarta o começo de conversas longas e pede para redesenhar', () => {
    const conversations = new Conversations();
    conversations.begin('s1');
    conversations.load('s1', {
      items: Array.from({ length: MAX_ITEMS }, (_, i) => ({
        kind: 'user' as const,
        text: String(i),
      })),
      omitidos: 0,
    });
    const patch = conversations.apply(event('agent.prompt', { text: 'mais um' }));
    expect(patch?.reset).toBe(true);
    expect(conversations.items('s1')).toHaveLength(MAX_ITEMS);
    expect(conversations.omitidos('s1')).toBe(1);
  });
});

describe('falas ao vivo', () => {
  it('junta os pedaços e recomeça depois de uma ferramenta', () => {
    const live = new LiveLines();
    live.apply(event('agent.output', { kind: 'message', text: 'Vou ' }));
    live.apply(event('agent.output', { kind: 'message', text: 'ler o arquivo.' }));
    expect(live.get('s1')).toBe('Vou ler o arquivo.');
    live.apply(event('agent.tool', { toolCallId: 't1' }));
    live.apply(event('agent.output', { kind: 'message', text: 'Pronto.' }));
    expect(live.get('s1')).toBe('Pronto.');
    // Pensamentos não contam como fala.
    expect(live.apply(event('agent.output', { kind: 'thought', text: 'hmm' }))).toBe(false);
  });
});

describe('uso e tarefas', () => {
  const summary: CostSummary = {
    dia: '2026-10-13',
    total: { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 },
    porProvedor: {
      google: { tokensEntrada: 1_000, tokensSaida: 0, custoUsd: 0 },
      anthropic: { tokensEntrada: 0, tokensSaida: 0, custoUsd: 5 },
    },
    porSessao: {},
    tetos: { anthropic: { custoUsd: 10 }, openai: { tokens: 1_000 } },
    bloqueados: ['openai'],
  };

  it('ordena os provedores pelo aperto do teto', () => {
    expect(providerUsage(summary).map((r) => r.provedor)).toEqual([
      'openai',
      'anthropic',
      'google',
    ]);
    expect(closestCap(summary)?.provedor).toBe('openai');
    expect(closestCap(undefined)).toBeUndefined();
    expect(closestCap({ ...summary, tetos: {}, bloqueados: [] })).toBeUndefined();
  });

  it('separa as tarefas em andamento das recentes', () => {
    const task = (id: string, criadaEm: string, runs: string[]): Task => ({
      id,
      titulo: id,
      repoPath: '/repo',
      status: 'nova',
      criadaEm,
      runs,
    });
    const run = (id: string, status: Run['status']): Run => ({
      id,
      taskId: id,
      status,
      inicio: '',
      branch: '',
      agentes: [],
      rodadas: [],
      decisoes: [],
    });
    const runs = new Map([
      ['r1', run('r1', 'aguardando-decisão')],
      ['r2', run('r2', 'concluída')],
    ]);
    const groups = groupTasks(
      [task('a', '2026-10-13T01:00:00Z', ['r2']), task('b', '2026-10-13T02:00:00Z', ['r1'])],
      runs,
    );
    expect(groups.andamento.map((t) => t.id)).toEqual(['b']);
    expect(groups.recentes.map((t) => t.id)).toEqual(['a']);
  });
});

describe('contas do Claude', () => {
  const use = (tokens: number) => ({ tokensEntrada: tokens, tokensSaida: 0, custoUsd: 0 });
  const state: ClaudeAccountsState = {
    ativa: 2,
    contas: [
      {
        slot: 1,
        apelido: 'Pessoal',
        dir: '/c/1',
        logada: true,
        email: 'a@x.com',
        plano: 'Max',
        ativa: false,
        uso: use(500),
      },
      { slot: 2, apelido: 'Trabalho', dir: '/c/2', ativa: true, uso: use(0) },
      { slot: 3, apelido: 'Conta 3', dir: '/c/3', logada: false, ativa: false, uso: use(0) },
    ],
  };

  it('lista os slots e, por último, a conta padrão do CLI', () => {
    const choices = claudeAccountChoices(state, [
      agent('a', 'executando', { contaClaude: { slot: 2, apelido: 'Trabalho' } }),
      agent('b', 'ocioso', { contaClaude: { slot: 2, apelido: 'Trabalho' } }),
      agent('c', 'parado', { contaClaude: { slot: 1, apelido: 'Pessoal' } }),
    ]);
    expect(choices.map((c) => c.slot)).toEqual([1, 2, 3, null]);
    expect(choices.find((c) => c.ativa)?.slot).toBe(2);
    expect(choices[0]).toMatchObject({
      email: 'a@x.com',
      plano: 'Max',
      tokensHoje: 500,
      agentes: 0,
    });
    // Só os agentes vivos contam; o encerrado na conta 1 não.
    expect(choices[1]?.agentes).toBe(2);
    // Sem saber do login, vale como logada; só o "não" do CLI bloqueia.
    expect(choices[1]?.logada).toBe(true);
    expect(choices[2]?.logada).toBe(false);
    expect(choices[3]).toMatchObject({ slot: null, ativa: false, logada: true, semStatus: true });
  });

  it('conta na padrão os agentes Claude sem slot', () => {
    const choices = claudeAccountChoices(
      state,
      [
        agent('a', 'ocioso'),
        agent('b', 'executando', { profileId: 'codex' }),
        agent('c', 'ocioso', { contaClaude: { slot: 1, apelido: 'Pessoal' } }),
      ],
      (a) => a.profileId === 'claude',
    );
    expect(choices.map((c) => c.agentes)).toEqual([1, 0, 0, 1]);
  });

  it('sem slot ativo, a conta padrão é a ativa', () => {
    const choices = claudeAccountChoices(
      { contas: state.contas.map((c) => ({ ...c, ativa: false })) },
      [],
    );
    expect(choices.filter((c) => c.ativa).map((c) => c.slot)).toEqual([null]);
  });

  it('sem contas (ou sem permissão para vê-las), nada', () => {
    expect(claudeAccountChoices(undefined, [])).toEqual([]);
    expect(claudeAccountChoices({ contas: [] }, [])).toEqual([]);
  });
});
