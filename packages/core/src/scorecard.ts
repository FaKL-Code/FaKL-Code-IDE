import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { l10n } from '@fakl/i18n';
import {
  isScorecardPeriod,
  SCORECARD_MIN_TASKS,
  type AgentReviewEventData,
  type AgentUsageInfo,
  type AgentRecoveryEventData,
  type CostTotals,
  type DailyCapEventData,
  type Run,
  type ScorecardEntry,
  type ScorecardPeriod,
  type ScorecardResult,
  type ScorecardSummary,
} from '@fakl/protocol';

import { usageDelta, localDay } from './costs.js';
import type { Disposable, EventBus } from './events/bus.js';
import { objectParams, RpcError, type Router } from './rpc/router.js';
import { writeJsonAtomic } from './store.js';

/** Quanto do histórico diário fica no arquivo; o total acumulado não expira. */
export const SCORECARD_RETENTION_DAYS = 90;
/** Durações guardadas por dia e por perfil, para a mediana; as mais novas ficam. */
const DAY_SAMPLES_MAX = 200;
const TOTAL_SAMPLES_MAX = 500;
/** Sessões já contadas, para não contar de novo quando uma sessão reabre. */
const COUNTED_SESSIONS_MAX = 2_000;
const SAVE_DELAY_MS = 500;
const FILE_VERSION = 1;
const ZERO_TOTALS: CostTotals = { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };

/** Contadores de um perfil num dia (ou no total). Só somas e amostras de duração. */
interface Counters {
  sessoes: number;
  concluidas: number;
  falhas: number;
  canceladas: number;
  tokensEntrada: number;
  tokensSaida: number;
  custoUsd: number;
  /** Parte do custo que pertence a sessões de tarefas. */
  custoTarefasUsd: number;
  aceitos: number;
  rejeitados: number;
  limites: number;
  duracaoSomaMs: number;
  duracaoN: number;
  /** Amostras de duração (ms) para a mediana. */
  duracoes: number[];
}

interface ScorecardDocument {
  versao: number;
  /** Último nome conhecido de cada perfil. */
  nomes: Record<string, string>;
  /** AAAA-MM-DD no fuso local → perfil → contadores. */
  dias: Record<string, Record<string, Counters>>;
  total: Record<string, Counters>;
  /** Sessões já contadas, as mais antigas primeiro. */
  sessoesContadas: string[];
  /** Quando o placar começou a contar (ISO). */
  desde: string;
}

function emptyCounters(): Counters {
  return {
    sessoes: 0,
    concluidas: 0,
    falhas: 0,
    canceladas: 0,
    tokensEntrada: 0,
    tokensSaida: 0,
    custoUsd: 0,
    custoTarefasUsd: 0,
    aceitos: 0,
    rejeitados: 0,
    limites: 0,
    duracaoSomaMs: 0,
    duracaoN: 0,
    duracoes: [],
  };
}

/** Arredonda em milionésimos de dólar para a soma não acumular erro de ponto flutuante. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function emptyDocument(now: Date): ScorecardDocument {
  return {
    versao: FILE_VERSION,
    nomes: {},
    dias: {},
    total: {},
    sessoesContadas: [],
    desde: now.toISOString(),
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeCounters(value: unknown): Counters | undefined {
  if (!isRecord(value)) return undefined;
  const duracoes = Array.isArray(value.duracoes)
    ? value.duracoes.filter(
        (d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0,
      )
    : [];
  return {
    sessoes: count(value.sessoes),
    concluidas: count(value.concluidas),
    falhas: count(value.falhas),
    canceladas: count(value.canceladas),
    tokensEntrada: count(value.tokensEntrada),
    tokensSaida: count(value.tokensSaida),
    custoUsd: count(value.custoUsd),
    custoTarefasUsd: count(value.custoTarefasUsd),
    aceitos: count(value.aceitos),
    rejeitados: count(value.rejeitados),
    limites: count(value.limites),
    duracaoSomaMs: count(value.duracaoSomaMs),
    duracaoN: count(value.duracaoN),
    duracoes: duracoes.slice(-TOTAL_SAMPLES_MAX),
  };
}

function sanitizeByProfile(value: unknown): Record<string, Counters> {
  const result: Record<string, Counters> = {};
  if (!isRecord(value)) return result;
  for (const [id, counters] of Object.entries(value)) {
    const clean = sanitizeCounters(counters);
    if (clean) result[id] = clean;
  }
  return result;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Aceita o que o arquivo tiver de aproveitável. Um arquivo de outra versão ou
 * que não seja um documento vira um placar vazio; campos soltos e inválidos
 * são descartados em vez de derrubar o Core.
 */
