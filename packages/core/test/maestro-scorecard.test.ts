import type { AgentProfile } from '@fakl/agents';
import type { Run } from '@fakl/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  chatMaestroPrompt,
  EventBus,
  MAESTRO_TOOLS,
  maestroPrompt,
  Orchestrator,
  profileGuide,
  Router,
  Scorecard,
  type AgentRuntime,
  type CostTracker,
} from '../src/index.js';

const PROFILES: AgentProfile[] = [
  { id: 'claude', nome: 'Claude', provedor: 'anthropic', adaptador: 'acp' },
  { id: 'codex', nome: 'Codex', provedor: 'openai', adaptador: 'acp' },
];

const SESSIONS: Record<string, { id: string; nome: string }> = {
  s1: { id: 'claude', nome: 'Claude' },
};

function finished(profileId: string): Run {
  const now = new Date().toISOString();
  return {
    id: 'r',
    taskId: 't',
    status: 'concluída',
    inicio: now,
    fim: now,
    branch: 'b',
    agentes: [{ sessionId: 'x', profileId, papel: 'executor', profundidade: 0 }],
    rodadas: [],
    decisoes: [],
  };
}

describe('list_profiles com o placar', () => {
  const disposables: { dispose(): void }[] = [];

  afterEach(() => {
    for (const item of disposables.splice(0)) item.dispose();
  });

  /** Um maestro `m1` numa execução ativa, sem agentes de verdade. */
  function setup(withScorecard: boolean) {
    const bus = new EventBus();
    const scorecard = new Scorecard({
      bus,
      sessionProfile: (id) => {
        const s = SESSIONS[id];
        return s ? { profile: s } : undefined;
      },
    });
    const orchestrator = new Orchestrator({
      bus,
      agents: { detect: () => Promise.resolve([]) } as unknown as AgentRuntime,
      costs: { blockedReason: () => undefined } as unknown as CostTracker,
      profiles: () => PROFILES,
      ...(withScorecard ? { scorecard } : {}),
    });
    disposables.push(scorecard, orchestrator);
    (orchestrator as unknown as { bySession: Map<string, unknown> }).bySession.set('m1', {
      run: {
        status: 'executando',
        maestroSessionId: 'm1',
        agentes: [{ sessionId: 'm1', profileId: 'claude', papel: 'maestro', profundidade: 0 }],
      },
      task: { origem: 'manual' },
      nudges: 0,
    });
    const router = new Router();
    orchestrator.register(router);
    const list = async (): Promise<Record<string, unknown>[]> =>
      (await router.dispatch(
        'maestro.listProfiles',
        {},
        {
          connectionId: 'c',
          principal: 'm1',
          notify: () => undefined,
          onClose: () => undefined,
        },
      )) as Record<string, unknown>[];
    return { bus, list };
  }

  it('diz "poucos dados" para quem tem menos de 5 tarefas, inclusive quem nunca trabalhou', async () => {
    const { bus, list } = setup(true);
    for (let i = 0; i < 4; i++) bus.publish('run.done', 'r', finished('claude'));
    const profiles = await list();
    expect(profiles.find((p) => p.id === 'claude')?.placar).toEqual({
      periodo: '30d',
      amostra: 'poucos dados',
      tarefas: 4,
    });
    expect(profiles.find((p) => p.id === 'codex')?.placar).toEqual({
      periodo: '30d',
      amostra: 'poucos dados',
      tarefas: 0,
    });
  });

  it('com 5 tarefas ou mais traz aprovação, duração e custo médios', async () => {
    const { bus, list } = setup(true);
    bus.publish('agent.review', 's1', { aceitos: 9, rejeitados: 1 });
    for (let i = 0; i < 5; i++) bus.publish('run.done', 'r', finished('claude'));
    const claude = (await list()).find((p) => p.id === 'claude');
    expect(claude?.placar).toMatchObject({
      periodo: '30d',
      amostra: 'suficiente',
      tarefas: 5,
      taxaAprovacao: 0.9,
      duracaoMediaMin: 0,
    });
    // O que já existia na lista continua lá.
    expect(claude).toMatchObject({ id: 'claude', nome: 'Claude', instalado: true });
  });

  it('sem placar configurado, a lista fica como era', async () => {
    const { list } = setup(false);
    for (const profile of await list()) expect(profile).not.toHaveProperty('placar');
  });

  it('a ferramenta e os prompts do maestro dizem que o placar é um sinal, não uma regra', () => {
    const tool = MAESTRO_TOOLS.find((t) => t.name === 'list_profiles');
    expect(tool?.description).toContain('placar');
    expect(tool?.description).toContain('signal, not a rule');
    expect(profileGuide(PROFILES)).toContain('um sinal, não uma regra');
    expect(profileGuide(PROFILES)).toContain('poucos dados');
    expect(chatMaestroPrompt(undefined, PROFILES)).toContain('um sinal, não uma regra');
    expect(
      maestroPrompt({
        task: {
          id: 't',
          titulo: 'x',
          repoPath: '/r',
          status: 'nova',
          criadaEm: '2026-10-18T00:00:00Z',
          runs: [],
        },
        limits: {},
        branch: 'b',
        base: 'main',
        profiles: PROFILES,
      }),
    ).toContain('um sinal, não uma regra');
  });
});
