import { gsap } from 'gsap';

import { q, qsvg, type Montar } from '../util';

export interface Logo {
  readonly px: HTMLElement;
  readonly cx: number;
  readonly cy: number;
  readonly size: number;
  readonly raio: number;
  readonly abre: number;
  readonly passo: number;
  readonly yr: number;
}

/** Monta o logo: pixels convergem, bloco, terminal, `>_` por último, nome e assinatura. */
export function montarLogo(
  tl: gsap.core.Timeline,
  root: HTMLElement,
  p: string,
  L: number,
  logo: Logo,
): (t: number) => void {
  const pal = ['#06E0FF', '#2563EB', '#1D4ED8', '#5EEBFF'];
  for (let i = 0; i < 44; i++) {
    const el = document.createElement('i');
    el.style.background = pal[i % pal.length] ?? '#06E0FF';
    logo.px.appendChild(el);
    const a = (i * 137.508 * Math.PI) / 180;
    const r = logo.raio + ((i * 97) % logo.abre);
    const h = logo.size / 2;
    const tx = logo.cx - h + ((i % 7) - 3) * logo.passo;
    const ty = logo.cy - h + ((Math.floor(i / 7) % 6) - 3) * logo.passo;
    tl.fromTo(
      el,
      {
        x: logo.cx + Math.cos(a) * r,
        y: logo.cy + Math.sin(a) * r * logo.yr,
        opacity: 1,
        scale: 1,
      },
      { x: tx, y: ty, duration: 0.5, ease: 'steps(6)', immediateRender: false },
      L + 0.02 + (i % 11) * 0.012,
    );
    tl.to(el, { opacity: 0, scale: 0.2, duration: 0.12, ease: 'none' }, L + 0.6);
  }
  tl.fromTo(
    `#${p}-tilegrp`,
    { scale: 0.4, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.42, ease: 'steps(5)' },
    L + 0.45,
  );
  tl.fromTo(
    `#${p}-term`,
    { scale: 0.7, rotation: -10, opacity: 0, y: 40 },
    { scale: 1, rotation: 0, opacity: 1, y: 0, duration: 0.55, ease: 'back.out(1.7)' },
    L + 0.68,
  );
  const gt = qsvg(root, `#${p}-gt`);
  const us = qsvg(root, `#${p}-us`);
  const lg = gt.getTotalLength();
  const lu = us.getTotalLength();
  tl.fromTo(
    gt,
    { strokeDasharray: lg, strokeDashoffset: lg },
    { strokeDashoffset: 0, duration: 0.26, ease: 'power2.out' },
    L + 1.08,
  );
  tl.fromTo(
    us,
    { strokeDasharray: lu, strokeDashoffset: lu },
    { strokeDashoffset: 0, duration: 0.2, ease: 'power2.out' },
    L + 1.38,
  );
  tl.fromTo(
    `#${p}-glyphglow-g`,
    { opacity: 0 },
    { opacity: 0.8, duration: 0.25, ease: 'power2.out' },
    L + 1.45,
  );
  tl.fromTo(
    `#${p}-logo`,
    { scale: 1 },
    { scale: 1.06, duration: 0.1, ease: 'power2.out' },
    L + 1.55,
  );
  tl.to(`#${p}-logo`, { scale: 1, duration: 0.35, ease: 'back.out(2)' }, L + 1.65);

  // Nome: letras em cascata, "-IDE" no azul da marca.
  const word = q(root, `#${p}-word`);
  word.textContent = '';
  for (const ch of 'FaKL-Code') {
    const s = document.createElement('span');
    s.textContent = ch;
    word.appendChild(s);
  }
  const ide = document.createElement('span');
  ide.className = 'ide';
  ide.textContent = '-IDE';
  word.appendChild(ide);
  tl.fromTo(
    word.children,
    { opacity: 0, y: 46, rotationX: -70 },
    { opacity: 1, y: 0, rotationX: 0, duration: 0.42, ease: 'back.out(1.6)', stagger: 0.045 },
    L + 1.2,
  );

  const tagEl = q(root, `#${p}-tagtext`);
  const TAG = q(root, `#${p}-tagsrc`).textContent;
  tl.fromTo(
    `#${p}-tag .p`,
    { opacity: 0, scale: 0.5 },
    { opacity: 1, scale: 1, duration: 0.2, ease: 'back.out(3)' },
    L + 2.05,
  );
  tl.fromTo(
    `#${p}-os`,
    { opacity: 0, y: 14 },
    { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' },
    L + 3.25,
  );
  return (t) => {
    const n = Math.max(0, Math.min(TAG.length, Math.floor((t - L - 2.2) / 0.04)));
    tagEl.textContent = TAG.slice(0, n);
  };
}

/** 61,9–72 s: o logo real se monta sobre o café à noite; termina respirando. */
export const marca: Montar = (root, sala) => {
  const tl = gsap.timeline({ paused: true });
  const cafe = q(root, '#mk-cafe');
  const C = { s: 0.5, cx: 1920, cy: 1080 };
  const applyCafe = (): void => {
    cafe.style.transform = `translate(${960 - C.cx * C.s}px, ${540 - C.cy * C.s}px) scale(${C.s})`;
  };
  tl.fromTo(
    C,
    { s: 0.5 },
    { s: 0.53, duration: 10.105, ease: 'sine.inOut', immediateRender: false },
    0,
  );
  tl.fromTo('#mk-dim', { opacity: 0 }, { opacity: 1, duration: 0.35, ease: 'power2.out' }, 0);
  tl.fromTo(
    '#mk-halo',
    { opacity: 0, scale: 0.6 },
    { opacity: 1, scale: 1, duration: 0.9, ease: 'expo.out' },
    0.05,
  );
  const tag = montarLogo(tl, root, 'mk', 0, {
    px: q(root, '#mk-px'),
    cx: 960,
    cy: 285,
    size: 18,
    raio: 520,
    abre: 380,
    passo: 22,
    yr: 0.75,
  });
  const breathe = 10.105 - 3.6;
  tl.fromTo('#mk-lock', { scale: 1 }, { scale: 1.03, duration: breathe, ease: 'sine.inOut' }, 3.6);
  tl.fromTo(
    '#mk-halo',
    { scale: 1 },
    { scale: 1.12, duration: breathe, ease: 'sine.inOut', immediateRender: false },
    3.6,
  );
  tl.eventCallback('onUpdate', () => {
    sala.colocar(cafe, 21.5);
    applyCafe();
    tag(tl.time());
  });
  applyCafe();
  return tl;
};
