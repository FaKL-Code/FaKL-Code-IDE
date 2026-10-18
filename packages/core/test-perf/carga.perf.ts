import { mkdtemp, rm } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpAdapter } from '@fakl/agents';
import {
  type AgentStartResult,
  type EventNotificationParams,
  type FaklEvent,
} from '@fakl/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreClient, createCore, createSessionToken, type Core } from '../src/index.js';
import { testSocket, waitFor } from '../test/helpers.js';
import { mb, percentil, registrar } from './medidas.js';

const fakeAgent = fileURLToPath(
  new URL('../../agents/test/fixtures/fake-agent.mjs', import.meta.url),
);

const AGENTES = 10; // o SDD pede pelo menos 8 (RNF-04)
const RODADAS = 5;
const MENSAGENS_POR_RODADA = 20;

// Limites com folga para runner compartilhado; os números reais vão para o log.
const LIMITE_LATENCIA_P95_MS = 500;
const LIMITE_ATRASO_LOOP_P99_MS = 250;
const LIMITE_CRESCIMENTO_RSS_MB = 150;

describe('RNF-04: 10 agentes simulados em paralelo', () => {
  let socket: Awaited<ReturnType<typeof testSocket>>;
  let core: Core;
  let client: CoreClient;
  let cwd: string;
  const eventos: { evento: FaklEvent; recebidoEm: number }[] = [];

  beforeAll(async () => {
    socket = await testSocket();
    cwd = await mkdtemp(join(tmpdir(), 'fakl-perf-carga-'));
    const token = createSessionToken();
    core = createCore({
      socketPath: socket.path,
      token,
      agents: {
        home: join(cwd, 'home'),
        profiles: [{ id: 'falso', nome: 'Falso', provedor: 'teste', adaptador: 'acp' }],
        adapterFor: () => new AcpAdapter({ command: process.execPath, args: [fakeAgent] }),
      },
    });
    await core.start();
    client = await CoreClient.connect(socket.path, token, 'test');
    client.onNotification((_method, params) => {
      eventos.push({ evento: (params as EventNotificationParams).event, recebidoEm: Date.now() });
    });
    await client.request('events.subscribe', { topics: ['agent.*'] });
  });

  afterAll(async () => {
    client.close();
    await core.stop();
    await socket.cleanup();
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  });

  it('entrega todos os eventos, sem atraso grande e sem crescer a memória', async () => {
    const sessoes: string[] = [];
    const iniciados = await Promise.all(
      Array.from({ length: AGENTES }, () =>
        client.request<AgentStartResult>('agents.start', { profileId: 'falso', cwd }),
      ),
    );
    for (const { sessionId } of iniciados) sessoes.push(sessionId);
    expect(new Set(sessoes).size).toBe(AGENTES);

    const atrasoLoop = monitorEventLoopDelay({ resolution: 10 });
    atrasoLoop.enable();
    const rssPorRodada: number[] = [];
    const inicio = Date.now();
    let enviadas = 0;

    for (let rodada = 0; rodada < RODADAS; rodada += 1) {
      // Todos os agentes recebem as mensagens da rodada ao mesmo tempo; cada
      // mensagem gera um agent.output e as trocas de estado.
      await Promise.all(
        sessoes.map(async (sessionId) => {
          for (let n = 0; n < MENSAGENS_POR_RODADA; n += 1) {
            await client.request('agents.send', { sessionId, message: `olá ${rodada}-${n}` });
            enviadas += 1;
          }
        }),
      );
      // Cada agente volta a ocioso depois de responder a última mensagem.
      const esperadas = enviadas;
      await waitFor(
        () => eventos.filter((e) => e.evento.topic === 'agent.output').length >= esperadas,
        60_000,
      );
      rssPorRodada.push(process.memoryUsage().rss);
    }
    const duracaoMs = Date.now() - inicio;
    atrasoLoop.disable();

    // Entrega: cada mensagem enviada produziu uma resposta, de todos os agentes.
    const saidas = eventos.filter((e) => e.evento.topic === 'agent.output');
    expect(saidas.length).toBeGreaterThanOrEqual(enviadas);
    for (const sessionId of sessoes) {
      const doAgente = saidas.filter((e) => e.evento.subject === sessionId).length;
      expect(doAgente).toBeGreaterThanOrEqual(RODADAS * MENSAGENS_POR_RODADA);
    }

    // Latência: do instante gravado pelo Core no evento até a chegada ao cliente
    // (mesmo relógio: o Core roda neste processo). Inclui fila, serialização e socket.
    const latencias = eventos.map((e) => e.recebidoEm - Date.parse(e.evento.ts));
    const p50 = percentil(latencias, 50);
    const p95 = percentil(latencias, 95);
    const max = Math.max(...latencias);
    const loopP99 = atrasoLoop.percentile(99) / 1e6;
    const loopMax = atrasoLoop.max / 1e6;
    // Crescimento: da primeira rodada (já aquecida) até a última.
    const crescimento = mb((rssPorRodada.at(-1) ?? 0) - (rssPorRodada[0] ?? 0));

    registrar({
      teste: 'RNF-04 10 agentes',
      agentes: AGENTES,
      mensagens: enviadas,
      eventos: eventos.length,
      duracao_s: Math.round(duracaoMs / 100) / 10,
      latencia_p50_ms: Math.round(p50),
      latencia_p95_ms: Math.round(p95),
      latencia_max_ms: Math.round(max),
      atraso_loop_p99_ms: Math.round(loopP99 * 10) / 10,
      atraso_loop_max_ms: Math.round(loopMax * 10) / 10,
      rss_primeira_rodada_mb: mb(rssPorRodada[0] ?? 0),
      rss_ultima_rodada_mb: mb(rssPorRodada.at(-1) ?? 0),
      crescimento_rss_mb: crescimento,
      limite_latencia_p95_ms: LIMITE_LATENCIA_P95_MS,
      limite_atraso_loop_p99_ms: LIMITE_ATRASO_LOOP_P99_MS,
      limite_crescimento_rss_mb: LIMITE_CRESCIMENTO_RSS_MB,
    });

    expect(p95).toBeLessThan(LIMITE_LATENCIA_P95_MS);
    expect(loopP99).toBeLessThan(LIMITE_ATRASO_LOOP_P99_MS);
    expect(crescimento).toBeLessThan(LIMITE_CRESCIMENTO_RSS_MB);

    await Promise.all(sessoes.map((sessionId) => client.request('agents.stop', { sessionId })));
  });
});
