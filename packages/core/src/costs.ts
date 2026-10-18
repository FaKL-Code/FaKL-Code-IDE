import { join } from 'node:path';

import { l10n } from '@fakl/i18n';
import type {
  AgentUsageInfo,
  CostByTask,
  CostEntry,
  CostSummary,
  CostTotals,
  DailyCap,
  DailyCapEventData,
} from '@fakl/protocol';

import type { AgentRuntime } from './agents.js';
import type { Disposable, EventBus } from './events/bus.js';
import { objectParams, RpcError, stringParam, type Router } from './rpc/router.js';
import { JsonlLog } from './store.js';
import { ulid } from './ulid.js';

const ZERO: CostTotals = { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };

/** Dia no fuso local, AAAA-MM-DD. */
export function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function add(a: CostTotals, b: CostTotals): CostTotals {
  return {
    tokensEntrada: a.tokensEntrada + b.tokensEntrada,
    tokensSaida: a.tokensSaida + b.tokensSaida,
    // Arredonda em décimos de centavo de centavo para não acumular erro de ponto flutuante.
    custoUsd: Math.round((a.custoUsd + b.custoUsd) * 1e6) / 1e6,
  };
}

/**
 * O que uma atualização de uso acrescentou ao acumulado da sessão. Os agentes
 * informam o total desde que abriram; se ele cair, o agente reabriu (troca de
 * conta, retomada) e a conta recomeça do zero.
 */
export function usageDelta(
  last: CostTotals,
  usage: AgentUsageInfo,
): { current: CostTotals; delta: CostTotals } {
  const usd = usage.cost?.currency.toUpperCase() === 'USD' ? usage.cost.amount : undefined;
  const restarted =
    usage.inputTokens < last.tokensEntrada ||
    usage.outputTokens < last.tokensSaida ||
    (usd !== undefined && usd < last.custoUsd);
  const previous = restarted ? ZERO : last;
  const current: CostTotals = {
    tokensEntrada: usage.inputTokens,
    tokensSaida: usage.outputTokens,
    custoUsd: usd ?? previous.custoUsd,
  };
  return {
    current,
    delta: {
      tokensEntrada: Math.max(0, current.tokensEntrada - previous.tokensEntrada),
      tokensSaida: Math.max(0, current.tokensSaida - previous.tokensSaida),
      custoUsd: Math.max(0, Math.round((current.custoUsd - previous.custoUsd) * 1e6) / 1e6),
    },
  };
}

/** Qual limite do teto foi atingido, se algum. */
export function capExceeded(
  totals: CostTotals,
  cap: DailyCap | undefined,
): { limite: 'custoUsd' | 'tokens'; valor: number; gasto: number } | undefined {
  if (!cap) return undefined;
  if (cap.custoUsd !== undefined && totals.custoUsd >= cap.custoUsd) {
    return { limite: 'custoUsd', valor: cap.custoUsd, gasto: totals.custoUsd };
  }
  const tokens = totals.tokensEntrada + totals.tokensSaida;
  if (cap.tokens !== undefined && tokens >= cap.tokens) {
    return { limite: 'tokens', valor: cap.tokens, gasto: tokens };
  }
  return undefined;
}

export interface CostTrackerOptions {
  readonly bus: EventBus;
  readonly agents: AgentRuntime;
  /** Pasta de dados (`~/.fakl/data`); sem ela, os gastos ficam só na memória. */
  readonly dataDir?: string;
  readonly caps: () => Readonly<Record<string, DailyCap>>;
  readonly setCaps?: (caps: Readonly<Record<string, DailyCap>>) => Promise<void>;
  readonly clock?: () => Date;
  readonly log?: (message: string) => void;
}

/**
 * Contabilidade de tokens e custo (módulo `costs`, SDD 6.2) e teto diário por
 * provedor (RNF-13). Os agentes informam o uso acumulado da sessão; aqui ele
 * vira lançamentos com a diferença desde o último, gravados em
 * `costs.jsonl`. Ao bater o teto, as sessões daquele provedor que estão
 * trabalhando são pausadas e novas mensagens são recusadas até o dia virar ou
 * o teto subir.
 */
export class CostTracker implements Disposable {
  private entries: CostEntry[] = [];
  private readonly last = new Map<string, CostTotals>();
  /** Provedores já avisados hoje, para pausar e notificar uma vez só. */
  private readonly warned = new Map<string, string>();
  private readonly subscription: Disposable;
  private readonly log: JsonlLog<CostEntry> | undefined;
  private readonly clock: () => Date;

  constructor(private readonly options: CostTrackerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.log = options.dataDir ? new JsonlLog(join(options.dataDir, 'costs.jsonl')) : undefined;
    this.subscription = options.bus.subscribe(['cost.update'], (event) => {
      this.record(event.subject, event.data as AgentUsageInfo);
    });
  }

  async load(): Promise<void> {
    if (this.log) this.entries = await this.log.readAll();
  }

  flush(): Promise<void> {
    return this.log?.flush() ?? Promise.resolve();
  }

  dispose(): void {
    this.subscription.dispose();
  }

