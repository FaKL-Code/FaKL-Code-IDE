import type {
  AgentPermissionRequest,
  AgentSessionInfo,
  ChatItem,
  Decision,
  FaklEvent,
} from '@fakl/protocol';
import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import {
  balloon,
  blockedByCap,
  compactTranscript,
  Drafts,
  EMPTY_SNAPSHOT,
  isLimitText,
  LimitTracker,
  newFailures,
  nextAccount,
  panelGroups,
  petStatus,
  recentFolders,
  stepsLabel,
  waitingFor,
  type ClaudeAccountChoice,
  type Snapshot,
} from '../src/model.js';

const agent = (
  sessionId: string,
  state: AgentSessionInfo['state'],
  extra: Partial<AgentSessionInfo> = {},
): AgentSessionInfo => ({
  sessionId,
  profileId: 'claude',
  nome: `Agente ${sessionId}`,
  cwd: '/repo',
  state,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  permissoes: 'perguntar',
  opcoes: [],
  ...extra,
});

const permission = (sessionId: string, id = 'p1'): AgentPermissionRequest => ({
  sessionId,
  id,
  title: 'Executar `ls`',
  options: [],
});

const decision = (id: string, extra: Partial<Decision> = {}): Decision => ({
  id,
  runId: 'r1',
  pergunta: 'Seguir?',
  opcoes: [
    { id: 'sim', rotulo: 'Sim' },
    { id: 'nao', rotulo: 'Não' },
  ],
  criadaEm: '2026-10-15T10:00:00.000Z',
  ...extra,
});

const snap = (extra: Partial<Snapshot>): Snapshot => ({ ...EMPTY_SNAPSHOT, ...extra });

let seq = 0;
const event = (topic: FaklEvent['topic'], data: unknown, subject = 's1'): FaklEvent => ({
  id: `01${String(++seq).padStart(24, '0')}`,
  ts: new Date().toISOString(),
  topic,
  subject,
  data,
});

describe('pet', () => {
  it('fica quieto sem ninguém trabalhando', () => {
    const status = petStatus(snap({ agents: [agent('s1', 'ocioso')] }));
    expect(status).toMatchObject({ ring: 'quieto', count: 0 });
    expect(status.label).toBe('No agents working');
  });

  it('conta quem trabalha', () => {
    const status = petStatus(
      snap({ agents: [agent('s1', 'executando'), agent('s2', 'pensando'), agent('s3', 'ocioso')] }),
    );
    expect(status).toMatchObject({ ring: 'trabalhando', count: 2 });
  });

  it('esperar você vence trabalhar, e o selo conta os pedidos', () => {
    const status = petStatus(
      snap({
        agents: [agent('s1', 'executando'), agent('s2', 'aguardando-permissão')],
        permissions: [permission('s2')],
        decisions: [decision('d1')],
      }),
    );
    expect(status).toMatchObject({ ring: 'espera', count: 2 });
    expect(status.label).toBe('2 requests waiting for you, 1 agent working');
  });

  describe('em pt-BR', () => {
    afterEach(() => useLocale('en'));

    it('diz o estado em português', () => {
      useLocale('pt-br');
      expect(petStatus(snap({ agents: [agent('s1', 'ocioso')] })).label).toBe(
        'Nenhum agente trabalhando',
      );
      const status = petStatus(
        snap({
          agents: [agent('s1', 'executando'), agent('s2', 'aguardando-permissão')],
          permissions: [permission('s2')],
          decisions: [decision('d1')],
        }),
      );
      expect(status.label).toBe('2 pedidos esperam você, 1 agente trabalhando');
    });
  });

  it('falha ou limite deixam o anel vermelho', () => {
    expect(
      petStatus(snap({ agents: [agent('s1', 'pausado')], limited: new Set(['s1']) })).ring,
    ).toBe('falha');
    expect(petStatus(snap({ agents: [agent('s1', 'falhou')], failed: new Set(['s1']) }))).toEqual(
      expect.objectContaining({ ring: 'falha', count: 1 }),
    );
  });
});

describe('esperando você', () => {
  it('ordena permissões, decisões, limites e respostas', () => {
    const items = waitingFor(
      snap({
        agents: [
          agent('s1', 'aguardando-permissão'),
          agent('s2', 'pausado'),
          agent('s3', 'aguardando-você'),
          agent('s4', 'concluído'),
        ],
        permissions: [permission('s1')],
        decisions: [decision('d2', { criadaEm: '2026-10-15T11:00:00.000Z' }), decision('d1')],
        limited: new Set(['s2', 's4']),
      }),
      [
        {
          id: 't1',
          titulo: 'Tarefa',
          repoPath: '/r',
          status: 'executando',
          criadaEm: '',
          runs: ['r1'],
        },
      ],
    );
    expect(items.map((item) => item.kind)).toEqual([
      'permissao',
      'decisao',
      'decisao',
      'limite',
      'resposta',
    ]);
    const first = items[1];
    expect(first?.kind === 'decisao' && first.decision.id).toBe('d1');
    expect(first?.kind === 'decisao' && first.task?.titulo).toBe('Tarefa');
  });

  it('não repete como resposta quem já pediu permissão nem mostra decisão respondida', () => {
    const items = waitingFor(
      snap({
        agents: [agent('s1', 'aguardando-você')],
        permissions: [permission('s1')],
        decisions: [decision('d1', { escolha: 'sim' })],
      }),
    );
    expect(items.map((item) => item.kind)).toEqual(['permissao']);
  });
});

