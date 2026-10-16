import { gsap } from 'gsap';

import type { Montar } from '../util';

/** 9:16, 26,5–31,6 s: o chat sobe, o clique em users.ts e o diff por cima. */
export const chatV: Montar = () => {
  const tl = gsap.timeline({ paused: true });
  tl.fromTo(
    '#vh-chat',
    { y: 1400, rotationX: -28, scale: 0.94 },
    { y: 0, rotationX: -6, scale: 1, duration: 0.6, ease: 'expo.out' },
    0,
  );
  tl.to('#vh-chat', { rotationX: -3, rotationY: 4, duration: 1.5, ease: 'sine.inOut' }, 0.6);
  tl.fromTo('#vh-glow', { opacity: 0.5 }, { opacity: 1, duration: 1.2, ease: 'power2.out' }, 0);
  tl.fromTo('#vh-grid', { y: 0 }, { y: -64, duration: 5.05, ease: 'none' }, 0);
  tl.fromTo(
    '#vh-after',
    { opacity: 0, y: 30 },
    { opacity: 1, y: 0, duration: 0.3, ease: 'power3.out' },
    0.75,
  );
  tl.fromTo('#vh-before', { opacity: 1 }, { opacity: 0, duration: 0.3, ease: 'power1.in' }, 0.75);
  const ROW = { x: 72 * 1.8, y: 541 * 1.8 };
  tl.fromTo(
    '#vh-cursor',
    { opacity: 0, x: ROW.x + 300, y: ROW.y - 260 },
    { opacity: 1, x: ROW.x + 300, y: ROW.y - 260, duration: 0.1 },
    1.15,
  );
  tl.to('#vh-cursor', { x: ROW.x - 8, y: ROW.y - 8, duration: 0.55, ease: 'power3.inOut' }, 1.25);
  tl.to('#vh-cursor', { scale: 0.86, duration: 0.07, ease: 'power2.in' }, 1.82);
  tl.to('#vh-cursor', { scale: 1, duration: 0.14, ease: 'back.out(3)' }, 1.89);
  tl.fromTo(
    '#vh-ripple',
    { opacity: 1, scale: 0.4, x: ROW.x, y: ROW.y },
    { opacity: 0, scale: 2.6, x: ROW.x, y: ROW.y, duration: 0.45, ease: 'power2.out' },
    1.85,
  );
  tl.to('#vh-cursor', { opacity: 0, duration: 0.2 }, 2.4);
  tl.fromTo(
    '#vh-ed',
    { y: 1500, rotationX: 24 },
    { y: 0, rotationX: 0, duration: 0.55, ease: 'expo.out' },
    2.0,
  );
  tl.to(
    '#vh-chat',
    { scale: 0.92, y: -80, opacity: 0.55, duration: 0.55, ease: 'power2.out' },
    2.0,
  );
  tl.fromTo(
    '#vh-old',
    { backgroundColor: 'rgba(248,113,113,0)' },
    { backgroundColor: 'rgba(248,113,113,0.28)', duration: 0.15 },
    2.4,
  );
  tl.fromTo(
    '#vh-old',
    { height: 42, opacity: 1 },
    { height: 0, opacity: 0, duration: 0.25, ease: 'power2.in' },
    2.65,
  );
  tl.fromTo(
    '.vh-add',
    { height: 0, opacity: 0 },
    { height: 42, opacity: 1, duration: 0.2, ease: 'power2.out', stagger: 0.08 },
    2.75,
  );
  tl.to('#vh-ed', { scale: 1.06, y: -40, duration: 1.9, ease: 'sine.inOut' }, 2.6);
  tl.fromTo(
    '#vh-stage',
    { y: 0, opacity: 1 },
    { y: -1300, opacity: 0, duration: 0.3, ease: 'power3.in', immediateRender: false },
    4.75,
  );
  return tl;
};
