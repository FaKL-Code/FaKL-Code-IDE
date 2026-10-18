import { l10n } from '@fakl/i18n';
import type { AgentState } from '@fakl/protocol';

/*
 * Texto e ritmo dos anúncios do café para leitor de tela. Lógica pura, sem DOM:
 * quem hospeda a sala (painel da IDE e app do celular) entrega os agentes de
 * tempos em tempos e escreve o texto devolvido numa região `aria-live=polite`.
 */

/** O que o leitor de tela distingue; pensar e executar são o mesmo "trabalhando". */
export type StatusKind =
  | 'chegando'
  | 'trabalhando'
  | 'ocioso'
  | 'permissao'
  | 'voce'
  | 'pausado'
  | 'intervalo'
  | 'falhou'
  | 'parado'
  | 'limite';

export function statusKind(state: AgentState, limited = false): StatusKind {
  // Limite estourado vale mais que o estado: o agente está parado esperando você liberar.
  if (limited && state !== 'falhou' && state !== 'parado' && state !== 'concluído') return 'limite';
  switch (state) {
    case 'preparando':
      return 'chegando';
    case 'pensando':
    case 'executando':
      return 'trabalhando';
    case 'ocioso':
      return 'ocioso';
    case 'aguardando-permissão':
      return 'permissao';
    case 'aguardando-você':
      return 'voce';
    case 'pausado':
      return 'pausado';
    case 'concluído':
      return 'intervalo';
    case 'falhou':
      return 'falhou';
    case 'parado':
      return 'parado';
  }
}

export function statusText(kind: StatusKind): string {
  switch (kind) {
    case 'chegando':
      return l10n.t('arriving');
    case 'trabalhando':
      return l10n.t('working');
    case 'ocioso':
      return l10n.t('idle');
    case 'permissao':
      return l10n.t('asking permission');
    case 'voce':
      return l10n.t('waiting for you');
    case 'pausado':
      return l10n.t('paused');
    case 'intervalo':
      return l10n.t('on a break');
    case 'falhou':
      return l10n.t('failed');
    case 'parado':
      return l10n.t('stopped');
    case 'limite':
      return l10n.t('limit reached');
  }
}

/** Quanto antes o leitor deve ouvir: quem precisa de você vem primeiro. */
const URGENCY: Record<StatusKind, number> = {
  permissao: 0,
  voce: 0,
  falhou: 1,
  limite: 1,
  pausado: 2,
  parado: 2,
  intervalo: 3,
  ocioso: 3,
  chegando: 4,
  trabalhando: 4,
};

/** Um agente como a lista do café o descreve. */
export interface SeatInfo {
  readonly id: string;
  readonly name: string;
  readonly state: AgentState;
  readonly limited: boolean;
  /** Papel ou título da tela, quando houver. */
  readonly detail?: string;
}

/** Texto do item da lista: "Ana, working, writing tests". */
export function describeSeat(seat: SeatInfo): string {
  const status = statusText(statusKind(seat.state, seat.limited));
  return seat.detail ? `${seat.name}, ${status}, ${seat.detail}` : `${seat.name}, ${status}`;
}

/** Resumo da sala: "3 agents: 1 working, 2 waiting for you". */
export function describeRoom(seats: readonly SeatInfo[], offline = false): string {
  if (offline) return l10n.t('Café disconnected.');
  if (seats.length === 0) return l10n.t('Nobody in the café.');
  const counts = new Map<StatusKind, number>();
  for (const seat of seats) {
    const kind = statusKind(seat.state, seat.limited);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => URGENCY[a[0]] - URGENCY[b[0]])
    .map(([kind, count]) => `${String(count)} ${statusText(kind)}`);
  const head = seats.length === 1 ? l10n.t('1 agent') : l10n.t('{0} agents', String(seats.length));
  return `${head}: ${parts.join(', ')}`;
}

export interface AnnouncerOptions {
  /** Intervalo mínimo entre dois anúncios, em ms. */
  readonly minIntervalMs?: number;
  /** Quantos agentes entram numa mensagem; o resto vira "e mais N". */
  readonly maxNames?: number;
}

interface Pending {
  readonly name: string;
  readonly kind: StatusKind | 'saiu';
}

/**
 * Junta as mudanças de estado e libera uma frase de cada vez, no máximo a cada
 * `minIntervalMs`. Só o último estado de cada agente conta, e uma mudança que
 * volta ao que já foi dito some. A primeira leitura só fixa o ponto de partida.
 */
export class Announcer {
  private readonly minIntervalMs: number;
  private readonly maxNames: number;
  /** O que o leitor já ouviu (ou o ponto de partida) por agente. */
  private readonly said = new Map<string, { kind: StatusKind; name: string }>();
  private readonly pending = new Map<string, Pending>();
  private seeded = false;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(options: AnnouncerOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 4_000;
    this.maxNames = options.maxNames ?? 3;
  }

  /** Compara a sala atual com a anterior. */
  observe(seats: readonly SeatInfo[]): void {
    const seen = new Set<string>();
    for (const seat of seats) {
      seen.add(seat.id);
      const kind = statusKind(seat.state, seat.limited);
      if (!this.seeded) {
        this.said.set(seat.id, { kind, name: seat.name });
        continue;
      }
      if (this.said.get(seat.id)?.kind === kind) this.pending.delete(seat.id);
      else this.pending.set(seat.id, { name: seat.name, kind });
    }
    for (const [id, last] of this.said) {
      if (seen.has(id) || !this.seeded) continue;
      if (last.kind === 'intervalo' || last.kind === 'parado' || last.kind === 'falhou') {
        // Já tinha terminado; sair da sala não é novidade.
        this.said.delete(id);
        this.pending.delete(id);
      } else this.pending.set(id, { name: last.name, kind: 'saiu' });
    }
    this.seeded = true;
  }

  /** Há algo esperando para ser dito. */
  get waiting(): boolean {
    return this.pending.size > 0;
  }

  /** Milissegundos até o próximo anúncio poder sair; `undefined` se não há nada. */
  waitMs(now: number): number | undefined {
    if (this.pending.size === 0) return undefined;
    return Math.max(0, this.lastAt + this.minIntervalMs - now);
  }

  /** A frase do momento, ou `undefined` se não há nada ou ainda é cedo. */
  take(now: number): string | undefined {
    if (this.pending.size === 0 || now - this.lastAt < this.minIntervalMs) return undefined;
    const entries = [...this.pending.entries()].sort(
      (a, b) => urgency(a[1].kind) - urgency(b[1].kind) || a[1].name.localeCompare(b[1].name),
    );
    this.pending.clear();
    this.lastAt = now;
    for (const [id, change] of entries) {
      if (change.kind === 'saiu') this.said.delete(id);
      else this.said.set(id, { kind: change.kind, name: change.name });
    }
    const shown = entries.slice(0, this.maxNames).map(([, change]) => phrase(change));
    const more = entries.length - shown.length;
    if (more > 0) shown.push(l10n.t('and {0} more changes', String(more)));
    return shown.join('; ');
  }
}

function urgency(kind: StatusKind | 'saiu'): number {
  return kind === 'saiu' ? 5 : URGENCY[kind];
}

function phrase(change: Pending): string {
  return change.kind === 'saiu'
    ? l10n.t('{0} left the café', change.name)
    : `${change.name}: ${statusText(change.kind)}`;
}