describe('limites', () => {
  it('reconhece os avisos de limite dos provedores', () => {
    expect(isLimitText('Claude AI usage limit reached|1760536800')).toBe(true);
    expect(isLimitText('Rate limit exceeded, try again later')).toBe(true);
    expect(isLimitText('Você atingiu o limite da sessão')).toBe(true);
    expect(isLimitText('ENOENT: no such file')).toBe(false);
  });

  it('marca pelo erro e pelo teto diário e solta quando volta a trabalhar', () => {
    const tracker = new LimitTracker();
    expect(
      tracker.apply(event('agent.output', { kind: 'error', text: 'usage limit reached' }, 's1')),
    ).toBe(true);
    expect(tracker.apply(event('agent.output', { kind: 'message', text: 'limit' }, 's2'))).toBe(
      false,
    );
    tracker.apply(
      event(
        'run.limit',
        { tipo: 'teto-diario', provedor: 'openai', pausadas: ['s3'], limite: 'tokens' },
        'openai',
      ),
    );
    expect([...tracker.ids()].sort()).toEqual(['s1', 's3']);
    expect(tracker.reason('s3')).toBe('Daily cap reached for openai');

    tracker.apply(event('agent.state', { state: 'executando', previous: 'pausado' }, 's1'));
    expect([...tracker.ids()]).toEqual(['s3']);

    tracker.prune([agent('s3', 'parado')]);
    expect(tracker.ids().size).toBe(0);
  });

  it('pausado de provedor bloqueado conta como limite', () => {
    const profiles = [
      {
        arquivo: 'c.yaml',
        profile: { id: 'claude', nome: 'C', provedor: 'anthropic', adaptador: 'acp' as const },
      },
    ];
    expect(blockedByCap(agent('s1', 'pausado'), ['anthropic'], profiles)).toBe(true);
    expect(blockedByCap(agent('s1', 'executando'), ['anthropic'], profiles)).toBe(false);
    expect(blockedByCap(agent('s1', 'pausado'), ['openai'], profiles)).toBe(false);
  });
});

describe('grupos do painel', () => {
  it('separa trabalhando, ociosos e encerrados, do mais recente ao mais antigo', () => {
    const groups = panelGroups([
      agent('a', 'executando', { atividadeEm: '2026-10-15T10:00:00Z' }),
      agent('b', 'pensando', { atividadeEm: '2026-10-15T11:00:00Z' }),
      agent('c', 'ocioso'),
      agent('d', 'aguardando-permissão'),
      agent('e', 'parado', { encerradaEm: '2026-10-15T09:00:00Z' }),
      agent('f', 'falhou', { encerradaEm: '2026-10-15T12:00:00Z' }),
    ]);
    expect(groups.trabalhando.map((a) => a.sessionId)).toEqual(['b', 'a']);
    expect(groups.ociosos.map((a) => a.sessionId).sort()).toEqual(['c', 'd']);
    expect(groups.encerrados.map((a) => a.sessionId)).toEqual(['f', 'e']);
  });
});

describe('balão', () => {
  it('conta a mudança mais urgente', () => {
    const before = snap({ agents: [agent('s1', 'executando'), agent('s2', 'executando')] });
    expect(
      balloon(
        before,
        snap({
          agents: [agent('s1', 'ocioso'), agent('s2', 'aguardando-permissão')],
          permissions: [permission('s2')],
        }),
      ),
    ).toBe('Agente s2 is asking for permission');
    expect(balloon(before, snap({ agents: before.agents, decisions: [decision('d1')] }))).toBe(
      'The maestro is asking for a decision',
    );
    expect(balloon(before, snap({ agents: before.agents, limited: new Set(['s1']) }))).toBe(
      'Agente s1 hit the limit',
    );
    expect(
      balloon(before, snap({ agents: [agent('s1', 'falhou'), agent('s2', 'executando')] })),
    ).toBe('Agente s1 has failed');
    expect(
      balloon(before, snap({ agents: [agent('s1', 'concluído'), agent('s2', 'executando')] })),
    ).toBe('Agente s1 finished');
  });

  describe('em pt-BR', () => {
    afterEach(() => useLocale('en'));

    it('conta a mudança em português', () => {
      useLocale('pt-br');
      const before = snap({ agents: [agent('s1', 'executando'), agent('s2', 'executando')] });
      expect(
        balloon(
          before,
          snap({
            agents: [agent('s1', 'ocioso'), agent('s2', 'aguardando-permissão')],
            permissions: [permission('s2')],
          }),
        ),
      ).toBe('Agente s2 pede permissão');
      expect(balloon(before, snap({ agents: before.agents, decisions: [decision('d1')] }))).toBe(
        'O maestro pede uma decisão',
      );
      expect(
        balloon(before, snap({ agents: [agent('s1', 'falhou'), agent('s2', 'executando')] })),
      ).toBe('Agente s1 falhou');
      expect(
        balloon(before, snap({ agents: [agent('s1', 'concluído'), agent('s2', 'executando')] })),
      ).toBe('Agente s1 terminou');
    });
  });

  it('fica quieto quando nada importante mudou', () => {
    const same = snap({ agents: [agent('s1', 'executando')], permissions: [permission('s1')] });
    expect(balloon(same, same)).toBeUndefined();
    expect(
      balloon(
        snap({ agents: [agent('s1', 'ocioso')] }),
        snap({ agents: [agent('s1', 'executando')] }),
      ),
    ).toBeUndefined();
  });

  it('acha quem passou a falhar', () => {
    expect(
      newFailures(
        snap({ agents: [agent('s1', 'executando'), agent('s2', 'falhou')] }),
        snap({ agents: [agent('s1', 'falhou'), agent('s2', 'falhou'), agent('s3', 'falhou')] }),
      ),
    ).toEqual(['s1']);
  });
});

