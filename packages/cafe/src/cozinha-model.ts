import { l10n } from '@fakl/i18n';
import type { CiJob, CiRun, CiState, CiStatus } from '@fakl/protocol';

/*
 * Cozinha do CI (ADR 0051), lógica pura: qual pose o cozinheiro faz, quais
 * execuções aparecem na bancada, o texto para leitor de tela e o anúncio
 * agrupado. Sem DOM nem Canvas; quem desenha é `cozinha.ts`.
 */

/** Cozinheiros na bancada ao mesmo tempo. */
export const KITCHEN_MAX = 8;
/** Xícaras (jobs) desenhadas por bancada; o resto vira "+N". */
export const CUPS_MAX = 5;
/** Execução terminada some da bancada depois disto, se não houver lugar vazio a preencher. */
export const KEEP_DONE_MS = 6 * 3_600_000;

/** Rótulo curto do estado, para leitor de tela e cartões. */
export function ciStateText(state: CiState): string {
  switch (state) {
    case 'fila':
      return l10n.t('queued');
    case 'trabalhando':
      return l10n.t('running');
    case 'aguardando':
      return l10n.t('waiting for approval');
    case 'sucesso':
      return l10n.t('passed');
    case 'falha':
      return l10n.t('failed');
    case 'cancelada':
      return l10n.t('cancelled');
  }
}

/** O que a bancada mostra para cada estado: pose do cozinheiro, adereço e quadro da xícara. */
export interface StationLook {
  /** Quadro do sprite `kitchen-cook`; `undefined` = bancada vazia (avental no gancho). */
  readonly cook: number | undefined;
  readonly prop: 'bell' | 'alarm' | 'ticket' | 'steam' | undefined;
  readonly mood: 'work' | 'wait' | 'ok' | 'bad' | 'off';
}

/**
 * Pose do estado no instante `tick` (um número que cresce com o tempo). Com
 * `reduced`, nada alterna: o estado se lê de uma imagem parada.
 */
export function stationLook(state: CiState, tick: number, reduced = false): StationLook {
  const phase = reduced ? 0 : tick % 2;
  switch (state) {
    case 'trabalhando':
      return { cook: 1 + phase, prop: 'steam', mood: 'work' };
    case 'sucesso':
      return { cook: 3, prop: 'bell', mood: 'ok' };
    case 'falha':
      return { cook: 4, prop: 'alarm', mood: 'bad' };
    case 'aguardando':
      return { cook: 0, prop: 'ticket', mood: 'wait' };
    case 'fila':
      return { cook: 0, prop: undefined, mood: 'wait' };
    case 'cancelada':
      return { cook: undefined, prop: undefined, mood: 'off' };
  }
}

/** Quadro do sprite `kitchen-cup` de um job. */
export function cupFrame(state: CiState, tick = 0, reduced = false): number {
  switch (state) {
    case 'fila':
      return 0;
    case 'trabalhando':
      // Enche e esvazia um pouco: o café saindo.
      return reduced || tick % 2 === 0 ? 1 : 0;
    case 'sucesso':
      return 2;
    case 'falha':
      return 3;
    case 'cancelada':
      return 4;
    case 'aguardando':
      return 5;
  }
}

const PRIORITY: Record<CiState, number> = {
  aguardando: 0,
  falha: 1,
  trabalhando: 2,
  fila: 3,
  sucesso: 4,
  cancelada: 5,
};

export function runKey(run: Pick<CiRun, 'repo' | 'id'>): string {
  return `${run.repo}#${String(run.id)}`;
}

/** Junta as execuções de todos os repositórios, sem repetir. */
export function allRuns(status: CiStatus | undefined): CiRun[] {
  const byKey = new Map<string, CiRun>();
  for (const repo of status?.repos ?? []) for (const run of repo.runs) byKey.set(runKey(run), run);
  return [...byKey.values()];
}

/**
 * Quais execuções ficam na bancada: só a mais recente de cada fluxo (workflow
 * no mesmo branch), as terminadas há muito tempo saem, e a ordem põe primeiro
 * o que pede atenção (aprovação, falha), depois o que roda, depois o resto.
 */
