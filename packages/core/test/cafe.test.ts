import type { AgentThumbnailEventData, CiStatus, FaklEvent } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import {
  CafeService,
  EventBus,
  Router,
  type AgentRuntime,
  type CallContext,
  type CostTracker,
  type Orchestrator,
} from '../src/index.js';

const NOW = new Date(2026, 9, 12, 15, 0, 0);

function setup(ci?: () => CiStatus | undefined) {
  const bus = new EventBus();
  const agents = {
    stateOf: (id: string) => (id === 's1' || id === 's2' ? 'trabalhando' : undefined),
    cwdOf: () => '/repo',
    list: () => [
      { sessionId: 's1', profileId: 'claude', nome: 'Claude', cwd: '/repo', state: 'trabalhando' },
    ],
    sessionProfile: () => ({
      profile: { id: 'claude', nome: 'Claude', adaptador: 'acp', provedor: 'anthropic' },
    }),
  } as unknown as AgentRuntime;
  const inicio = NOW.toISOString();
  const orchestrator = {
    agentInRun: (id: string) =>
      id === 's1' ? { sessionId: 's1', papel: 'maestro', runId: 'r1' } : undefined,
    runList: () => [
      {
        id: 'r1',
        status: 'concluída',
        inicio,
        fim: inicio,
        prUrl: 'https://x/pr/1',
        agentes: [1, 2],
      },
      { id: 'r0', status: 'falhou', inicio: '2026-01-01T00:00:00Z', agentes: [1], prUrl: 'p' },
    ],
  } as unknown as Orchestrator;
  const costs = { summary: () => ({ total: { custoUsd: 1.5 } }) } as unknown as CostTracker;
  const diffs: string[] = [];
  const cafe = new CafeService({
    bus,
    agents,
    orchestrator,
    costs,
    intervalMs: 60_000,
    clock: () => NOW,
    ...(ci ? { ci } : {}),
    diffLines: (_cwd, path) => {
      diffs.push(path);
      return Promise.resolve(['+ nova linha', '- velha']);
    },
  });
  const thumbs: FaklEvent<AgentThumbnailEventData>[] = [];
  bus.subscribe(['agent.thumbnail'], (event) => {
    thumbs.push(event as FaklEvent<AgentThumbnailEventData>);
  });
  return { bus, cafe, thumbs, diffs };
}

function context(id: string): CallContext & { close(): void } {
  const cleanups: (() => void)[] = [];
  return {
    connectionId: id,
    notify: () => undefined,
    onClose: (cleanup) => cleanups.push(cleanup),
    close: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

describe('CafeService', () => {
  it('monta miniaturas a partir dos eventos dos agentes', async () => {
    const { bus, cafe, thumbs, diffs } = setup();
    bus.publish('agent.output', 's1', { kind: 'thought', text: 'Vou ler o código. Depois testo.' });
    await cafe.tick();
    expect(thumbs.at(-1)?.data).toMatchObject({
      tipo: 'pensando',
      linhas: ['Vou ler o código.', 'Depois testo.'],
    });

    bus.publish('agent.file', 's1', { path: 'src/a.ts' });
    await cafe.tick();
    expect(diffs).toEqual(['src/a.ts']);
    expect(thumbs.at(-1)?.data).toEqual({
      tipo: 'arquivo',
      titulo: 'src/a.ts',
      linhas: ['+ nova linha', '- velha'],
    });

    const count = thumbs.length;
    await cafe.tick();
    expect(thumbs).toHaveLength(count);

    bus.publish('agent.tool', 's2', {
      toolCallId: 't',
      kind: 'execute',
      title: 'pnpm vitest',
      status: 'failed',
    });
    await cafe.tick();
    expect(thumbs.at(-1)).toMatchObject({
      subject: 's2',
      data: { tipo: 'testes', resultado: 'falhou' },
    });

    bus.publish('agent.output', 'sumiu', { kind: 'message', text: 'oi' });
    await cafe.tick();
    expect(thumbs.some((t) => t.subject === 'sumiu')).toBe(false);
    cafe.dispose();
  });

  it('abre e fecha a sala e devolve o placar do dia', async () => {
    const { bus, cafe } = setup();
    const router = new Router();
    cafe.register(router);
    bus.publish('run.limit', 'r1', {});
    const viewer = context('c1');
    const state = (await router.dispatch('cafe.open', {}, viewer)) as ReturnType<
      CafeService['state']
    >;
    expect(cafe.open).toBe(true);
    expect(state.agentes[0]).toMatchObject({
      provedor: 'anthropic',
      papel: 'maestro',
      runId: 'r1',
    });
    expect(state.placar).toMatchObject({
      tarefas: 1,
      prs: 1,
      custoUsd: 1.5,
      maxAgentes: 2,
      prsTotal: 2,
    });
    expect(state.limites).toEqual(['r1']);
    viewer.close();
    expect(cafe.open).toBe(false);
    await router.dispatch('cafe.open', {}, context('c2'));
    await router.dispatch('cafe.close', {}, context('c2'));
    expect(cafe.open).toBe(false);
    cafe.dispose();
  });

  it('leva a cozinha do CI no retrato só quando há repositório acompanhado', () => {
    const status: CiStatus = {
      conectado: true,
      automatico: true,
      repos: [{ repo: 'acme/app', origem: 'aberto', runs: [] }],
      descartados: [],
      falhando: 1,
      trabalhando: 0,
      verdesSeguidos: 3,
    };
    const holder: { current?: CiStatus } = {};
    const { cafe } = setup(() => holder.current);
    expect(cafe.state().ci).toBeUndefined();
    holder.current = status;
    expect(cafe.state().ci).toEqual(status);
    cafe.dispose();
    // Sem o serviço ligado o campo nem existe.
    const plain = setup();
    expect('ci' in plain.cafe.state()).toBe(false);
    plain.cafe.dispose();
  });
});
