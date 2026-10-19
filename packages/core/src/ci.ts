import type { GhJob, GhRepoRef, GhWorkflowRun } from '@fakl/integrations';
import type {
  CiRepoStatus,
  CiRun,
  CiRunEventData,
  CiStatus,
  CiStatusParams,
  CiWatchSetParams,
} from '@fakl/protocol';

import {
  changedRuns,
  failingCount,
  greenStreak,
  isActive,
  JOBS_FOR_RUNS,
  limitRepos,
  newestFirst,
  nextDelayMs,
  parseWatchedRepo,
  RUNS_PER_REPO,
  toCiRun,
  workingCount,
  type WatchSelection,
} from './ci-model.js';
import type { EventBus } from './events/bus.js';
import { objectParams, type Router } from './rpc/router.js';

/** O que o serviço precisa do GitHub; o Core liga isto ao `GitHubService`. */
export interface CiSource {
  /** O usuário conectou a conta; sem isso nada é consultado. */
  readonly connected: boolean;
  runs(repo: GhRepoRef, perPage: number): Promise<readonly GhWorkflowRun[]>;
  jobs(repo: GhRepoRef, runId: number): Promise<readonly GhJob[]>;
  /** Repositório do `origin` de uma pasta, se for do GitHub. */
  repoOf(path: string): Promise<GhRepoRef | undefined>;
  /** Quando o limite da API volta (ms desde a época), se estourou. */
  limitedUntil(): number | undefined;
}

export interface CiServiceOptions {
  readonly bus: EventBus;
  readonly source: CiSource;
  readonly now?: () => number;
  /** Agenda a próxima consulta; muda nos testes para não esperar de verdade. */
  readonly schedule?: (callback: () => void, ms: number) => { cancel(): void };
  readonly log?: (message: string) => void;
}

/** Consultas pedidas pelo usuário mais próximas que isto são atendidas com o que já se sabe. */
const MIN_MANUAL_GAP_MS = 10_000;