  /** Motivo para recusar trabalho novo deste provedor, ou nada. */
  blockedReason(provedor: string): string | undefined {
    const over = capExceeded(this.totalsFor(provedor), this.options.caps()[provedor]);
    if (!over) return undefined;
    return over.limite === 'custoUsd'
      ? l10n.t(
          'daily cap for {0} reached ({1} of {2}); raise the cap or wait for the day to change',
          provedor,
          l10n.t('${0}', over.gasto.toFixed(2)),
          l10n.t('${0}', over.valor.toFixed(2)),
        )
      : l10n.t(
          'daily cap for {0} reached ({1} of {2} tokens); raise the cap or wait for the day to change',
          provedor,
          String(over.gasto),
          String(over.valor),
        );
  }

  summary(dia = localDay(this.clock())): CostSummary {
    let total = ZERO;
    const porProvedor: Record<string, CostTotals> = {};
    const porSessao: Record<string, CostTotals> = {};
    for (const entry of this.entries) {
      if (localDay(new Date(entry.ts)) !== dia) continue;
      total = add(total, entry);
      porProvedor[entry.provedor] = add(porProvedor[entry.provedor] ?? ZERO, entry);
      porSessao[entry.sessionId] = add(porSessao[entry.sessionId] ?? ZERO, entry);
    }
    const tetos = this.options.caps();
    const today = dia === localDay(this.clock());
    return {
      dia,
      total,
      porProvedor,
      porSessao,
      tetos,
      bloqueados: today
        ? Object.keys(tetos).filter((p) => capExceeded(porProvedor[p] ?? ZERO, tetos[p]))
        : [],
    };
  }

  byTask(): CostByTask {
    const result: Record<string, CostTotals> = {};
    for (const entry of this.entries) {
      if (entry.taskId) result[entry.taskId] = add(result[entry.taskId] ?? ZERO, entry);
    }
    return result;
  }

  /** Gasto somado destas sessões (os limites de custo e tokens de uma execução). */
  sessionTotals(sessionIds: readonly string[]): CostTotals {
    const ids = new Set(sessionIds);
    let total = ZERO;
    for (const entry of this.entries) if (ids.has(entry.sessionId)) total = add(total, entry);
    return total;
  }

  /** Gasto de uma tarefa (para os limites de custo e tokens da execução). */
  taskTotals(taskId: string): CostTotals {
    return this.byTask()[taskId] ?? ZERO;
  }

  register(router: Router): void {
    router.register('costs.summary', (params) => {
      const p = params === undefined ? {} : objectParams(params);
      return this.summary(typeof p.dia === 'string' ? p.dia : undefined);
    });
    router.register('costs.byTask', () => this.byTask());
    router.register('costs.limits.get', () => this.options.caps());
    router.register('costs.limits.set', async (params) => {
      const p = objectParams(params);
      const provedor = stringParam(p, 'provedor');
      const cap: Record<string, number> = {};
      for (const key of ['custoUsd', 'tokens'] as const) {
        const value = p[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'number' || !(value >= 0)) {
          throw RpcError.invalidParams(
            l10n.t('{0} must be a number greater than or equal to zero', key),
          );
        }
        cap[key] = value;
      }
      if (!this.options.setCaps) throw RpcError.invalidParams(l10n.t('read-only configuration'));
      const caps = Object.fromEntries(
        Object.entries(this.options.caps()).filter(([name]) => name !== provedor),
      ) as Record<string, DailyCap>;
      if (Object.keys(cap).length > 0) caps[provedor] = cap;
      await this.options.setCaps(caps);
      this.warned.delete(provedor);
      return this.options.caps();
    });
  }

  private totalsFor(provedor: string): CostTotals {
    return this.summary().porProvedor[provedor] ?? ZERO;
  }

  private record(sessionId: string, usage: AgentUsageInfo): void {
    const info = this.options.agents.sessionProfile(sessionId);
    if (!info) return;
    const { current, delta } = usageDelta(this.last.get(sessionId) ?? ZERO, usage);
    this.last.set(sessionId, current);
    if (delta.tokensEntrada === 0 && delta.tokensSaida === 0 && delta.custoUsd === 0) return;
    const entry: CostEntry = {
      id: ulid(),
      sessionId,
      provedor: info.profile.provedor,
      ...(info.profile.modelo ? { modelo: info.profile.modelo } : {}),
      ...delta,
      ts: this.clock().toISOString(),
      ...(info.taskId ? { taskId: info.taskId } : {}),
    };
    this.entries.push(entry);
    void this.log?.append(entry).catch((error: unknown) => {
      this.options.log?.(l10n.t('could not save the cost: {0}', String(error)));
    });
    this.checkCap(entry.provedor);
  }

  private checkCap(provedor: string): void {
    const over = capExceeded(this.totalsFor(provedor), this.options.caps()[provedor]);
    const today = localDay(this.clock());
    if (!over || this.warned.get(provedor) === today) return;
    this.warned.set(provedor, today);
    const pausadas = this.options.agents.pauseProvider(provedor);
    const data: DailyCapEventData = { tipo: 'teto-diario', provedor, ...over, pausadas };
    this.options.bus.publish('run.limit', provedor, data);
    this.options.log?.(
      l10n.t('daily cap for {0} reached; {1} session(s) paused', provedor, String(pausadas.length)),
    );
  }
}
