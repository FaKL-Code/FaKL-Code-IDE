import { gsap } from 'gsap';

import { montarLogo } from '../h/marca';
import { q, videoEm, type Montar } from '../util';
import { camera } from './cafe';

/** 9:16, 44,2–49,3 s: o celular aprova o Codex e abre o Café. */
export const celularV: Montar = (root, sala) => {
  const tl = gsap.timeline({ paused: true });
  const pwa = q(root, '#vp-pwa') as HTMLVideoElement;
  const BG = { cx: 2300 };
  const bg = q(root, '#vp-bg');
  const applyBg = (): void => {
    bg.style.transform = `translate(${540 - BG.cx}px, ${960 - 1080}px) scale(1)`;
  };
  tl.fromTo(
    BG,
    { cx: 2350 },
    { cx: 2150, duration: 5.053, ease: 'none', immediateRender: false },
    0,
  );
  tl.fromTo(
    '#vp-phone',
    { y: 1400, rotationY: -55, rotationX: 28, rotationZ: 8, scale: 1.0 },
    {
      y: 0,
      rotationY: -12,
      rotationX: 5,
      rotationZ: 0,
      scale: 1.15,
      duration: 0.8,
      ease: 'back.out(1.3)',
    },
    0,
  );
  tl.to('#vp-phone', { rotationY: 6, rotationX: 2, duration: 4.25, ease: 'sine.inOut' }, 0.8);
  const BTN = { x: 112, y: 246 };
  const TAB = { x: 279, y: 838 };
  tl.fromTo(
    '#vp-touch',
    { opacity: 0, x: BTN.x + 70, y: BTN.y + 140, scale: 1.3 },
    { opacity: 1, x: BTN.x, y: BTN.y, scale: 1, duration: 0.4, ease: 'power3.out' },
    1.04,
  );
  tl.to('#vp-touch', { scale: 0.8, duration: 0.08, ease: 'power2.in' }, 1.44);
  tl.fromTo(
    '#vp-ring',
    { opacity: 1, scale: 0.6, x: BTN.x, y: BTN.y },
    { opacity: 0, scale: 2.6, x: BTN.x, y: BTN.y, duration: 0.5, ease: 'power2.out' },
    1.5,
  );
  tl.to('#vp-touch', { opacity: 0, scale: 1.2, duration: 0.25, ease: 'power2.out' }, 1.56);
  tl.fromTo(
    '#vp-touch',
    { opacity: 0, x: TAB.x, y: TAB.y - 60, scale: 1.3 },
    {
      opacity: 1,
      x: TAB.x,
      y: TAB.y,
      scale: 1,
      duration: 0.3,
      ease: 'power3.out',
      immediateRender: false,
    },
    2.84,
  );
  tl.fromTo(
    '#vp-ring',
    { opacity: 1, scale: 0.6, x: TAB.x, y: TAB.y },
    {
      opacity: 0,
      scale: 2.4,
      x: TAB.x,
      y: TAB.y,
      duration: 0.45,
      ease: 'power2.out',
      immediateRender: false,
    },
    3.2,
  );
  tl.to('#vp-touch', { opacity: 0, duration: 0.2 }, 3.26);
  tl.to(
    '#vp-phone',
    { scale: 1.6, y: -260, rotationY: 0, rotationX: 0, duration: 1.2, ease: 'power2.in' },
    3.85,
  );
  tl.eventCallback('onUpdate', () => {
    sala.colocar(bg, 11);
    videoEm(pwa, tl.time(), 9);
    applyBg();
  });
  applyBg();
  return tl;
};

/** 9:16, 49,3–59,4 s: o café à noite em 8x recua para 6x e o logo se monta. */
export const fechamentoV: Montar = (root, sala) => {
  const tl = gsap.timeline({ paused: true });
  const L = 1.263;
  const cafe = q(root, '#vf-cafe');
  const C = { s: 1.3333333, cx: 2250, cy: 1250 };
  const apply = camera(cafe, C);
  tl.fromTo(
    C,
    { s: 1.3333333, cx: 2250, cy: 1250 },
    { s: 1, cx: 2150, cy: 1080, duration: 3.2, ease: 'power3.inOut', immediateRender: false },
    0,
  );
  tl.fromTo(
    C,
    { cx: 2150 },
    { cx: 2060, duration: 6.9, ease: 'sine.inOut', immediateRender: false },
    3.2,
  );
  tl.fromTo('#vf-dim', { opacity: 0 }, { opacity: 1, duration: 0.45, ease: 'power2.out' }, L);
  tl.fromTo(
    '#vf-halo',
    { opacity: 0, scale: 0.6 },
    { opacity: 1, scale: 1, duration: 0.9, ease: 'expo.out' },
    L + 0.05,
  );
  const tag = montarLogo(tl, root, 'vf', L, {
    px: q(root, '#vf-px'),
    cx: 540,
    cy: 670,
    size: 22,
    raio: 460,
    abre: 360,
    passo: 26,
    yr: 1,
  });
  const B0 = L + 3.6;
  const breathe = 10.105 - B0;
  tl.fromTo('#vf-lock', { scale: 1 }, { scale: 1.03, duration: breathe, ease: 'sine.inOut' }, B0);
  tl.fromTo(
    '#vf-halo',
    { scale: 1 },
    { scale: 1.12, duration: breathe, ease: 'sine.inOut', immediateRender: false },
    B0,
  );
  tl.eventCallback('onUpdate', () => {
    sala.colocar(cafe, 21.5);
    sala.cochilar();
    apply();
    tag(tl.time());
  });
  apply();
  return tl;
};
