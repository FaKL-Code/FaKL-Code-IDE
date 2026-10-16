import type { AgentLimitInfo, AgentPermissionRequest, AgentSessionInfo } from '@fakl/protocol';
import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canSend,
  describeWindow,
  EMPTY_SNAPSHOT,
  LimitTracker,
  offersAlways,
  recentFolders,
  untilReset,
  waitingFor,
  windowRows,
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

describe('limites que o Core guardou', () => {
  it('sync traz o aviso de antes da abertura, só de agentes vivos e sem sobrescrever', () => {
    const tracker = new LimitTracker();
    const limite = (motivo: string): AgentLimitInfo => ({ motivo, em: '' });
    expect(
      tracker.sync([
        agent('a', 'ocioso', { limite: limite('sessão de 5 h acabou') }),
        agent('b', 'concluído', { limite: limite('semanal') }),
        agent('c', 'ocioso'),
      ]),
    ).toBe(true);
    expect([...tracker.ids()]).toEqual(['a']);
    expect(tracker.reason('a')).toBe('sessão de 5 h acabou');
    // Sem mudança: nada a avisar, e o motivo já conhecido fica.
    expect(tracker.sync([agent('a', 'ocioso', { limite: limite('outro') })])).toBe(false);
    expect(tracker.reason('a')).toBe('sessão de 5 h acabou');
  });

  it('o card de trocar de conta sai do limite recuperado', () => {
    const tracker = new LimitTracker();
    const agents = [agent('a', 'aguardando-você', { limite: { motivo: 'weekly limit', em: '' } })];
    tracker.sync(agents);
    const snapshot: Snapshot = { ...EMPTY_SNAPSHOT, agents, limited: tracker.ids() };
    expect(waitingFor(snapshot).map((item) => item.kind)).toEqual(['limite']);
  });
});

describe('pastas recentes de agentes em worktree', () => {
  it('usa a pasta do projeto, não o worktree que o Core devolve em cwd', () => {
    const worktree = 'C:\\Users\\dev\\.fakl\\worktrees\\loja\\t1';
    expect(
      recentFolders([
        agent('a', 'ocioso', { cwd: worktree, pastaOrigem: 'C:/dev/loja' }),
        agent('b', 'ocioso', { cwd: 'C:/dev/loja' }),
        agent('c', 'ocioso', { cwd: 'C:/dev/api' }),
      ]),
    ).toEqual(['C:/dev/loja', 'C:/dev/api']);
  });

  it('um Core antigo, sem a pasta de origem, continua sem sugerir o worktree', () => {
    expect(
      recentFolders([agent('a', 'ocioso', { cwd: 'C:/Users/dev/.fakl/worktrees/loja/t1' })]),
    ).toEqual([]);
  });
});

describe('compositor de conversa encerrada', () => {
  it('escreve se vivo ou retomável; não se encerrado de vez ou fora da lista', () => {
    expect(canSend(agent('a', 'ocioso'))).toBe(true);
    expect(canSend(agent('a', 'concluído', { retomavel: true }))).toBe(true);
    expect(canSend(agent('a', 'parado', { retomavel: true }))).toBe(true);
    expect(canSend(agent('a', 'concluído'))).toBe(false);
    expect(canSend(undefined)).toBe(false);
  });
});

describe('permitir sempre', () => {
  const base: AgentPermissionRequest = { sessionId: 's', id: 'p', title: 'Editar', options: [] };

  it('só quando o agente oferece allow_always', () => {
    expect(offersAlways(base)).toBe(false);
    expect(
      offersAlways({
        ...base,
        options: [
          { id: 'o', name: 'Permitir', kind: 'allow_once' },
          { id: 'a', name: 'Sempre', kind: 'allow_always' },
        ],
      }),
    ).toBe(true);
    expect(
      offersAlways({ ...base, options: [{ id: 'o', name: 'Permitir', kind: 'allow_once' }] }),
    ).toBe(false);
  });
});

describe('janelas dos planos', () => {
  const now = Date.parse('2026-10-15T15:00:00.000Z');

  afterEach(() => useLocale('en'));

  it('o tempo até renovar', () => {
    expect(untilReset(undefined, now)).toBe('');
    expect(untilReset(now - 1, now)).toBe('now');
    expect(untilReset(now + 40 * 60_000, now)).toBe('40min');
    expect(untilReset(now + 135 * 60_000, now)).toBe('2h 15min');
    expect(untilReset(now + (3 * 24 + 5) * 3_600_000, now)).toBe('3d 5h');
  });

  it('percentual quando há, senão tokens, senão traço', () => {
    expect(describeWindow({ fracao: 0.424 })).toBe('42%');
    expect(describeWindow({ tokens: 380_000 })).toMatch(/tok$/);
    expect(describeWindow({})).toBe('—');
    expect(describeWindow(undefined)).toBe('—');
  });

  it('uma linha por provedor ou conta, com a sessão de 5h e a semana', () => {
    const rows = windowRows(
      [
        {
          provedor: 'anthropic',
          nome: 'Pessoal',
          sessao: { tokens: 380_000, resetaEm: now + 135 * 60_000 },
          semana: { tokens: 4_000_000 },
          origem: 'estimado',
        },
        { provedor: 'openai', sessao: { fracao: 0.4, resetaEm: now + 3_600_000 }, origem: 'real' },
      ],
      now,
    );
    expect(rows.map((row) => row.nome)).toEqual(['Pessoal', 'Codex']);
    expect(rows[0]?.linhas.map((l) => [l.rotulo, l.zera])).toEqual([
      ['5h session', '2h 15min'],
      ['Week', ''],
    ]);
    expect(rows[1]).toMatchObject({
      origem: 'real',
      linhas: [{ rotulo: '5h session', valor: '40%', zera: '1h 0min', fracao: 0.4 }],
    });
  });

  it('em pt-BR, os rótulos em português', () => {
    useLocale('pt-br');
    expect(untilReset(now - 1, now)).toBe('agora');
    const rows = windowRows(
      [
        {
          provedor: 'anthropic',
          sessao: { fracao: 0.1 },
          dia: { fracao: 0.2 },
          semana: { fracao: 0.3 },
          origem: 'real',
        },
        { provedor: 'openai', origem: 'estimado', semDados: true },
      ],
      now,
    );
    expect(rows[0]?.linhas.map((l) => l.rotulo)).toEqual(['Sessão 5h', 'Hoje', 'Semana']);
    expect(rows[1]?.linhas).toEqual([{ rotulo: 'Uso', valor: 'sem dados', zera: '' }]);
  });
});