describe('nova conversa e contas', () => {
  it('lista as pastas recentes sem os worktrees da IDE nem repetidas', () => {
    expect(
      recentFolders([
        agent('a', 'ocioso', { cwd: 'C:/dev/loja', atividadeEm: '2026-10-15T09:00:00Z' }),
        agent('b', 'ocioso', { cwd: 'C:\\dev\\api', atividadeEm: '2026-10-15T11:00:00Z' }),
        agent('c', 'ocioso', {
          cwd: 'C:/Users/x/.fakl/worktrees/loja/s1',
          atividadeEm: '2026-10-15T12:00:00Z',
        }),
        agent('d', 'ocioso', { cwd: 'c:/dev/LOJA', atividadeEm: '2026-10-15T08:00:00Z' }),
      ]),
    ).toEqual(['C:\\dev\\api', 'C:/dev/loja']);
  });

  it('escolhe a conta livre com menos uso para trocar', () => {
    const choice = (
      slot: ClaudeAccountChoice['slot'],
      extra: Partial<ClaudeAccountChoice> = {},
    ): ClaudeAccountChoice => ({
      slot,
      nome: `Conta ${String(slot)}`,
      logada: true,
      ativa: false,
      tokensHoje: 0,
      agentes: 0,
      ...extra,
    });
    expect(
      nextAccount([
        choice(1, { ativa: true }),
        choice(2, { tokensHoje: 500 }),
        choice(3, { tokensHoje: 10 }),
        choice(null),
      ])?.slot,
    ).toBe(3);
    expect(nextAccount([choice(1, { ativa: true }), choice(2, { logada: false })])).toBeUndefined();
    expect(nextAccount([choice(1, { ativa: true }), choice(null)])?.slot).toBeNull();
  });
});

describe('conversa compacta', () => {
  const items: ChatItem[] = [
    { kind: 'user', text: 'oi' },
    { kind: 'thought', text: 'pensando' },
    { kind: 'tool', id: 't1', title: 'Ler a.ts', status: 'completed' },
    { kind: 'tool', id: 't2', title: 'Ler b.ts', status: 'in_progress' },
    { kind: 'agent', text: 'pronto' },
    { kind: 'user', text: 'valeu' },
  ];

  it('recolhe ferramentas e pensamentos numa linha', () => {
    const compact = compactTranscript(items);
    expect(compact.map((step) => step.kind)).toEqual(['fala', 'passos', 'fala', 'fala']);
    const steps = compact[1];
    expect(steps).toMatchObject({ tools: 2, thoughts: 1, last: 'Ler b.ts', running: true });
    if (steps?.kind === 'passos') expect(stepsLabel(steps)).toBe('2 tools and 1 thought');
  });

  it('em pt-BR, a linha recolhida em português', () => {
    useLocale('pt-br');
    try {
      const steps = compactTranscript(items)[1];
      if (steps?.kind === 'passos') {
        expect(stepsLabel(steps)).toBe('2 ferramentas e 1 pensamento');
        expect(stepsLabel({ ...steps, thoughts: 0 })).toBe('2 ferramentas');
      }
    } finally {
      useLocale('en');
    }
  });

  it('guarda só as últimas falas', () => {
    const compact = compactTranscript(items, 2);
    expect(compact.map((step) => (step.kind === 'fala' ? step.index : 'passos'))).toEqual([4, 5]);
  });
});

describe('rascunhos', () => {
  it('guarda por conversa e esquece o vazio', () => {
    const drafts = new Drafts();
    drafts.set('s1', 'meio escrito');
    expect(drafts.get('s1')).toBe('meio escrito');
    expect(drafts.get('s2')).toBe('');
    drafts.set('s1', '');
    expect(drafts.get('s1')).toBe('');
  });
});
