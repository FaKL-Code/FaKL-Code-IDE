import type { Sala } from './sala';

/*
 * As cenas são as composições do filme de apresentação (1920x1080 e 1080x1920),
 * com a mesma linha do tempo em segundos. Aqui a rolagem faz o papel do relógio.
 */

/** Monta a linha do tempo pausada de uma cena a partir do seu elemento. */
export type Montar = (root: HTMLElement, sala: Sala) => gsap.core.Timeline;

export interface Cena {
  readonly id: string;
  /** Duração no filme, em segundos. */
  readonly dur: number;
  readonly montar: Montar;
}

export function q(root: ParentNode, sel: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`cena sem ${sel}`);
  return el;
}

export function qsvg(root: ParentNode, sel: string): SVGGeometryElement {
  const el = root.querySelector<SVGGeometryElement>(sel);
  if (!el) throw new Error(`cena sem ${sel}`);
  return el;
}

export function grade(el: HTMLElement, n: number): HTMLElement[] {
  for (let i = 0; i < n; i++) el.appendChild(document.createElement('i'));
  return [...el.children] as HTMLElement[];
}

/** Posiciona um vídeo no tempo da cena; só busca quando muda de quadro. */
export function videoEm(video: HTMLVideoElement, t: number, dur: number): void {
  const alvo = Math.max(0, Math.min(dur - 0.04, t));
  if (Math.abs(video.currentTime - alvo) > 1 / 40) video.currentTime = alvo;
}

/** Gerador com semente fixa (o mesmo do filme), para a digitação humana. */
export function lcg(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}