export function kitchenRuns(runs: readonly CiRun[], now: number, max = KITCHEN_MAX): CiRun[] {
  const latest = new Map<string, CiRun>();
  const ordered = [...runs].sort(
    (a, b) => Date.parse(b.inicio) - Date.parse(a.inicio) || b.id - a.id,
  );
  for (const run of ordered) {
    const flow = `${run.repo}|${run.nome}|${run.branch ?? ''}`;
    if (!latest.has(flow)) latest.set(flow, run);
  }
  return [...latest.values()]
    .filter((run) => {
      if (run.estado === 'trabalhando' || run.estado === 'aguardando' || run.estado === 'fila')
        return true;
      const end = Date.parse(run.fim ?? run.inicio);
      return !Number.isFinite(end) || now - end < KEEP_DONE_MS;
    })
    .sort(
      (a, b) =>
        PRIORITY[a.estado] - PRIORITY[b.estado] ||
        Date.parse(b.inicio) - Date.parse(a.inicio) ||
        b.id - a.id,
    )
    .slice(0, max);
}

/** Troca ou acrescenta uma execução que chegou por evento `ci.run`. */
export function mergeRun(status: CiStatus, run: CiRun): CiStatus {
  const repos = status.repos.map((repo) => {
    if (repo.repo !== run.repo) return repo;
    const others = repo.runs.filter((r) => r.id !== run.id);
    return { ...repo, runs: [run, ...others].slice(0, 20) };
  });
  return { ...status, repos };
}

