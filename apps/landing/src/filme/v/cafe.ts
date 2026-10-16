import { gsap } from 'gsap';

import { digitarTela, MON, quadroEm, type Quadro } from '../h/cafe';
import { q, type Montar } from '../util';

/** Câmera do café no quadro 9:16: o centro vertical fica preso para a sala cobrir a altura. */
function camera(cam: HTMLElement, C: { s: number; cx: number; cy: number }): () => void {
  return () => {
    const half = 960 / C.s;
    const cy = Math.min(2160 - half, Math.max(half, C.cy));
    cam.style.transform = `translate(${540 - C.cx * C.s}px, ${960 - cy * C.s}px) scale(${C.s})`;
  };
}

/** Os mesmos três quadros no 9:16; a tela do Codex fica embaixo da sala. */
const QUADROS_V: readonly Quadro[] = [
  { t: 0, cx: 2150, cy: 1080, s: 1.0 },
  { t: 3.4, cx: MON.cx + 40, cy: MON.cy + 330, s: 2.0 },
  { t: 6.6, cx: 2030, cy: 930, s: 1.5 },
];

/** 9:16, 6,3–16,4 s: as mesas, a tela do Codex e o Claude indo ao bebedouro. */
export const cafeV: Montar = (root, sala) => {
  const cam = q(root, '#vc-cam');
  const tela = q(root, '#vc-tela');
  const linhas = [...tela.querySelectorAll<HTMLElement>('li')];
  const foco = q(root, '#vc-foco');
  const C = { s: 1, cx: 2150, cy: 1080 };
  const apply = camera(cam, C);
  const tl = gsap.timeline({ paused: true });
  tl.set({}, {}, 10.105);
  let antes = 0;
  const aplicar = (t: number): void => {
    const { q: f, s, desde, i } = quadroEm(QUADROS_V, 10.105, t);
    Object.assign(C, { cx: f.cx, cy: f.cy, s });
    apply();
    tela.style.opacity = i === 1 ? '1' : '0';
    foco.style.opacity = i === 1 ? '1' : '0';
    digitarTela(linhas, i === 1 ? desde : -1);
  };
  tl.eventCallback('onUpdate', () => {
    const t = tl.time();
    sala.colocar(cam, 11);
    if (antes < 6.4 && t >= 6.4) sala.concluir();
    if (antes < 6.8 && t >= 6.8) sala.irAgua();
    if (t < 6.0 && antes >= 6.0) sala.trabalhar();
    antes = t;
    aplicar(t);
  });
  aplicar(0);
  return tl;
};

/** 9:16, 16,4–18,9 s: o antigo mergulho no monitor; a página corta direto para a Mesa. */
export const travV: Montar = () => gsap.timeline({ paused: true }).set({}, {}, 2.526);

export { camera };
