import { l10n } from '@fakl/i18n';

/*
 * Navegação por teclado e anúncios do grafo do vault. Lógica pura: o grafo
 * entrega posições e ligações, e aqui saem a próxima nota, o zoom e a frase
 * lida pelo leitor de tela.
 */

export type Direction = 'left' | 'right' | 'up' | 'down';

export interface NavNode {
  readonly path: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 6;
export const ZOOM_STEP = 1.25;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Zoom de um passo do teclado: `+` aproxima, `-` afasta. */
export function zoomStep(scale: number, direction: 'in' | 'out'): number {
  return clampScale(direction === 'in' ? scale * ZOOM_STEP : scale / ZOOM_STEP);
}

/**
 * Ordem da lista: título sem diferenciar maiúsculas e acentos, e o caminho
 * desempata. É a ordem do Page Down e do Page Up.
 */
export function sortNodes<T extends Pick<NavNode, 'path' | 'title'>>(nodes: readonly T[]): T[] {
  return [...nodes].sort(
    (a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
      a.path.localeCompare(b.path),
  );
}

/** A nota seguinte (ou anterior) na lista ordenada, sem dar a volta; sem foco, a primeira ou a última. */
export function stepInList<T extends Pick<NavNode, 'path'>>(
  sorted: readonly T[],
  from: string | undefined,
  delta: 1 | -1,
): T | undefined {
  if (sorted.length === 0) return undefined;
  const index = from === undefined ? -1 : sorted.findIndex((n) => n.path === from);
  if (index < 0) return delta === 1 ? sorted[0] : sorted[sorted.length - 1];
  return sorted[Math.min(sorted.length - 1, Math.max(0, index + delta))];
}

const VECTORS: Record<Direction, { x: number; y: number }> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

/** Abertura do cone de busca: a nota tem de estar a até 60 graus do eixo da seta. */
const CONE_COS = Math.cos(Math.PI / 3);

/**
 * Para onde a seta leva o foco: a nota mais próxima dentro de um cone de 60
 * graus na direção da seta. Notas ligadas à atual ganham desconto na distância,
 * então a seta segue os links quando há um no caminho. Sem nota na direção,
 * devolve `undefined` e o foco fica onde está.
 */
export function moveFocus<T extends NavNode>(
  from: T,
  candidates: readonly T[],
  direction: Direction,
  linked: ReadonlySet<string> = new Set(),
): T | undefined {
  const axis = VECTORS[direction];
  let best: T | undefined;
  let bestScore = Infinity;
  for (const node of candidates) {
    if (node.path === from.path) continue;
    const dx = node.x - from.x;
    const dy = node.y - from.y;
    const distance = Math.hypot(dx, dy);
    // Notas no mesmo ponto não têm direção: contam como "à direita" e "abaixo", só para serem alcançáveis.
    const cos =
      distance === 0
        ? direction === 'right' || direction === 'down'
          ? 1
          : -1
        : (dx * axis.x + dy * axis.y) / distance;
    if (cos < CONE_COS) continue;
    // Quanto mais fora do eixo, mais "longe" a nota conta.
    const score = (distance / cos) * (linked.has(node.path) ? 0.5 : 1);
    if (score < bestScore || (score === bestScore && node.path < (best?.path ?? ''))) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

/** Quantos links são nomeados no anúncio; o resto vira "e mais N". */
export const ANNOUNCE_LINKS = 5;

export interface NodeSummary {
  readonly title: string;
  readonly folder: string;
  /** Títulos das notas ligadas, já ordenados. */
  readonly links: readonly string[];
}

/** Frase lida ao focar uma nota: título, pasta e links. */
export function describeNode(node: NodeSummary): string {
  const parts = [node.title];
  if (node.folder) parts.push(l10n.t('folder {0}', node.folder));
  if (node.links.length === 0) {
    parts.push(l10n.t('no links'));
  } else {
    const shown = node.links.slice(0, ANNOUNCE_LINKS);
    const more = node.links.length - shown.length;
    const count =
      node.links.length === 1 ? l10n.t('1 link') : l10n.t('{0} links', node.links.length);
    const names =
      more > 0 ? `${shown.join(', ')}, ${l10n.t('and {0} more', more)}` : shown.join(', ');
    parts.push(`${count}: ${names}`);
  }
  return parts.join('. ');
}

/** Rótulo do alvo focável do canvas, com o total de notas e links. */
export function describeGraph(notes: number, links: number): string {
  const n = notes === 1 ? l10n.t('1 note') : l10n.t('{0} notes', notes);
  const l = links === 1 ? l10n.t('1 link') : l10n.t('{0} links', links);
  return l10n.t('Graph of vault notes, {0}, {1}', n, l);
}