/** Duração em segundos de uma execução (até agora, se ainda roda); `undefined` sem datas válidas. */
export function runSeconds(
  run: Pick<CiRun, 'inicio' | 'fim' | 'estado'>,
  now: number,
): number | undefined {
  const start = Date.parse(run.inicio);
  if (!Number.isFinite(start)) return undefined;
  const live = run.estado === 'trabalhando' || run.estado === 'fila' || run.estado === 'aguardando';
  const end = live ? now : Date.parse(run.fim ?? '');
  if (!Number.isFinite(end)) return undefined;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** "1m 05s", "12s" ou "1h 03m", para os cartões e o leitor de tela. */
export function formatSeconds(total: number | undefined): string {
  if (total === undefined) return '';
  if (total < 60) return `${String(total)}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Duração na fonte de pixel, que só tem dígitos, ":" e "H": "1:05" (min:s),
 * "12:30" ou "1H03" para uma hora ou mais.
 */
export function pixelClock(total: number | undefined): string {
  if (total === undefined) return '-:--';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes)}:${String(total % 60).padStart(2, '0')}`;
  return `${String(Math.floor(minutes / 60))}H${String(minutes % 60).padStart(2, '0')}`;
}

/** Resumo dos jobs: "2 of 3 jobs passed". */
export function describeJobs(jobs: readonly CiJob[]): string {
  if (jobs.length === 0) return '';
  const passed = jobs.filter((j) => j.estado === 'sucesso').length;
  return l10n.t('{0} of {1} jobs passed', String(passed), String(jobs.length));
}

/** Texto do item da lista: "build on main in acme/app, failed, 1m 05s, 2 of 3 jobs passed". */
export function describeRun(run: CiRun, now: number): string {
  const where = run.branch ? `${run.nome} (${run.branch})` : run.nome;
  const parts = [
    `${where}, ${run.repo}`,
    ciStateText(run.estado),
    formatSeconds(runSeconds(run, now)),
    describeJobs(run.jobs),
  ].filter(Boolean);
  return parts.join(', ');
}

/** Resumo da cozinha para o `aria-label`: "CI: 1 failing, 2 running, 7 green in a row". */
export function describeKitchen(status: CiStatus | undefined): string {
  if (!status || status.repos.length === 0) return '';
  const parts = [
    l10n.t('{0} failing', String(status.falhando)),
    l10n.t('{0} running', String(status.trabalhando)),
    l10n.t('{0} green in a row', String(status.verdesSeguidos)),
  ];
  return `${l10n.t('CI kitchen')}: ${parts.join(', ')}`;
}

/** Só estes estados valem um anúncio: o resultado e a espera por você. */
type Announced = 'aguardando' | 'falha' | 'sucesso';

function announced(state: CiState): Announced | undefined {
  return state === 'aguardando' || state === 'falha' || state === 'sucesso' ? state : undefined;
}

const ANNOUNCE_ORDER: Announced[] = ['aguardando', 'falha', 'sucesso'];

export interface RunAnnouncerOptions {
  /** Intervalo mínimo entre dois anúncios, em ms. */
  readonly minIntervalMs?: number;
  /** Quantas execuções por estado têm o nome dito; o resto vira só a contagem. */
  readonly maxNames?: number;
}

/**
 * Junta os resultados das execuções e libera uma frase de cada vez, no
 * máximo a cada `minIntervalMs`: "failed: build on main in acme/app; 2 CI runs
 * passed". A primeira leitura só fixa o ponto de partida; execução que
 * começou ou entrou na fila não é anunciada (seria ruído); só o último estado
 * de cada uma conta, e uma mudança que volta ao que já foi dito some.
 */
export class RunAnnouncer {
  private readonly minIntervalMs: number;
  private readonly maxNames: number;
  private readonly said = new Map<string, CiState>();
  private readonly pending = new Map<string, { run: CiRun; state: Announced }>();
  private seeded = false;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(options: RunAnnouncerOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 4_000;
    this.maxNames = options.maxNames ?? 2;
  }

  /** Compara as execuções atuais com as da leitura anterior. */
  observe(runs: readonly CiRun[]): void {
    for (const run of runs) {
      const key = runKey(run);
      const kind = announced(run.estado);
      if (!this.seeded) {
        this.said.set(key, run.estado);
        continue;
      }
      const before = this.said.get(key);
      if (before === run.estado) {
        // Voltou ao que já foi dito: nada a anunciar.
        this.pending.delete(key);
        continue;
      }
      if (kind === undefined) {
        // Começou, entrou na fila ou foi cancelada: não se anuncia, só se lembra.
        this.pending.delete(key);
        this.said.set(key, run.estado);
        continue;
      }
      this.pending.set(key, { run, state: kind });
    }
    this.seeded = true;
  }

  get waiting(): boolean {
    return this.pending.size > 0;
  }

  waitMs(now: number): number | undefined {
    if (this.pending.size === 0) return undefined;
    return Math.max(0, this.lastAt + this.minIntervalMs - now);
  }

  take(now: number): string | undefined {
    if (this.pending.size === 0 || now - this.lastAt < this.minIntervalMs) return undefined;
    const groups = new Map<Announced, CiRun[]>();
    for (const { run, state } of this.pending.values()) {
      groups.set(state, [...(groups.get(state) ?? []), run]);
      this.said.set(runKey(run), run.estado);
    }
    this.pending.clear();
    this.lastAt = now;
    const phrases: string[] = [];
    for (const state of ANNOUNCE_ORDER) {
      const runs = groups.get(state);
      if (!runs) continue;
      const label = ciStateText(state);
      if (runs.length <= this.maxNames) {
        phrases.push(...runs.map((run) => l10n.t('{0} in {1}: {2}', run.nome, run.repo, label)));
      } else {
        phrases.push(l10n.t('{0} CI runs {1}', String(runs.length), label));
      }
    }
    return phrases.join('; ');
  }
}

/** Fala de vários anunciantes numa só região `aria-live`, sem uma pisar na outra. */
export interface Speaker {
  waitMs(now: number): number | undefined;
  take(now: number): string | undefined;
}

export class AnnouncerGroup implements Speaker {
  private readonly speakers: readonly Speaker[];

  constructor(...speakers: readonly Speaker[]) {
    this.speakers = speakers;
  }

  waitMs(now: number): number | undefined {
    const waits = this.speakers
      .map((s) => s.waitMs(now))
      .filter((w): w is number => w !== undefined);
    return waits.length === 0 ? undefined : Math.min(...waits);
  }

  take(now: number): string | undefined {
    const texts = this.speakers.map((s) => s.take(now)).filter((t): t is string => Boolean(t));
    return texts.length === 0 ? undefined : texts.join('. ');
  }
}

/** Disposição das bancadas: colunas, linhas e o tamanho do quadro lógico em pixels. */
export const CELL_W = 72;
export const CELL_H = 92;
export const HEADER_H = 16;
const COLUMNS_MAX = 4;

export function kitchenLayout(count: number): {
  columns: number;
  rows: number;
  width: number;
  height: number;
} {
  const columns = Math.min(COLUMNS_MAX, Math.max(2, count));
  const rows = Math.max(1, Math.ceil(count / columns));
  return { columns, rows, width: columns * CELL_W, height: HEADER_H + rows * CELL_H };
}

/** Índice da bancada sob um ponto do quadro lógico, ou `undefined`. */
export function cellAt(x: number, y: number, count: number): number | undefined {
  const { columns } = kitchenLayout(count);
  if (y < HEADER_H || x < 0) return undefined;
  const column = Math.floor(x / CELL_W);
  if (column >= columns) return undefined;
  const index = Math.floor((y - HEADER_H) / CELL_H) * columns + column;
  return index >= 0 && index < count ? index : undefined;
}
