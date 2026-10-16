import { gsap } from 'gsap';

import { q, type Montar } from '../util';

/** 21,5–29,1 s: a Mesa em 3D, cartões em cascata, trilho do maestro e o teto de gasto. */
export const mesa: Montar = (root) => {
  const tl = gsap.timeline({ paused: true });
  const W = '#ms-world';

  tl.fromTo('#ms-flash', { opacity: 0.3 }, { opacity: 0, duration: 0.25, ease: 'power2.out' }, 0);
  tl.fromTo(
    W,
    { rotationX: 0, rotationY: 0, scale: 1, x: 0, y: 0, z: 0 },
    {
      rotationX: 16,
      rotationY: -12,
      scale: 0.84,
      x: 20,
      y: 10,
      z: 0,
      duration: 0.9,
      ease: 'expo.out',
    },
    0,
  );
  tl.fromTo('#ms-floor', { opacity: 0 }, { opacity: 1, duration: 0.8, ease: 'power1.out' }, 0.1);
  tl.fromTo('#ms-glow', { scale: 0.8 }, { scale: 1.15, duration: 7.6, ease: 'sine.inOut' }, 0);
  tl.to(W, { rotationY: -4, rotationX: 10, x: -10, duration: 1.63, ease: 'sine.inOut' }, 0.9);

  // Cartões acendem em cascata (0,15 s), saltando da mesa para a câmera.
  ['1', '2', '3', '4'].forEach((n, i) => {
    const at = 0.02 + i * 0.15;
    tl.fromTo(
      `#ms-a${n}`,
      { opacity: 0, scale: 0.55, z: 260, y: 40 },
      { opacity: 1, scale: 1, z: 0, y: 0, duration: 0.5, ease: 'back.out(1.8)' },
      at,
    );
    tl.fromTo(
      `#ms-r${n}`,
      { opacity: 0, scale: 1.25 },
      { opacity: 1, scale: 1, duration: 0.18, ease: 'power2.out' },
      at + 0.1,
    );
    tl.to(`#ms-r${n}`, { opacity: 0, duration: 0.45, ease: 'power1.in' }, at + 0.32);
  });
  tl.fromTo(
    '#ms-ropes',
    { clipPath: 'inset(0 0 100% 0)' },
    { clipPath: 'inset(0 0 0% 0)', duration: 0.6, ease: 'power2.inOut' },
    0.55,
  );

  // Trilho do maestro: entra e avança um passo por tempo.
  tl.fromTo(
    '#ms-rail',
    { opacity: 0, y: -30 },
    { opacity: 1, y: 0, duration: 0.35, ease: 'expo.out' },
    2.4,
  );
  ['#ms-c1', '#ms-c2', '#ms-c3', '#ms-c4'].forEach((c, i) => {
    const at = 2.526 + i * 0.632;
    tl.fromTo(
      c,
      { backgroundColor: 'rgba(6,224,255,0)', color: '#a1a1aa', borderColor: '#374151', scale: 1 },
      {
        backgroundColor: 'rgba(6,224,255,1)',
        color: '#0d1117',
        borderColor: '#06e0ff',
        scale: 1.08,
        duration: 0.14,
        ease: 'power2.out',
      },
      at,
    );
    tl.to(c, { scale: 1, duration: 0.2, ease: 'power2.out' }, at + 0.14);
    if (i < 3)
      tl.to(
        c,
        {
          backgroundColor: 'rgba(6,224,255,0)',
          color: '#e5e7eb',
          borderColor: '#374151',
          duration: 0.16,
          ease: 'none',
        },
        at + 0.632,
      );
  });
  tl.to(
    W,
    {
      rotationY: 6,
      rotationX: 8,
      scale: 1.18,
      x: -140,
      y: 196,
      duration: 2.5,
      ease: 'power2.inOut',
    },
    2.526,
  );

  // Limites: a câmera vai aos anéis de uso, o contador sobe até abaixo do teto.
  tl.to('#ms-rail', { opacity: 0, y: -30, duration: 0.25, ease: 'power2.in' }, 4.95);
  tl.to(
    W,
    { rotationY: 18, rotationX: 6, scale: 1.55, x: 750, y: 450, duration: 0.7, ease: 'expo.inOut' },
    4.95,
  );
  tl.to(W, { rotationY: 14, scale: 1.62, x: 740, y: 440, duration: 1.9, ease: 'sine.inOut' }, 5.65);
  tl.fromTo(
    '#ms-cost',
    { opacity: 0, x: 120, scale: 0.9 },
    { opacity: 1, x: 0, scale: 1, duration: 0.45, ease: 'expo.out' },
    5.15,
  );
  const COST = 1.65;
  const CAP = 10;
  const val = q(root, '#ms-val');
  const counter = { v: 0 };
  tl.fromTo(counter, { v: 0 }, { v: COST, duration: 1.3, ease: 'power2.out' }, 5.3);
  tl.fromTo('#ms-num', { scale: 0.78 }, { scale: 1, duration: 1.3, ease: 'power2.out' }, 5.3);
  tl.fromTo(
    '#ms-fill',
    { scaleX: 0 },
    { scaleX: COST / CAP, duration: 1.3, ease: 'power2.out' },
    5.3,
  );
  tl.to('#ms-num', { scale: 1.06, duration: 0.12, ease: 'power2.out' }, 6.6);
  tl.to('#ms-num', { scale: 1, duration: 0.25, ease: 'power2.inOut' }, 6.72);

  // Saída em chicote.
  tl.fromTo(
    '#ms-stage',
    { x: 0, opacity: 1 },
    { x: -900, opacity: 0, duration: 0.3, ease: 'power3.in', immediateRender: false },
    7.28,
  );
  tl.to('#ms-cost', { x: -900, opacity: 0, duration: 0.3, ease: 'power3.in' }, 7.28);
  tl.fromTo(
    ['#ms-glow', '#ms-floor'],
    { x: 0 },
    { x: -900, duration: 0.3, ease: 'power3.in', immediateRender: false },
    7.28,
  );
  tl.eventCallback('onUpdate', () => {
    val.textContent = counter.v.toFixed(2);
  });
  return tl;
};
