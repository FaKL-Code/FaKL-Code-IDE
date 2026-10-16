import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DailyCap, DailyCapEventData, FaklEvent } from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigStore,
  CostTracker,
  EventBus,
  capExceeded,
  localDay,
  type AgentRuntime,
} from '../src/index.js';

function fakeRuntime(): AgentRuntime & { paused: string[] } {
  const paused: string[] = [];
  const profiles: Record<string, { provedor: string; modelo?: string }> = {
    s1: { provedor: 'anthropic', modelo: 'opus' },
    s2: { provedor: 'openai' },
  };
  return {
    paused,
    sessionProfile: (id: string) => {
      const p = profiles[id];
      return p
        ? {
            profile: { id, nome: id, adaptador: 'acp', ...p },
            ...(id === 's2' ? { taskId: 't1' } : {}),
          }
        : undefined;
    },
    pauseProvider: (provedor: string) => {
      const ids = Object.keys(profiles).filter((id) => profiles[id]?.provedor === provedor);
      paused.push(...ids);
      return ids;
    },
  } as unknown as AgentRuntime & { paused: string[] };
}

describe('capExceeded', () => {
  it('compara custo e tokens com o teto', () => {
    const totals = { tokensEntrada: 600, tokensSaida: 400, custoUsd: 1.5 };
    expect(capExceeded(totals, undefined)).toBeUndefined();
    expect(capExceeded(totals, { custoUsd: 2 })).toBeUndefined();
    expect(capExceeded(totals, { custoUsd: 1.5 })).toMatchObject({ limite: 'custoUsd' });
    expect(capExceeded(totals, { tokens: 1000 })).toEqual({
      limite: 'tokens',
      valor: 1000,
      gasto: 1000,
    });
  });
});

describe('CostTracker', () => {
  let dir: string;
  let bus: EventBus;
  let caps: Record<string, DailyCap>;
  const limits: FaklEvent[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-costs-'));
    bus = new EventBus();
    caps = {};
    limits.length = 0;
    bus.subscribe(['run.limit'], (event) => limits.push(event));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tracker = (runtime = fakeRuntime()) =>
    new CostTracker({
      bus,
      agents: runtime,
      dataDir: dir,
      caps: () => caps,
      setCaps: (next) => {
        caps = { ...next };
        return Promise.resolve();
      },
    });

  it('lança a diferença do uso acumulado e grava em costs.jsonl', async () => {
    const costs = tracker();
    bus.publish('cost.update', 's1', { inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    bus.publish('cost.update', 's1', {
      inputTokens: 300,
      outputTokens: 50,
      totalTokens: 350,
      cost: { amount: 0.25, currency: 'USD' },
    });
    // Repetido: nada novo.
    bus.publish('cost.update', 's1', {
      inputTokens: 300,
      outputTokens: 50,
      totalTokens: 350,
      cost: { amount: 0.25, currency: 'USD' },
    });
    bus.publish('cost.update', 's2', { inputTokens: 5, outputTokens: 5, totalTokens: 10 });
    bus.publish('cost.update', 'desconhecida', {
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
    });
    await costs.flush();

    const summary = costs.summary();
    expect(summary.dia).toBe(localDay(new Date()));
    expect(summary.porProvedor.anthropic).toEqual({
      tokensEntrada: 300,
      tokensSaida: 50,
      custoUsd: 0.25,
    });
    expect(summary.total.tokensEntrada).toBe(305);
    expect(costs.byTask()).toEqual({ t1: { tokensEntrada: 5, tokensSaida: 5, custoUsd: 0 } });

    const lines = (await readFile(join(dir, 'costs.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ provedor: 'anthropic', modelo: 'opus' });

    const reloaded = tracker();
    await reloaded.load();
    expect(reloaded.summary().total).toEqual(summary.total);
    costs.dispose();
    reloaded.dispose();
  });

  it('conta do zero quando o agente reabre com totais menores', async () => {
    const costs = tracker();
    const usage = (input: number, output: number, usd: number) => ({
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      cost: { amount: usd, currency: 'USD' },
    });
    bus.publish('cost.update', 's1', usage(300, 50, 0.25));
    // Troca de conta: o agente novo recomeça o acumulado.
    bus.publish('cost.update', 's1', usage(40, 4, 0.02));
    bus.publish('cost.update', 's1', usage(100, 10, 0.05));
    await costs.flush();
    expect(costs.summary().porProvedor.anthropic).toEqual({
      tokensEntrada: 400,
      tokensSaida: 60,
      custoUsd: 0.3,
    });
    costs.dispose();
  });

  it('pausa o provedor e recusa trabalho novo ao bater o teto', async () => {
    caps = { anthropic: { custoUsd: 1 } };
    const runtime = fakeRuntime();
    const costs = tracker(runtime);
    bus.publish('cost.update', 's1', {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cost: { amount: 0.5, currency: 'USD' },
    });
    expect(costs.blockedReason('anthropic')).toBeUndefined();
    bus.publish('cost.update', 's1', {
      inputTokens: 2,
      outputTokens: 2,
      totalTokens: 4,
      cost: { amount: 1.2, currency: 'usd' },
    });
    expect(runtime.paused).toEqual(['s1']);
    expect(limits).toHaveLength(1);
    expect(limits[0]?.data as DailyCapEventData).toMatchObject({
      tipo: 'teto-diario',
      provedor: 'anthropic',
      limite: 'custoUsd',
      pausadas: ['s1'],
    });
    expect(costs.blockedReason('anthropic')).toMatch(/teto diário de anthropic/);
    expect(costs.blockedReason('openai')).toBeUndefined();
    expect(costs.summary().bloqueados).toEqual(['anthropic']);

    // Mais gasto no mesmo dia não avisa de novo.
    bus.publish('cost.update', 's1', {
      inputTokens: 3,
      outputTokens: 3,
      totalTokens: 6,
      cost: { amount: 1.3, currency: 'USD' },
    });
    expect(limits).toHaveLength(1);
    costs.dispose();
    await costs.flush();
  });
});

describe('ConfigStore: tetos', () => {
  it('grava o teto no config.yaml sem perder os comentários', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fakl-caps-'));
    try {
      const store = new ConfigStore({ home });
      await store.load();
      await store.setDailyCaps({ anthropic: { custoUsd: 20 } });
      expect(store.config.tetoDiario).toEqual({ anthropic: { custoUsd: 20 } });
      const text = await readFile(store.configFile, 'utf8');
      expect(text).toMatch(/# Configuração do FaKL-Code/);
      expect(text).toMatch(/custoUsd: 20/);
      await store.setDailyCaps({});
      expect(store.config.tetoDiario).toEqual({});
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
