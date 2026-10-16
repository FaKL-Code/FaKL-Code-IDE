import { gsap } from 'gsap';

import { q, type Montar } from '../util';

/** 9:16, 18,9–26,5 s: a Mesa em 3D, palavras de impacto, trilho e teto de gasto. */
export const mesaV: Montar = (root) => {
  const tl = gsap.timeline({ paused: true });
  const W = '#vm-world';
  const at = (xw: number, yw: number, s: number): { x: number; y: number; scale: number } => ({
    x: -(xw - 960) * s,
    y: -(yw - 540) * s,
    scale: s,
  });

  tl.fromTo('#vm-flash', { opacity: 0.3 }, { opacity: 0, duration: 0.25, ease: 'power2.out' }, 0);
  tl.fromTo(
    W,
    { ...at(1080, 540, 1.7777778), rotationX: 0, rotationY: 0 },
    { ...at(1080, 620, 1.0), rotationX: 18, rotationY: -12, duration: 0.9, ease: 'expo.out' },
    0,
  );
  tl.fromTo('#vm-floor', { opacity: 0 }, { opacity: 1, duration: 0.8, ease: 'power1.out' }, 0.1);
  tl.fromTo('#vm-glow', { scale: 0.8 }, { scale: 1.15, duration: 7.6, ease: 'sine.inOut' }, 0);
  tl.to(
    W,
    { ...at(1080, 620, 1.04), rotationX: 12, rotationY: -5, duration: 1.6, ease: 'sine.inOut' },
    0.9,
  );

  ['1', '2', '3', '4'].forEach((n, i) => {
    const t = 0.02 + i * 0.15;
    tl.fromTo(
      `#vm-a${n}`,
      { opacity: 0, scale: 0.55, z: 260, y: 40 },
      { opacity: 1, scale: 1, z: 0, y: 0, duration: 0.5, ease: 'back.out(1.8)' },
      t,
    );
    tl.fromTo(
      `#vm-r${n}`,
      { opacity: 0, scale: 1.25 },
      { opacity: 1, scale: 1, duration: 0.18, ease: 'power2.out' },
      t + 0.1,
    );
    tl.to(`#vm-r${n}`, { opacity: 0, duration: 0.45, ease: 'power1.in' }, t + 0.32);
  });
  tl.fromTo(
    '#vm-ropes',
    { clipPath: 'inset(0 0 100% 0)' },
    { clipPath: 'inset(0 0 0% 0)', duration: 0.6, ease: 'power2.inOut' },
    0.55,
  );

  tl.fromTo(
    '#vm-rail',
    { opacity: 0, x: -40 },
    { opacity: 1, x: 0, duration: 0.35, ease: 'expo.out' },
    2.4,
  );
  ['#vm-c1', '#vm-c2', '#vm-c3', '#vm-c4'].forEach((c, i) => {
    const t = 2.526 + i * 0.632;
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
      t,
    );
    tl.to(c, { scale: 1, duration: 0.2, ease: 'power2.out' }, t + 0.14);
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
        t + 0.632,
      );
  });
  tl.to(
    W,
    {
      ...at(1080, 340, 1.4),
      rotationX: 6,
      rotationY: 4,
      y: 195,
      duration: 2.4,
      ease: 'power2.inOut',
    },
    2.526,
  );

  tl.to('#vm-rail', { opacity: 0, x: -40, duration: 0.25, ease: 'power2.in' }, 4.95);
  tl.to(
    W,
    {
      ...at(120, 205, 1.75),
      y: -(205 - 540) * 1.75 - 280,
      rotationX: 4,
      rotationY: 14,
      duration: 0.7,
      ease: 'expo.inOut',
    },
    4.95,
  );
  tl.to(
    W,
    {
      ...at(130, 205, 1.82),
      y: -(205 - 540) * 1.82 - 290,
      rotationY: 10,
      duration: 1.9,
      ease: 'sine.inOut',
    },
    5.65,
  );
  tl.fromTo(
    '#vm-cost',
    { opacity: 0, y: 80, scale: 0.92 },
    { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'expo.out' },
    5.15,
  );
  const COST = 1.65;
  const CAP = 10;
  const val = q(root, '#vm-val');
  const counter = { v: 0 };
  tl.fromTo(counter, { v: 0 }, { v: COST, duration: 1.3, ease: 'power2.out' }, 5.3);
  tl.fromTo('#vm-num', { scale: 0.78 }, { scale: 1, duration: 1.3, ease: 'power2.out' }, 5.3);
  tl.fromTo(
    '#vm-fill',
    { scaleX: 0 },
    { scaleX: COST / CAP, duration: 1.3, ease: 'power2.out' },
    5.3,
  );
  tl.to('#vm-num', { scale: 1.06, duration: 0.12, ease: 'power2.out' }, 6.6);
  tl.to('#vm-num', { scale: 1, duration: 0.25, ease: 'power2.inOut' }, 6.72);
  (
    [
      ['#vm-s1', 0, 0.3],
      ['#vm-s2', 0.316, 0.3],
      ['#vm-s3', 0.632, 0.36],
    ] as const
  ).forEach(([el, t, d]) => {
    tl.fromTo(
      el,
      { scale: 1.6, opacity: 0 },
      { scale: 1, opacity: 1, duration: 0.09, ease: 'power4.out' },
      t,
    );
    tl.to(el, { scale: 0.94, opacity: 0, y: -10, duration: 0.1, ease: 'power2.in' }, t + d - 0.1);
  });
  tl.fromTo(
    '#vm-stage',
    { y: 0, opacity: 1 },
    { y: -1200, opacity: 0, duration: 0.3, ease: 'power3.in', immediateRender: false },
    7.28,
  );
  tl.to('#vm-cost', { y: -1200, opacity: 0, duration: 0.3, ease: 'power3.in' }, 7.28);
  tl.eventCallback('onUpdate', () => {
    val.textContent = counter.v.toFixed(2);
  });
  return tl;
};
