import { gsap } from 'gsap';

import type { Montar } from '../util';

/** 29,1–34,1 s: o chat "Agentes FaKL" mostra o arquivo alterado; um clique abre o diff. */
export const chat: Montar = () => {
  const tl = gsap.timeline({ paused: true });
  const W = '#ch-win';

  tl.fromTo(
    W,
    { x: 1200, rotationY: -34, rotationX: 4, scale: 1.0, y: 0 },
    { x: -250, rotationY: -14, rotationX: 3, scale: 1.12, y: 20, duration: 0.6, ease: 'expo.out' },
    0,
  );
  tl.to(W, { x: -330, rotationY: -10, scale: 1.18, y: 10, duration: 1.5, ease: 'sine.inOut' }, 0.6);
  tl.fromTo(
    '#ch-glow',
    { opacity: 0.5, x: 260 },
    { opacity: 1, x: 0, duration: 1.2, ease: 'power2.out' },
    0,
  );
  tl.fromTo('#ch-grid', { x: 0 }, { x: -64, duration: 5.05, ease: 'none' }, 0);

  tl.fromTo(
    '#ch-after',
    { opacity: 0, y: 26 },
    { opacity: 1, y: 0, duration: 0.3, ease: 'power3.out' },
    0.75,
  );
  tl.fromTo('#ch-before', { opacity: 1 }, { opacity: 0, duration: 0.3, ease: 'power1.in' }, 0.75);

  // Cursor até users.ts no painel de mudanças e clique.
  const ROW = { x: 1120 + 72, y: 586 };
  tl.fromTo(
    '#ch-cursor',
    { opacity: 0, x: ROW.x + 230, y: ROW.y - 240 },
    { opacity: 1, x: ROW.x + 230, y: ROW.y - 240, duration: 0.1 },
    1.15,
  );
  tl.to('#ch-cursor', { x: ROW.x - 6, y: ROW.y - 6, duration: 0.55, ease: 'power3.inOut' }, 1.25);
  tl.to('#ch-cursor', { scale: 0.86, duration: 0.07, ease: 'power2.in' }, 1.82);
  tl.to('#ch-cursor', { scale: 1, duration: 0.14, ease: 'back.out(3)' }, 1.89);
  tl.fromTo(
    '#ch-ripple',
    { opacity: 1, scale: 0.4, x: ROW.x, y: ROW.y },
    { opacity: 0, scale: 2.6, x: ROW.x, y: ROW.y, duration: 0.45, ease: 'power2.out' },
    1.85,
  );
  tl.to('#ch-cursor', { opacity: 0, duration: 0.2 }, 2.5);

  // O diff abre no editor: a linha velha fica vermelha e some, as novas entram uma a uma.
  tl.fromTo('#ch-tab2', { opacity: 0 }, { opacity: 1, duration: 0.15 }, 1.95);
  tl.fromTo('#ch-tab1', { color: '#e6edf3' }, { color: '#6b7480', duration: 0.15 }, 1.95);
  tl.fromTo('#ch-bar1', { opacity: 1 }, { opacity: 0, duration: 0.15 }, 1.95);
  tl.fromTo(
    '#ch-old',
    { backgroundColor: 'rgba(248,113,113,0)' },
    { backgroundColor: 'rgba(248,113,113,0.28)', duration: 0.15 },
    2.0,
  );
  tl.fromTo(
    '#ch-old',
    { height: 36, opacity: 1 },
    { height: 0, opacity: 0, duration: 0.25, ease: 'power2.in' },
    2.35,
  );
  tl.fromTo(
    '.ch-add',
    { height: 0, opacity: 0 },
    { height: 36, opacity: 1, duration: 0.2, ease: 'power2.out', stagger: 0.08 },
    2.45,
  );
  tl.to(
    W,
    {
      x: 380,
      y: 170,
      rotationY: -5,
      rotationX: 2,
      scale: 1.45,
      duration: 2.0,
      ease: 'power2.inOut',
    },
    2.2,
  );
  tl.fromTo(
    '#ch-stage',
    { x: 0, opacity: 1 },
    { x: -1000, opacity: 0, duration: 0.3, ease: 'power3.in', immediateRender: false },
    4.75,
  );
  return tl;
};
