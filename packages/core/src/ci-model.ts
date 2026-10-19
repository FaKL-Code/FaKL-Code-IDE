import type { CiJob, CiRun, CiState } from '@fakl/protocol';

/*
 * Lógica pura do café do CI (ADR 0051): tradução do GitHub para o estado do
 * personagem, intervalo adaptativo, limite de repositórios, deduplicação de
 * eventos e "builds verdes seguidos". Sem rede, sem relógio e sem estado.
 */

/** Repositórios acompanhados ao mesmo tempo; cada um custa pelo menos uma consulta por rodada. */
export const MAX_WATCHED_REPOS = 5;
/** Execuções lidas por repositório a cada consulta. */
export const RUNS_PER_REPO = 10;
/** Execuções por repositório cujos jobs são lidos (as mais recentes). */
export const JOBS_FOR_RUNS = 3;

/** Intervalos entre consultas, em ms. */
export const INTERVAL = {
  /** Há execução em andamento ou esperando. */
  active: 15_000,
  /** Terminou algo há pouco: confere se vem outra (um push seguido de outro). */
  settling: 45_000,
  /** Nada acontecendo. */
  idle: 300_000,
  /** Teto do recuo depois de erros seguidos. */
  maxBackoff: 900_000,
} as const;

/** Depois de uma mudança, o intervalo "assentando" vale por este tempo. */
export const SETTLING_FOR_MS = 120_000;

/** Estado do par `status`/`conclusion` do GitHub. */
export function ciState(status: string | null, conclusion: string | null): CiState {
  switch (status) {
    case 'completed':
      switch (conclusion) {
        case 'success':
        case 'neutral':
          return 'sucesso';
        case 'cancelled':
        case 'skipped':
        case 'stale':
          return 'cancelada';
        case 'action_required':
          return 'aguardando';
        default:
          // failure, timed_out, startup_failure e o que o GitHub inventar: não passou.
          return 'falha';
      }
    case 'in_progress':
      return 'trabalhando';
    case 'waiting':
      return 'aguardando';
    default:
      // queued, pending, requested e qualquer status novo: ainda não começou.
      return 'fila';
  }
}

/** Execução sem fim: ainda pode mudar. */
export function isActive(state: CiState): boolean {
  return state === 'fila' || state === 'trabalhando' || state === 'aguardando';
}

