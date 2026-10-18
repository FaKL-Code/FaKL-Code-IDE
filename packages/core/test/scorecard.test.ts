import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCORECARD_MIN_TASKS, type Run, type RunAgent } from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EventBus,
  localDay,
  periodStart,
  Router,
  RpcError,
  sanitizeDocument,
  Scorecard,
  usageDelta,
  type CallContext,
} from '../src/index.js';

const context: CallContext = {
  connectionId: 'c',
  notify: () => undefined,
  onClose: () => undefined,
};

/** Sessões de mentira: s1 e s2 são do perfil `claude`, s3 do `codex`; s2 pertence a uma tarefa. */
const SESSIONS: Record<string, { id: string; nome: string; taskId?: string }> = {
  s1: { id: 'claude', nome: 'Claude' },
  s2: { id: 'claude', nome: 'Claude', taskId: 't1' },
  s3: { id: 'codex', nome: 'Codex', taskId: 't1' },
  s4: { id: 'claude', nome: 'Claude' },
};

function sessionProfile(sessionId: string) {
  const s = SESSIONS[sessionId];
  return s
    ? { profile: { id: s.id, nome: s.nome }, ...(s.taskId ? { taskId: s.taskId } : {}) }
    : undefined;
}

const agent = (profileId: string, papel = 'executor'): RunAgent => ({
  sessionId: `x-${profileId}`,
  profileId,
  papel,
  profundidade: 0,
});

function run(
  status: Run['status'],
  profiles: string[],
  start: string,
  end: string,
  extra: Partial<Run> = {},
): Run {
  return {
    id: 'r',
    taskId: 't1',
    status,
    inicio: start,
    fim: end,
    branch: 'b',
    agentes: profiles.map((p) => agent(p)),
    rodadas: [],
    decisoes: [],
    ...extra,
  };
}

