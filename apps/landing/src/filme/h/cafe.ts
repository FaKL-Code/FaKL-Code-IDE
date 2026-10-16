import { gsap } from 'gsap';

import { q, type Montar } from '../util';

// Tela do monitor do Codex no espaço 6x da sala (paralelogramo isométrico).
export const QUAD = { x: 1866, y: 884, w: 144, dy: 72, h: 94 } as const;
export const MON = { cx: QUAD.x + QUAD.w / 2, cy: QUAD.y + QUAD.dy / 2 + QUAD.h / 2 } as const;
/** Um enquadramento fixo da sala, no espaço 6x: centro e escala. */
export interface Quadro {
  readonly t: number;
  readonly cx: number;
  readonly cy: number;
  readonly s: number;
}

/**
 * Três quadros parados da sala, um por passo do texto: as mesas, a tela de um
 * agente e o bebedouro. Cada um respira devagar (um zoom de 4%) e o corte é seco.
 */
export const QUADROS_H: readonly Quadro[] = [
  { t: 0, cx: 2140, cy: 1090, s: 0.62 },
  { t: 5.2, cx: MON.cx + 330, cy: MON.cy + 40, s: 1.9 },
  { t: 10.0, cx: 2060, cy: 930, s: 1.15 },
];

/** Marcas das linhas da tela do Codex no segundo quadro; os textos (fictícios) ficam em src/i18n. */
export const MARCAS_TELA = ['›', '$', '✓', '→'] as const;

/** Quadro da vez, com a respiração e o tempo desde o corte. */
export function quadroEm(
  quadros: readonly Quadro[],
  fim: number,
  t: number,
): { q: Quadro; s: number; desde: number; i: number } {
  let i = 0;
  while (i < quadros.length - 1 && t >= (quadros[i + 1]?.t ?? Infinity)) i++;
  const q = quadros[i];
  if (!q) throw new Error('sem quadros');
  const ate = quadros[i + 1]?.t ?? fim;
  const u = Math.min(1, Math.max(0, (t - q.t) / (ate - q.t)));
  return { q, s: q.s * (1 + 0.04 * u), desde: t - q.t, i };
}

/** Digita as linhas da tela conforme o tempo do quadro. */
export function digitarTela(linhas: HTMLElement[], desde: number): void {
  linhas.forEach((el, k) => {
    const a = 0.5 + k * 1.0;
    el.style.opacity = desde >= a ? '1' : '0';
    el.style.transform = desde >= a ? 'none' : 'translateY(8px)';
  });
}

/** 6,3–21,5 s: as mesas, a tela do Codex e o Claude indo ao bebedouro. */
export const cafe: Montar = (root, sala) => {
  const cam = q(root, '#cf-cam');
  const tela = q(root, '#cf-tela');
  const linhas = [...tela.querySelectorAll<HTMLElement>('li')];
  const foco = q(root, '#cf-foco');
  const tl = gsap.timeline({ paused: true });
  tl.set({}, {}, 15.158);

  let antes = 0;
  const aplicar = (t: number): void => {
    const { q: f, s, desde, i } = quadroEm(QUADROS_H, 15.158, t);
    cam.style.transform = `translate(${960 - f.cx * s}px, ${540 - f.cy * s}px) scale(${s})`;
    tela.style.opacity = i === 1 ? '1' : '0';
    foco.style.opacity = i === 1 ? '1' : '0';
    digitarTela(linhas, i === 1 ? desde : -1);
  };
  // O Claude conclui e vai ao bebedouro no último quadro; voltando, volta a trabalhar.
  tl.eventCallback('onUpdate', () => {
    const t = tl.time();
    sala.colocar(cam, 11);
    if (antes < 10.2 && t >= 10.2) sala.concluir();
    if (antes < 10.8 && t >= 10.8) sala.irAgua();
    if (t < 9.6 && antes >= 9.6) sala.trabalhar();
    antes = t;
    aplicar(t);
  });
  aplicar(0);
  return tl;
};