export function sanitizeDocument(value: unknown, now: Date): ScorecardDocument {
  if (!isRecord(value) || value.versao !== FILE_VERSION) return emptyDocument(now);
  const dias: Record<string, Record<string, Counters>> = {};
  if (isRecord(value.dias)) {
    for (const [day, perfis] of Object.entries(value.dias)) {
      if (DAY_KEY.test(day)) dias[day] = sanitizeByProfile(perfis);
    }
  }
  const nomes: Record<string, string> = {};
  if (isRecord(value.nomes)) {
    for (const [id, nome] of Object.entries(value.nomes)) {
      if (typeof nome === 'string') nomes[id] = nome;
    }
  }
  return {
    versao: FILE_VERSION,
    nomes,
    dias,
    total: sanitizeByProfile(value.total),
    sessoesContadas: Array.isArray(value.sessoesContadas)
      ? value.sessoesContadas
          .filter((id): id is string => typeof id === 'string')
          .slice(-COUNTED_SESSIONS_MAX)
      : [],
    desde:
      typeof value.desde === 'string' && !Number.isNaN(Date.parse(value.desde))
        ? value.desde
        : now.toISOString(),
  };
}

function mergeInto(target: Counters, source: Counters, samplesMax: number): void {
  target.sessoes += source.sessoes;
  target.concluidas += source.concluidas;
  target.falhas += source.falhas;
  target.canceladas += source.canceladas;
  target.tokensEntrada += source.tokensEntrada;
  target.tokensSaida += source.tokensSaida;
  target.custoUsd = roundUsd(target.custoUsd + source.custoUsd);
  target.custoTarefasUsd = roundUsd(target.custoTarefasUsd + source.custoTarefasUsd);
  target.aceitos += source.aceitos;
  target.rejeitados += source.rejeitados;
  target.limites += source.limites;
  target.duracaoSomaMs += source.duracaoSomaMs;
  target.duracaoN += source.duracaoN;
  target.duracoes = [...target.duracoes, ...source.duracoes].slice(-samplesMax);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function tasksOf(counters: Counters): number {
  return counters.concluidas + counters.falhas + counters.canceladas;
}

function isEmpty(counters: Counters): boolean {
  return (
    counters.sessoes === 0 &&
    tasksOf(counters) === 0 &&
    counters.tokensEntrada === 0 &&
    counters.tokensSaida === 0 &&
    counters.custoUsd === 0 &&
    counters.aceitos === 0 &&
    counters.rejeitados === 0 &&
    counters.limites === 0
  );
}

/** Primeiro dia (AAAA-MM-DD, fuso local) que entra no período; `undefined` é o total. */
export function periodStart(period: ScorecardPeriod, now: Date): string | undefined {
  if (period === 'total') return undefined;
  const days = period === '7d' ? 7 : 30;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return localDay(start);
}

export interface ScorecardOptions {
  readonly bus: EventBus;
  /** Perfil e tarefa de uma sessão (`AgentRuntime.sessionProfile`). */
  readonly sessionProfile: (
    sessionId: string,
  ) => { profile: { id: string; nome: string }; taskId?: string } | undefined;
  /** Nome atual de um perfil, para as execuções, que só guardam o id. */
  readonly profileName?: (profileId: string) => string | undefined;
  /** O perfil ainda existe? Os que saíram aparecem como removidos. */
  readonly profileExists?: (profileId: string) => boolean;
  /** `~/.fakl/data`; sem a pasta, o placar vive só na memória (testes). */
  readonly dataDir?: string;
  readonly clock?: () => Date;
  readonly retentionDays?: number;
  readonly log?: (message: string) => void;
}

/**
 * Placar dos agentes por perfil (ADR 0043). Escuta o barramento de eventos e
 * mantém contadores incrementais por dia e no total, em `scorecard.json`; o
 * `agents.ts` não sabe que ele existe. Mede sinais indiretos (aprovação do
 * diff, duração, custo, limites), não a qualidade do código. Nada sai da máquina.
 */
export class Scorecard implements Disposable {
  private doc: ScorecardDocument;
  private readonly subscription: Disposable;
  private readonly clock: () => Date;
  private readonly file: string | undefined;
  private readonly retention: number;
  private readonly lastUsage = new Map<string, CostTotals>();
  /** Sessões esperando a cota do provedor, para contar o limite uma vez por espera. */
  private readonly recovering = new Set<string>();
  private counted: Set<string>;
  private saveTimer: NodeJS.Timeout | undefined;
  private dirty = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: ScorecardOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.retention = options.retentionDays ?? SCORECARD_RETENTION_DAYS;
    this.file = options.dataDir ? join(options.dataDir, 'scorecard.json') : undefined;
    this.doc = emptyDocument(this.clock());
    this.counted = new Set();
    this.subscription = options.bus.subscribe(
      ['agent.state', 'agent.review', 'agent.recovery', 'cost.update', 'run.limit', 'run.done'],
      (event) => {
        switch (event.topic) {
          case 'agent.state':
            this.countSession(event.subject);
            break;
          case 'cost.update':
            this.onUsage(event.subject, event.data as AgentUsageInfo);
            break;
          case 'agent.review':
            this.onReview(event.subject, event.data as AgentReviewEventData);
            break;
          case 'agent.recovery':
            this.onRecovery(event.subject, event.data as AgentRecoveryEventData);
            break;
          case 'run.limit':
            this.onDailyCap(event.data as Partial<DailyCapEventData>);
            break;
          case 'run.done':
            this.onRunDone(event.data as Run);
            break;
          default:
            break;
        }
      },
    );
  }

  /** Lê o arquivo. Ausente, vazio ou corrompido: começa vazio (o corrompido fica de lado). */
  async load(): Promise<void> {
    if (!this.file) return;
    const now = this.clock();
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      return;
    }
    try {
      this.doc = sanitizeDocument(JSON.parse(text), now);
    } catch (error) {
      this.options.log?.(l10n.t('could not read the agent scorecard: {0}', String(error)));
      await rename(this.file, `${this.file}.corrompido`).catch(() => undefined);
      this.doc = emptyDocument(now);
    }
    this.counted = new Set(this.doc.sessoesContadas);
    this.prune();
  }

  /** Grava o que estiver pendente e espera a gravação. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.dirty) this.save();
    await this.pending;
  }

  dispose(): void {
    this.subscription.dispose();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  /** O placar de um período: um item por perfil com atividade, os de mais tarefas primeiro. */
  get(period: ScorecardPeriod = '30d'): ScorecardResult {
    const now = this.clock();
    const start = periodStart(period, now);
    const sums = new Map<string, Counters>();
    if (start === undefined) {
      for (const [id, counters] of Object.entries(this.doc.total)) {
        sums.set(id, { ...emptyCounters(), ...counters, duracoes: [...counters.duracoes] });
      }
    } else {
      for (const [day, perfis] of Object.entries(this.doc.dias)) {
        if (day < start) continue;
        for (const [id, counters] of Object.entries(perfis)) {
          const sum = sums.get(id) ?? emptyCounters();
          mergeInto(sum, counters, TOTAL_SAMPLES_MAX);
          sums.set(id, sum);
        }
      }
    }
    const perfis = [...sums.entries()]
      .filter(([, counters]) => !isEmpty(counters))
      .map(([id, counters]) => this.entry(id, counters))
      .sort(
        (a, b) => b.tarefas - a.tarefas || b.sessoes - a.sessoes || a.nome.localeCompare(b.nome),
      );
    return {
      periodo: period,
      ...(start ? { desde: start } : {}),
      amostraMinima: SCORECARD_MIN_TASKS,
      perfis,
    };
  }

  /**
   * Resumo curto para o maestro (`list_profiles`). Com menos tarefas que o
   * mínimo, só diz "poucos dados": número de uma amostra pequena engana.
   */
  summaryFor(profileId: string, period: ScorecardPeriod = '30d'): ScorecardSummary {
    const entry = this.get(period).perfis.find((e) => e.perfilId === profileId);
    const tarefas = entry?.tarefas ?? 0;
    if (!entry || tarefas < SCORECARD_MIN_TASKS) {
      return { periodo: period, amostra: 'poucos dados', tarefas };
    }
    return {
      periodo: period,
      amostra: 'suficiente',
      tarefas,
      ...(entry.taxaAprovacao !== undefined
        ? { taxaAprovacao: Math.round(entry.taxaAprovacao * 100) / 100 }
        : {}),
      ...(entry.duracaoMediaMs !== undefined
        ? { duracaoMediaMin: Math.round(entry.duracaoMediaMs / 6_000) / 10 }
        : {}),
      ...(entry.custoMedioTarefaUsd !== undefined
        ? { custoMedioUsd: Math.round(entry.custoMedioTarefaUsd * 100) / 100 }
        : {}),
    };
  }

  /** Apaga todos os contadores (`scorecard.reset`). */
  async reset(): Promise<void> {
    this.doc = emptyDocument(this.clock());
    this.counted = new Set();
    this.lastUsage.clear();
    this.recovering.clear();
    this.dirty = true;
    await this.flush();
  }

  register(router: Router): void {
    router.register('scorecard.get', (params) => {
      const p = params === undefined || params === null ? {} : objectParams(params);
      if (p.periodo !== undefined && !isScorecardPeriod(p.periodo)) {
        throw RpcError.invalidParams(l10n.t('periodo must be 7d, 30d or total'));
      }
      return this.get(p.periodo);
    });
    router.register('scorecard.reset', async () => {
      await this.reset();
      return null;
    });
  }

  // ------------------------------------------------------------------ eventos

  /** A primeira atividade de uma sessão a conta; reabrir a mesma sessão não conta de novo. */
  private countSession(sessionId: string): string | undefined {
    const info = this.options.sessionProfile(sessionId);
    if (!info) return undefined;
    const id = info.profile.id;
    this.remember(id, info.profile.nome);
    if (!this.counted.has(sessionId)) {
      this.counted.add(sessionId);
      this.doc.sessoesContadas.push(sessionId);
      if (this.doc.sessoesContadas.length > COUNTED_SESSIONS_MAX) {
        const dropped = this.doc.sessoesContadas.splice(
          0,
          this.doc.sessoesContadas.length - COUNTED_SESSIONS_MAX,
        );
        for (const old of dropped) this.counted.delete(old);
      }
      this.bump(id, (c) => {
        c.sessoes += 1;
      });
    }
    return id;
  }

  private onUsage(sessionId: string, usage: AgentUsageInfo): void {
    const id = this.countSession(sessionId);
    if (!id) return;
    const { current, delta } = usageDelta(this.lastUsage.get(sessionId) ?? ZERO_TOTALS, usage);
    this.lastUsage.set(sessionId, current);
    const taskId = this.options.sessionProfile(sessionId)?.taskId;
    this.bump(id, (c) => {
      c.tokensEntrada += delta.tokensEntrada;
      c.tokensSaida += delta.tokensSaida;
      c.custoUsd = roundUsd(c.custoUsd + delta.custoUsd);
      if (taskId) c.custoTarefasUsd = roundUsd(c.custoTarefasUsd + delta.custoUsd);
    });
  }

  private onReview(sessionId: string, data: AgentReviewEventData): void {
    const id = this.countSession(sessionId);
    if (!id) return;
    const aceitos = count(data.aceitos);
    const rejeitados = count(data.rejeitados);
    if (aceitos === 0 && rejeitados === 0) return;
    this.bump(id, (c) => {
      c.aceitos += aceitos;
      c.rejeitados += rejeitados;
    });
  }

  /** O agente bateu o limite da janela do plano: uma vez por espera, não por aviso repetido. */
  private onRecovery(sessionId: string, data: AgentRecoveryEventData): void {
    if (!data.retomada) {
      this.recovering.delete(sessionId);
      return;
    }
    if (this.recovering.has(sessionId)) return;
    this.recovering.add(sessionId);
    const id = this.countSession(sessionId);
    if (id) {
      this.bump(id, (c) => {
        c.limites += 1;
      });
    }
  }

  /** Teto diário do provedor: conta uma vez para cada perfil que tinha sessão pausada por ele. */
  private onDailyCap(data: Partial<DailyCapEventData>): void {
    if (data.tipo !== 'teto-diario' || !data.pausadas) return;
    const profiles = new Set<string>();
    for (const sessionId of data.pausadas) {
      const id = this.countSession(sessionId);
      if (id) profiles.add(id);
    }
    for (const id of profiles) {
      this.bump(id, (c) => {
        c.limites += 1;
      });
    }
  }

  /**
   * Fim de uma execução: o resultado conta para cada perfil que participou,
   * uma vez por perfil. Concluída é concluída; falhou é falha; descartada
   * (cancelada pelo usuário ou por um limite) é cancelada.
   */
  private onRunDone(run: Run): void {
    const outcome =
      run.status === 'concluída'
        ? 'concluidas'
        : run.status === 'falhou'
          ? 'falhas'
          : run.status === 'descartada'
            ? 'canceladas'
            : undefined;
    if (!outcome) return;
    const ended = run.fim ? Date.parse(run.fim) : this.clock().getTime();
    const started = Date.parse(run.inicio);
    // O tempo esperando a cota do provedor renovar não é tempo de trabalho do perfil.
    const waited = typeof run.esperaLimiteMs === 'number' ? run.esperaLimiteMs : 0;
    const duration =
      Number.isFinite(ended) && Number.isFinite(started)
        ? Math.max(0, ended - started - waited)
        : undefined;
    for (const profileId of new Set(run.agentes.map((agent) => agent.profileId))) {
      const nome = this.options.profileName?.(profileId);
      if (nome) this.remember(profileId, nome);
      this.bump(profileId, (c) => {
        c[outcome] += 1;
        if (duration !== undefined) {
          c.duracaoSomaMs += duration;
          c.duracaoN += 1;
          c.duracoes.push(duration);
        }
      });
    }
  }

  // ------------------------------------------------------------------ contadores

  private remember(profileId: string, nome: string): void {
    if (this.doc.nomes[profileId] === nome) return;
    this.doc.nomes[profileId] = nome;
    this.touch();
  }

  /** Aplica a mudança ao dia de hoje e ao total do perfil. */
  private bump(profileId: string, change: (counters: Counters) => void): void {
    const day = localDay(this.clock());
    const today = ((this.doc.dias[day] ??= {})[profileId] ??= emptyCounters());
    const total = (this.doc.total[profileId] ??= emptyCounters());
    change(today);
    change(total);
    today.duracoes = today.duracoes.slice(-DAY_SAMPLES_MAX);
    total.duracoes = total.duracoes.slice(-TOTAL_SAMPLES_MAX);
    this.prune();
    this.touch();
  }

  /** Tira do histórico diário o que passou da retenção. */
  private prune(): void {
    const now = this.clock();
    const limit = localDay(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - (this.retention - 1)),
    );
    if (Object.keys(this.doc.dias).every((day) => day >= limit)) return;
    this.doc.dias = Object.fromEntries(
      Object.entries(this.doc.dias).filter(([day]) => day >= limit),
    );
  }

  private entry(profileId: string, c: Counters): ScorecardEntry {
    const tarefas = tasksOf(c);
    const decididos = c.aceitos + c.rejeitados;
    const mediana = median(c.duracoes);
    const exists = this.options.profileExists?.(profileId);
    return {
      perfilId: profileId,
      nome: this.doc.nomes[profileId] ?? profileId,
      ...(exists === false ? { removido: true } : {}),
      sessoes: c.sessoes,
      tarefas,
      tarefasConcluidas: c.concluidas,
      tarefasFalhas: c.falhas,
      tarefasCanceladas: c.canceladas,
      ...(c.duracaoN > 0 ? { duracaoMediaMs: Math.round(c.duracaoSomaMs / c.duracaoN) } : {}),
      ...(mediana !== undefined ? { duracaoMedianaMs: Math.round(mediana) } : {}),
      tokensEntrada: c.tokensEntrada,
      tokensSaida: c.tokensSaida,
      custoUsd: roundUsd(c.custoUsd),
      ...(tarefas > 0 && c.custoTarefasUsd > 0
        ? { custoMedioTarefaUsd: roundUsd(c.custoTarefasUsd / tarefas) }
        : {}),
      arquivosAceitos: c.aceitos,
      arquivosRejeitados: c.rejeitados,
      ...(decididos > 0 ? { taxaAprovacao: c.aceitos / decididos } : {}),
      limites: c.limites,
    };
  }

  // ------------------------------------------------------------------ gravação

  private touch(): void {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  private save(): void {
    this.dirty = false;
    if (!this.file) return;
    this.pending = writeJsonAtomic(this.file, this.doc).catch((error: unknown) => {
      this.options.log?.(l10n.t('could not save the agent scorecard: {0}', String(error)));
    });
  }
}