describe('Scorecard', () => {
  let dir: string;
  let bus: EventBus;
  let now: Date;
  let existing: Set<string>;
  const created: Scorecard[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-placar-'));
    bus = new EventBus();
    now = new Date(2026, 9, 18, 12, 0, 0);
    existing = new Set(['claude', 'codex']);
  });

  afterEach(async () => {
    for (const card of created.splice(0)) card.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const make = (extra: Partial<ConstructorParameters<typeof Scorecard>[0]> = {}): Scorecard => {
    const card = new Scorecard({
      bus,
      sessionProfile,
      profileName: (id) => (id === 'claude' ? 'Claude' : id === 'codex' ? 'Codex' : undefined),
      profileExists: (id) => existing.has(id),
      dataDir: dir,
      clock: () => now,
      ...extra,
    });
    created.push(card);
    return card;
  };

  const daysAgo = (days: number): Date =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12, 0, 0);

  const iso = (date: Date): string => date.toISOString();

  it('conta a sessão uma vez, mesmo com muitos eventos e reaberturas', () => {
    const card = make();
    for (let i = 0; i < 3; i++) {
      bus.publish('agent.state', 's1', { state: 'ocioso', previous: 'preparando' });
    }
    bus.publish('agent.state', 's4', { state: 'pensando', previous: 'ocioso' });
    bus.publish('agent.state', 'desconhecida', { state: 'ocioso', previous: 'preparando' });
    const [claude, ...rest] = card.get('30d').perfis;
    expect(rest).toHaveLength(0);
    expect(claude).toMatchObject({ perfilId: 'claude', nome: 'Claude', sessoes: 2 });
  });

  it('soma tokens e custo pela diferença do acumulado e separa o custo das tarefas', () => {
    const card = make();
    bus.publish('cost.update', 's1', { inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    bus.publish('cost.update', 's2', {
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 220,
      cost: { amount: 0.5, currency: 'USD' },
    });
    // O acumulado da s2 sobe: só a diferença entra.
    bus.publish('cost.update', 's2', {
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
      cost: { amount: 0.75, currency: 'USD' },
    });
    // O agente reabriu e o acumulado recomeçou: conta do zero, sem valor negativo.
    bus.publish('cost.update', 's2', {
      inputTokens: 50,
      outputTokens: 5,
      totalTokens: 55,
      cost: { amount: 0.1, currency: 'USD' },
    });
    bus.publish('run.done', 'r', run('concluída', ['claude'], iso(daysAgo(0)), iso(daysAgo(0))));
    const [claude] = card.get('total').perfis;
    expect(claude).toMatchObject({
      tokensEntrada: 100 + 300 + 50,
      tokensSaida: 10 + 30 + 5,
      custoUsd: 0.85,
      tarefas: 1,
      custoMedioTarefaUsd: 0.85,
    });
  });

  it('calcula a taxa de aprovação com aceitos e rejeitados do diff', () => {
    const card = make();
    bus.publish('agent.review', 's1', { aceitos: 3, rejeitados: 0 });
    bus.publish('agent.review', 's1', { aceitos: 0, rejeitados: 1 });
    bus.publish('agent.review', 's3', { aceitos: 0, rejeitados: 0 });
    const result = card.get('30d');
    const claude = result.perfis.find((p) => p.perfilId === 'claude');
    expect(claude).toMatchObject({
      arquivosAceitos: 3,
      arquivosRejeitados: 1,
      taxaAprovacao: 0.75,
    });
    // Nenhum arquivo decidido: sem taxa, em vez de 0%.
    expect(card.get('30d').perfis.find((p) => p.perfilId === 'codex')?.taxaAprovacao).toBe(
      undefined,
    );
  });

  it('classifica as tarefas e calcula duração média e mediana sem a espera do limite', () => {
    const card = make();
    const start = daysAgo(0);
    const at = (minutes: number): string => iso(new Date(start.getTime() + minutes * 60_000));
    bus.publish('run.done', 'r1', run('concluída', ['claude', 'codex'], iso(start), at(10)));
    bus.publish('run.done', 'r2', run('concluída', ['claude'], iso(start), at(30)));
    bus.publish(
      'run.done',
      'r3',
      // 60 min no relógio, 40 esperando a cota renovar: 20 de trabalho.
      run('falhou', ['claude'], iso(start), at(60), { esperaLimiteMs: 40 * 60_000 }),
    );
    bus.publish('run.done', 'r4', run('descartada', ['claude', 'claude'], iso(start), at(5)));
    // Execução ainda ativa não conta.
    bus.publish('run.done', 'r5', run('executando', ['claude'], iso(start), at(5)));
    const claude = card.get('30d').perfis.find((p) => p.perfilId === 'claude');
    expect(claude).toMatchObject({
      tarefas: 4,
      tarefasConcluidas: 2,
      tarefasFalhas: 1,
      tarefasCanceladas: 1,
      // (10 + 30 + 20 + 5) / 4 minutos, e a mediana de 5, 10, 20, 30.
      duracaoMediaMs: 16.25 * 60_000,
      duracaoMedianaMs: 15 * 60_000,
    });
    const codex = card.get('30d').perfis.find((p) => p.perfilId === 'codex');
    expect(codex).toMatchObject({ tarefas: 1, duracaoMediaMs: 10 * 60_000 });
  });

  it('conta os limites de uso: uma vez por espera e uma por perfil no teto diário', () => {
    const card = make();
    const retomada = { motivo: 'limite-sessao', mensagem: 'limite', automatica: false };
    bus.publish('agent.recovery', 's1', { retomada });
    bus.publish('agent.recovery', 's1', { retomada });
    bus.publish('agent.recovery', 's1', { retomada: null });
    bus.publish('agent.recovery', 's1', { retomada });
    bus.publish('run.limit', 'anthropic', {
      tipo: 'teto-diario',
      provedor: 'anthropic',
      limite: 'custoUsd',
      valor: 5,
      gasto: 5,
      pausadas: ['s1', 's2', 's3'],
    });
    // Limite de uma execução (rodadas, tempo) não é limite de uso do provedor.
    bus.publish('run.limit', 'r', { tipo: 'execucao', runId: 'r', limite: 'rodadas' });
    const result = card.get('30d');
    expect(result.perfis.find((p) => p.perfilId === 'claude')?.limites).toBe(3);
    expect(result.perfis.find((p) => p.perfilId === 'codex')?.limites).toBe(1);
  });

  describe('períodos e retenção', () => {
    const finish = (when: Date): void => {
      now = when;
      bus.publish('run.done', 'r', run('concluída', ['claude'], iso(when), iso(when)));
    };

    it('separa 7 dias, 30 dias e total pelo dia local', () => {
      const real = new Date(now);
      const card = make();
      const dates = [40, 20, 7, 6, 0].map(daysAgo);
      for (const date of dates) finish(date);
      now = real;
      const tasks = (period: '7d' | '30d' | 'total'): number | undefined =>
        card.get(period).perfis[0]?.tarefas;
      expect(tasks('7d')).toBe(2);
      expect(tasks('30d')).toBe(4);
      expect(tasks('total')).toBe(5);
      expect(card.get('7d').desde).toBe(localDay(daysAgo(6)));
      expect(card.get('total').desde).toBeUndefined();
      expect(periodStart('30d', now)).toBe(localDay(daysAgo(29)));
    });

    it('descarta os dias além da retenção e mantém o total', async () => {
      const real = new Date(now);
      const card = make({ retentionDays: 10 });
      const dates = [30, 15, 2].map(daysAgo);
      for (const date of dates) finish(date);
      now = real;
      await card.flush();
      const saved = JSON.parse(await readFile(join(dir, 'scorecard.json'), 'utf8')) as {
        dias: Record<string, unknown>;
      };
      expect(Object.keys(saved.dias)).toEqual([localDay(daysAgo(2))]);
      expect(card.get('30d').perfis[0]?.tarefas).toBe(1);
      expect(card.get('total').perfis[0]?.tarefas).toBe(3);
    });

    it('limita as amostras de duração guardadas, sem perder a média', () => {
      const card = make();
      for (let i = 0; i < 600; i++) {
        const start = new Date(now.getTime());
        bus.publish(
          'run.done',
          'r',
          run('concluída', ['claude'], iso(start), iso(new Date(start.getTime() + 1_000))),
        );
      }
      const claude = card.get('total').perfis[0];
      expect(claude).toMatchObject({ tarefas: 600, duracaoMediaMs: 1_000 });
    });
  });

  describe('arquivo', () => {
    it('grava, relê e continua de onde parou', async () => {
      const first = make();
      bus.publish('agent.review', 's1', { aceitos: 2, rejeitados: 2 });
      bus.publish('run.done', 'r', run('concluída', ['claude'], iso(daysAgo(0)), iso(daysAgo(0))));
      await first.flush();
      first.dispose();

      const second = make({ bus: new EventBus() });
      await second.load();
      expect(second.get('total')).toEqual(first.get('total'));
      expect(second.get('total').perfis[0]).toMatchObject({ sessoes: 1, tarefas: 1 });
    });

    it('depois de reabrir, uma sessão já contada não conta de novo', async () => {
      const first = make();
      bus.publish('agent.state', 's1', { state: 'ocioso', previous: 'preparando' });
      await first.flush();
      first.dispose();

      const secondBus = new EventBus();
      const second = make({ bus: secondBus });
      await second.load();
      secondBus.publish('agent.state', 's1', { state: 'ocioso', previous: 'preparando' });
      expect(second.get('total').perfis[0]?.sessoes).toBe(1);
    });

    it('arquivo corrompido vira placar vazio, fica de lado e o Core segue gravando', async () => {
      const file = join(dir, 'scorecard.json');
      await writeFile(file, '{"versao":1,"dias":{"2026-10-1');
      const messages: string[] = [];
      const card = make({ log: (m) => messages.push(m) });
      await card.load();
      expect(card.get('total').perfis).toEqual([]);
      expect(messages).toHaveLength(1);
      expect(existsSync(`${file}.corrompido`)).toBe(true);

      bus.publish('agent.review', 's1', { aceitos: 1, rejeitados: 0 });
      await card.flush();
      const saved = JSON.parse(await readFile(file, 'utf8')) as { versao: number };
      expect(saved.versao).toBe(1);
    });

    it('arquivo ausente, de outra versão ou com formato errado vira placar vazio', async () => {
      const missing = make();
      await missing.load();
      expect(missing.get('total').perfis).toEqual([]);

      for (const content of ['[]', '42', 'null', '{"versao":99,"total":{}}']) {
        await writeFile(join(dir, 'scorecard.json'), content);
        const card = make();
        await card.load();
        expect(card.get('total').perfis).toEqual([]);
      }
    });

    it('descarta o que não presta dentro de um arquivo válido', () => {
      const doc = sanitizeDocument(
        {
          versao: 1,
          nomes: { claude: 'Claude', ruim: 7 },
          dias: {
            'dia-invalido': { claude: { sessoes: 4 } },
            '2026-10-18': {
              claude: { sessoes: 2, aceitos: -5, rejeitados: 'x', duracoes: [1, 'a', null, 3] },
              torto: 'texto',
            },
          },
          total: { claude: { sessoes: 2, custoUsd: Number.NaN }, outro: null },
          sessoesContadas: ['a', 1, 'b'],
          desde: 'nunca',
        },
        new Date(2026, 9, 18),
      );
      expect(Object.keys(doc.dias)).toEqual(['2026-10-18']);
      expect(doc.nomes).toEqual({ claude: 'Claude' });
      expect(Object.keys(doc.dias['2026-10-18'] ?? {})).toEqual(['claude']);
      expect(doc.dias['2026-10-18']?.claude).toMatchObject({
        sessoes: 2,
        aceitos: 0,
        rejeitados: 0,
        duracoes: [1, 3],
      });
      expect(doc.total.claude?.custoUsd).toBe(0);
      expect(Object.keys(doc.total)).toEqual(['claude']);
      expect(doc.sessoesContadas).toEqual(['a', 'b']);
      expect(Number.isNaN(Date.parse(doc.desde))).toBe(false);
    });
  });

  it('mantém o histórico de um perfil apagado, marcado como removido', () => {
    const card = make();
    bus.publish('run.done', 'r', run('concluída', ['codex'], iso(daysAgo(0)), iso(daysAgo(0))));
    expect(card.get('30d').perfis[0]).not.toHaveProperty('removido');
    existing.delete('codex');
    expect(card.get('30d').perfis[0]).toMatchObject({
      perfilId: 'codex',
      nome: 'Codex',
      removido: true,
    });
  });

  it('sem nome conhecido, mostra o id do perfil', () => {
    const card = make({ profileName: () => undefined });
    bus.publish('run.done', 'r', run('falhou', ['misterio'], iso(daysAgo(0)), iso(daysAgo(0))));
    expect(card.get('30d').perfis[0]).toMatchObject({ perfilId: 'misterio', nome: 'misterio' });
  });

  it('ordena pelos perfis com mais tarefas', () => {
    const card = make();
    bus.publish('run.done', 'a', run('concluída', ['codex'], iso(daysAgo(0)), iso(daysAgo(0))));
    for (let i = 0; i < 2; i++) {
      bus.publish('run.done', 'b', run('concluída', ['claude'], iso(daysAgo(0)), iso(daysAgo(0))));
    }
    expect(card.get('30d').perfis.map((p) => p.perfilId)).toEqual(['claude', 'codex']);
  });

  describe('resumo para o maestro', () => {
    const finishTasks = (count: number, profileId = 'claude'): void => {
      for (let i = 0; i < count; i++) {
        const start = daysAgo(0);
        bus.publish(
          'run.done',
          'r',
          run('concluída', [profileId], iso(start), iso(new Date(start.getTime() + 12 * 60_000))),
        );
      }
    };

    it('diz poucos dados abaixo da amostra mínima', () => {
      const card = make();
      finishTasks(SCORECARD_MIN_TASKS - 1);
      expect(card.summaryFor('claude')).toEqual({
        periodo: '30d',
        amostra: 'poucos dados',
        tarefas: SCORECARD_MIN_TASKS - 1,
      });
      expect(card.summaryFor('nunca-visto')).toEqual({
        periodo: '30d',
        amostra: 'poucos dados',
        tarefas: 0,
      });
    });

    it('com amostra suficiente traz aprovação, duração e custo médios arredondados', () => {
      const card = make();
      bus.publish('agent.review', 's2', { aceitos: 5, rejeitados: 1 });
      bus.publish('cost.update', 's2', {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        cost: { amount: 2.5, currency: 'USD' },
      });
      finishTasks(SCORECARD_MIN_TASKS);
      expect(card.summaryFor('claude')).toEqual({
        periodo: '30d',
        amostra: 'suficiente',
        tarefas: SCORECARD_MIN_TASKS,
        taxaAprovacao: 0.83,
        duracaoMediaMin: 12,
        custoMedioUsd: 0.5,
      });
    });

    it('conta só o período pedido', () => {
      const card = make();
      finishTasks(SCORECARD_MIN_TASKS);
      now = daysAgo(-40);
      expect(card.summaryFor('claude').amostra).toBe('poucos dados');
      expect(card.summaryFor('claude', 'total').amostra).toBe('suficiente');
    });
  });

  describe('API', () => {
    it('scorecard.get respeita o período e recusa um inválido', async () => {
      const card = make();
      const router = new Router();
      card.register(router);
      const today = new Date(now);
      now = daysAgo(20);
      bus.publish('run.done', 'r', run('concluída', ['claude'], iso(now), iso(now)));
      now = today;
      bus.publish('run.done', 'r', run('concluída', ['claude'], iso(daysAgo(0)), iso(daysAgo(0))));
      const get = (params?: unknown): Promise<unknown> =>
        router.dispatch('scorecard.get', params, context);
      expect(await get()).toMatchObject({ periodo: '30d', amostraMinima: SCORECARD_MIN_TASKS });
      expect(await get({ periodo: '7d' })).toMatchObject({
        periodo: '7d',
        perfis: [expect.objectContaining({ tarefas: 1 })],
      });
      expect(await get({ periodo: 'total' })).toMatchObject({
        perfis: [expect.objectContaining({ tarefas: 2 })],
      });
      await expect(get({ periodo: '1y' })).rejects.toBeInstanceOf(RpcError);
      await expect(get('x')).rejects.toBeInstanceOf(RpcError);
    });

    it('scorecard.reset zera tudo, inclusive o arquivo', async () => {
      const card = make();
      const router = new Router();
      card.register(router);
      bus.publish('run.done', 'r', run('concluída', ['claude'], iso(daysAgo(0)), iso(daysAgo(0))));
      await card.flush();
      expect(await router.dispatch('scorecard.reset', undefined, context)).toBeNull();
      expect(card.get('total').perfis).toEqual([]);
      const saved = JSON.parse(await readFile(join(dir, 'scorecard.json'), 'utf8')) as {
        total: object;
        dias: object;
      };
      expect(saved.total).toEqual({});
      expect(saved.dias).toEqual({});
    });
  });

  it('funciona só na memória, sem pasta de dados', async () => {
    const card = new Scorecard({ bus, sessionProfile, clock: () => now });
    created.push(card);
    bus.publish('agent.review', 's1', { aceitos: 1, rejeitados: 1 });
    await card.flush();
    expect(card.get('30d').perfis[0]?.taxaAprovacao).toBe(0.5);
    expect(existsSync(join(dir, 'scorecard.json'))).toBe(false);
  });
});

describe('usageDelta', () => {
  const zero = { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };

  it('devolve a diferença e o novo acumulado', () => {
    const first = usageDelta(zero, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(first.delta).toEqual({ tokensEntrada: 10, tokensSaida: 2, custoUsd: 0 });
    const next = usageDelta(first.current, {
      inputTokens: 15,
      outputTokens: 2,
      totalTokens: 17,
      cost: { amount: 1, currency: 'usd' },
    });
    expect(next.delta).toEqual({ tokensEntrada: 5, tokensSaida: 0, custoUsd: 1 });
  });

  it('recomeça do zero quando o acumulado cai', () => {
    const { delta } = usageDelta(
      { tokensEntrada: 100, tokensSaida: 10, custoUsd: 1 },
      { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    );
    expect(delta).toEqual({ tokensEntrada: 5, tokensSaida: 1, custoUsd: 0 });
  });
});