function defaultSchedule(callback: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

function selectionKey(list: readonly WatchSelection[]): string {
  return list.map((w) => `${w.origem}:${w.repo}`).join('|');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Café do CI no Core (ADR 0051): acompanha as execuções do GitHub Actions de
 * poucos repositórios e publica `ci.run` quando algo muda. Reaproveita o
 * cliente do GitHub (e o token do cofre, que nunca passa por aqui). Os dados
 * ficam só em memória. A consulta automática só acontece com a conta
 * conectada e `fakl.rede.consultasAutomaticas` ligada; um pedido do usuário
 * (`atualizar`) sempre pode, e o intervalo se adapta ao que está acontecendo.
 */
export class CiService {
  private watched: WatchSelection[] = [];
  private descartados: string[] = [];
  private marked: readonly string[] = [];
  private folders: readonly string[] = [];
  private automatic = true;
  private repos = new Map<string, CiRepoStatus>();
  private readonly seen = new Map<string, string>();
  private readonly jobCache = new Map<string, { estado: string; jobs: GhJob[] }>();
  private polling: Promise<void> | undefined;
  private timer: { cancel(): void } | undefined;
  private failures = 0;
  private lastChangeAt: number | undefined;
  private lastPollAt: number | undefined;
  private updatedAt: string | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: CiServiceOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  dispose(): void {
    this.disposed = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  /** Há repositórios acompanhados (a cozinha só aparece então). */
  get active(): boolean {
    return this.watched.length > 0;
  }

  /** Retrato do que se sabe, sem consultar nada. */
  status(): CiStatus {
    const repos = this.watched.map(
      (w): CiRepoStatus => this.repos.get(w.repo) ?? { repo: w.repo, origem: w.origem, runs: [] },
    );
    const runs = repos.flatMap((r) => r.runs);
    return {
      conectado: this.options.source.connected,
      automatico: this.automatic,
      repos,
      descartados: this.descartados,
      falhando: failingCount(runs),
      trabalhando: workingCount(runs),
      verdesSeguidos: greenStreak(runs),
      ...(this.updatedAt ? { atualizadoEm: this.updatedAt } : {}),
    };
  }

  /** Define quem acompanhar; devolve o retrato e, se couber, já agenda a consulta. */
  async setWatch(params: CiWatchSetParams): Promise<CiStatus> {
    const marked = (params.repos ?? []).flatMap((r) => parseWatchedRepo(r) ?? []);
    const folders = (params.pastas ?? []).filter((p) => typeof p === 'string' && p !== '');
    if (typeof params.automatico === 'boolean') this.automatic = params.automatico;
    const opened: string[] = [];
    if (this.options.source.connected) {
      for (const folder of folders) {
        const ref = await this.options.source.repoOf(folder).catch(() => undefined);
        if (ref) opened.push(`${ref.owner}/${ref.name}`);
      }
    }
    this.marked = marked;
    this.folders = folders;
    const { watched, descartados } = limitRepos(opened, marked);
    const same = selectionKey(watched) === selectionKey(this.watched);
    this.watched = watched;
    this.descartados = descartados;
    if (!same) {
      const keep = new Set(watched.map((w) => w.repo));
      for (const repo of [...this.repos.keys()]) if (!keep.has(repo)) this.repos.delete(repo);
      for (const key of [...this.seen.keys()]) {
        if (!keep.has(key.slice(0, key.lastIndexOf('#')))) this.seen.delete(key);
      }
      this.generation++;
    }
    this.reschedule(!same);
    return this.status();
  }

  /** A conta foi conectada ou desconectada: liga ou desliga a consulta automática. */
  reconnected(): void {
    if (!this.options.source.connected) {
      this.timer?.cancel();
      this.timer = undefined;
      return;
    }
    // Pastas abertas só viram repositório com a conta conectada.
    void this.setWatch({ repos: this.marked, pastas: this.folders }).catch(() => undefined);
  }

  /** Consulta o GitHub agora e devolve o retrato. `manual` ignora o interruptor automático. */
  async refresh(manual = true): Promise<CiStatus> {
    const recent =
      this.lastPollAt !== undefined && this.now() - this.lastPollAt < MIN_MANUAL_GAP_MS;
    if (manual && recent && !this.polling) return this.status();
    await this.poll();
    return this.status();
  }

  private mayPoll(): boolean {
    return this.options.source.connected && this.watched.length > 0;
  }

  private reschedule(immediately = false): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.disposed || !this.automatic || !this.mayPoll()) return;
    const delay = immediately ? 0 : this.delay();
    this.timer = (this.options.schedule ?? defaultSchedule)(() => {
      this.timer = undefined;
      void this.poll();
    }, delay);
  }

  /** Quanto falta até a próxima consulta automática (para os testes e para o retrato). */
  delay(): number {
    const now = this.now();
    const runs = [...this.repos.values()].flatMap((r) => r.runs);
    const limitedUntil = this.options.source.limitedUntil();
    return nextDelayMs({
      active: runs.some((r) => isActive(r.estado)),
      sinceChangeMs: this.lastChangeAt === undefined ? undefined : now - this.lastChangeAt,
      failures: this.failures,
      ...(limitedUntil === undefined ? {} : { limitedUntil }),
      now,
    });
  }

  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = undefined;
      this.reschedule();
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    if (!this.mayPoll()) return;
    const generation = this.generation;
    const targets = [...this.watched];
    const results = await Promise.all(
      targets.map(async (target): Promise<CiRepoStatus> => {
        try {
          return { ...target, runs: await this.readRepo(target.repo) };
        } catch (error) {
          // A mensagem do cliente já é a explicação para o usuário e não leva o token.
          const previous = this.repos.get(target.repo);
          return { ...target, runs: previous?.runs ?? [], erro: message(error) };
        }
      }),
    );
    // Quem acompanhar mudou no meio da consulta: o resultado é de outra lista.
    if (generation !== this.generation || this.disposed) return;
    this.lastPollAt = this.now();
    this.failures = results.length > 0 && results.every((r) => r.erro) ? this.failures + 1 : 0;
    this.repos = new Map(results.map((r) => [r.repo, r]));
    this.updatedAt = new Date(this.now()).toISOString();
    const all = results.flatMap((r) => r.runs);
    const changed = changedRuns(this.seen, all);
    if (changed.length > 0) this.lastChangeAt = this.now();
    for (const run of changed) {
      this.options.bus.publish<CiRunEventData>('ci.run', `${run.repo}#${String(run.id)}`, run);
    }
    this.options.log?.(
      `ci: ${String(results.length)} repo(s), ${String(all.length)} run(s), ${String(changed.length)} change(s)`,
    );
  }

  private async readRepo(full: string): Promise<CiRun[]> {
    const [owner, name] = full.split('/');
    if (!owner || !name) return [];
    const ref: GhRepoRef = { owner, name };
    const raw = await this.options.source.runs(ref, RUNS_PER_REPO);
    const ordered = [...raw].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
    );
    const runs: CiRun[] = [];
    let withJobs = 0;
    for (const run of ordered) {
      let jobs: GhJob[] = [];
      if (withJobs < JOBS_FOR_RUNS) {
        withJobs++;
        const key = `${full}#${String(run.id)}`;
        const state = toCiRun(full, run).estado;
        const cached = this.jobCache.get(key);
        if (cached?.estado === state && !isActive(state)) {
          jobs = cached.jobs;
        } else {
          jobs = [...(await this.options.source.jobs(ref, run.id).catch(() => cached?.jobs ?? []))];
          this.jobCache.set(key, { estado: state, jobs });
        }
      }
      runs.push(toCiRun(full, run, jobs));
    }
    // Esquece jobs de execuções que saíram da janela.
    const live = new Set(ordered.map((r) => `${full}#${String(r.id)}`));
    for (const key of [...this.jobCache.keys()]) {
      if (key.startsWith(`${full}#`) && !live.has(key)) this.jobCache.delete(key);
    }
    return newestFirst(runs);
  }

  register(router: Router): void {
    router.register('ci.status', async (params) => {
      const p = params === undefined || params === null ? {} : objectParams(params);
      const wanted = (p as CiStatusParams).atualizar === true;
      return wanted ? await this.refresh(true) : this.status();
    });
    router.register('ci.watch.set', async (params) => {
      const p = objectParams(params);
      return await this.setWatch({
        ...(Array.isArray(p.repos) ? { repos: p.repos as string[] } : {}),
        ...(Array.isArray(p.pastas) ? { pastas: p.pastas as string[] } : {}),
        ...(typeof p.automatico === 'boolean' ? { automatico: p.automatico } : {}),
      });
    });
  }
}