interface RawRun {
  readonly id: number;
  readonly name?: string | null;
  readonly display_title?: string;
  readonly head_branch: string | null;
  readonly event: string;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly run_number: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RawJob {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
}

export function toCiJob(job: RawJob): CiJob {
  return {
    id: job.id,
    nome: job.name,
    estado: ciState(job.status, job.conclusion),
    ...(job.started_at ? { inicio: job.started_at } : {}),
    ...(job.completed_at ? { fim: job.completed_at } : {}),
  };
}

export function toCiRun(repo: string, run: RawRun, jobs: readonly RawJob[] = []): CiRun {
  const state = ciState(run.status, run.conclusion);
  return {
    repo,
    id: run.id,
    numero: run.run_number,
    nome: run.name ?? run.display_title ?? `#${String(run.run_number)}`,
    ...(run.head_branch ? { branch: run.head_branch } : {}),
    evento: run.event,
    estado: state,
    url: run.html_url,
    inicio: run.created_at,
    ...(isActive(state) ? {} : { fim: run.updated_at }),
    jobs: jobs.map(toCiJob),
  };
}

/** O que a interface deve ver como "mudou": estado da execução e de cada job. */
export function runSignature(run: CiRun): string {
  return `${run.estado}|${run.jobs.map((job) => `${String(job.id)}:${job.estado}`).join(',')}`;
}

/**
 * Execuções que mudaram desde a última vez, para publicar `ci.run`. Atualiza
 * `seen` (chave `repo#id`, assinatura) e esquece o que saiu da janela, para o
 * mapa não crescer.
 */
export function changedRuns(seen: Map<string, string>, runs: readonly CiRun[]): CiRun[] {
  const changed: CiRun[] = [];
  const current = new Set<string>();
  for (const run of runs) {
    const key = `${run.repo}#${String(run.id)}`;
    current.add(key);
    const signature = runSignature(run);
    if (seen.get(key) === signature) continue;
    seen.set(key, signature);
    changed.push(run);
  }
  for (const key of [...seen.keys()]) if (!current.has(key)) seen.delete(key);
  return changed;
}

export interface WatchSelection {
  readonly repo: string;
  readonly origem: 'aberto' | 'marcado';
}

/**
 * Escolhe até `max` repositórios: os das pastas abertas primeiro, depois os
 * marcados, sem repetir (sem diferenciar maiúsculas). O que passa do limite
 * volta em `descartados` para a IDE avisar.
 */
export function limitRepos(
  opened: readonly string[],
  marked: readonly string[],
  max = MAX_WATCHED_REPOS,
): { watched: WatchSelection[]; descartados: string[] } {
  const watched: WatchSelection[] = [];
  const descartados: string[] = [];
  const seen = new Set<string>();
  const add = (repo: string, origem: WatchSelection['origem']): void => {
    const key = repo.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (watched.length < max) watched.push({ repo, origem });
    else descartados.push(repo);
  };
  for (const repo of opened) add(repo, 'aberto');
  for (const repo of marked) add(repo, 'marcado');
  return { watched, descartados };
}

export interface DelayInput {
  /** Há execução em andamento, na fila ou esperando aprovação. */
  readonly active: boolean;
  /** Milissegundos desde a última mudança observada; `undefined` se nunca houve. */
  readonly sinceChangeMs: number | undefined;
  /** Consultas seguidas que falharam. */
  readonly failures: number;
  /** Quando o limite da API volta (ms desde a época), se estourou. */
  readonly limitedUntil?: number;
  readonly now: number;
}

/**
 * Quanto esperar até a próxima consulta: rápido com execução ativa, médio logo
 * depois de uma mudança, lento ocioso; dobra a cada falha seguida e nunca
 * antes de o limite da API voltar.
 */
export function nextDelayMs(input: DelayInput): number {
  let base: number = INTERVAL.idle;
  if (input.active) base = INTERVAL.active;
  else if (input.sinceChangeMs !== undefined && input.sinceChangeMs < SETTLING_FOR_MS)
    base = INTERVAL.settling;
  if (input.failures > 0) {
    base = Math.min(INTERVAL.maxBackoff, base * 2 ** Math.min(input.failures, 6));
  }
  if (input.limitedUntil !== undefined && input.limitedUntil > input.now) {
    // Um pouco depois da virada, para não bater na porta no mesmo segundo.
    base = Math.max(base, input.limitedUntil - input.now + 2_000);
  }
  return base;
}

/** Chave de um fluxo: o mesmo workflow no mesmo branch, para ver só a execução mais recente. */
function flowKey(run: CiRun): string {
  return `${run.repo}|${run.nome}|${run.branch ?? ''}`;
}

/** Execuções mais recentes primeiro. */
export function newestFirst(runs: readonly CiRun[]): CiRun[] {
  return [...runs].sort((a, b) => Date.parse(b.inicio) - Date.parse(a.inicio) || b.id - a.id);
}

/** Fluxos cuja execução mais recente terminou em falha: some quando uma execução seguinte passa. */
export function failingCount(runs: readonly CiRun[]): number {
  const latest = new Map<string, CiRun>();
  for (const run of newestFirst(runs)) {
    // Execução ainda rodando ou cancelada não apaga a falha anterior: não tem resultado.
    if (isActive(run.estado) || run.estado === 'cancelada') continue;
    if (!latest.has(flowKey(run))) latest.set(flowKey(run), run);
  }
  return [...latest.values()].filter((run) => run.estado === 'falha').length;
}

/** Quantas execuções terminaram bem seguidas, da mais nova para trás; cancelada não quebra a série. */
export function greenStreak(runs: readonly CiRun[]): number {
  let streak = 0;
  for (const run of newestFirst(runs)) {
    if (isActive(run.estado) || run.estado === 'cancelada') continue;
    if (run.estado !== 'sucesso') break;
    streak++;
  }
  return streak;
}

/** Execuções em andamento agora. */
export function workingCount(runs: readonly CiRun[]): number {
  return runs.filter((run) => run.estado === 'trabalhando').length;
}

/** Repositório no formato `dono/nome`, ou `undefined`. */
export function parseWatchedRepo(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[\w.-]{1,100}$/.test(text) ? text : undefined;
}
