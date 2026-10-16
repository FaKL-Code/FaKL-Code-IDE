import { gsap } from 'gsap';

import { grade, q, videoEm, type Montar } from '../util';

/** 46,7–61,9 s: o celular aprova o Codex, abre o Café e a câmera cai no café à noite. */
export const celular: Montar = (root, sala) => {
  const cells = grade(q(root, '#cl-cells'), 24 * 14);
  const pwa = q(root, '#cl-pwa') as HTMLVideoElement;
  const tl = gsap.timeline({ paused: true });

  // Fundo: o café de dia, desfocado, com deriva lenta (4x).
  const BG = { s: 0.6666667, cx: 2300, cy: 1150 };
  const bg = q(root, '#cl-bg');
  const applyBg = (): void => {
    bg.style.transform = `translate(${960 - BG.cx * BG.s}px, ${540 - BG.cy * BG.s}px) scale(${BG.s})`;
  };
  tl.fromTo(
    BG,
    { cx: 2300 },
    { cx: 2050, duration: 10.105, ease: 'none', immediateRender: false },
    0,
  );

  // O celular sobe girando em 3D e assenta.
  tl.fromTo(
    '#cl-phone',
    { y: 1100, rotationY: -55, rotationX: 28, rotationZ: 8, scale: 0.9 },
    {
      y: 0,
      rotationY: -16,
      rotationX: 6,
      rotationZ: 0,
      scale: 1,
      duration: 0.8,
      ease: 'back.out(1.3)',
    },
    0,
  );
  tl.to(
    '#cl-phone',
    { rotationY: -6, rotationX: 3, x: -60, duration: 6.9, ease: 'sine.inOut' },
    0.8,
  );

  // Toque em "Permitir" e depois na aba Café.
  const BTN = { x: 112, y: 246 };
  tl.fromTo(
    '#cl-touch',
    { opacity: 0, x: BTN.x + 70, y: BTN.y + 140, scale: 1.3 },
    { opacity: 1, x: BTN.x, y: BTN.y, scale: 1, duration: 0.4, ease: 'power3.out' },
    1.04,
  );
  tl.to('#cl-touch', { scale: 0.8, duration: 0.08, ease: 'power2.in' }, 1.44);
  tl.fromTo(
    '#cl-ring',
    { opacity: 1, scale: 0.6, x: BTN.x, y: BTN.y },
    { opacity: 0, scale: 2.6, x: BTN.x, y: BTN.y, duration: 0.5, ease: 'power2.out' },
    1.5,
  );
  tl.to('#cl-touch', { opacity: 0, scale: 1.2, duration: 0.25, ease: 'power2.out' }, 1.56);
  const TAB = { x: 279, y: 838 };
  tl.fromTo(
    '#cl-touch',
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
    '#cl-ring',
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
  tl.to('#cl-touch', { opacity: 0, duration: 0.2 }, 3.26);

  // A câmera mergulha na aba Café do celular...
  tl.to(
    '#cl-phone',
    {
      rotationY: 0,
      rotationX: 0,
      x: 960 - 1210 - 22 - 201,
      y: 540 - 70 - 22 - 371,
      scale: 1.0,
      duration: 0.6,
      ease: 'power2.inOut',
    },
    7.7,
  );
  tl.to('#cl-phone', { scale: 7.5, duration: 1.85, ease: 'expo.in' }, 8.3);
  tl.to('#cl-bgwrap', { opacity: 0, duration: 0.8, ease: 'power1.in' }, 8.6);
  // ... e cai, por uma grade de pixels, no café de verdade, à noite.
  tl.fromTo(
    cells,
    { scale: 0 },
    {
      scale: 1,
      duration: 0.18,
      ease: 'steps(3)',
      stagger: { grid: [14, 24], from: 'center', amount: 0.25 },
    },
    9.7,
  );
  tl.fromTo('#cl-night', { opacity: 0 }, { opacity: 1, duration: 0.01 }, 10.105);
  tl.fromTo(
    cells,
    { scale: 1 },
    {
      scale: 0,
      duration: 0.2,
      ease: 'steps(3)',
      stagger: { grid: [14, 24], from: 'center', amount: 0.35 },
      immediateRender: false,
    },
    10.105,
  );

  // Volta: começa em 6x no agente cochilando e abre até o plano geral (3x).
  const N = { s: 1, cx: 2240, cy: 1250 };
  const night = q(root, '#cl-night');
  const applyNight = (): void => {
    night.style.transform = `translate(${960 - N.cx * N.s}px, ${540 - N.cy * N.s}px) scale(${N.s})`;
  };
  tl.fromTo(
    N,
    { s: 1, cx: 2240, cy: 1250 },
    { s: 0.5, cx: 1920, cy: 1080, duration: 4.9, ease: 'power3.inOut', immediateRender: false },
    10.2,
  );

  tl.eventCallback('onUpdate', () => {
    const t = tl.time();
    if (t < 10.105) sala.colocar(bg, 11);
    else {
      sala.colocar(night, 21.5);
      sala.cochilar();
    }
    videoEm(pwa, t, 9);
    applyBg();
    applyNight();
  });
  applyBg();
  applyNight();
  return tl;
};
