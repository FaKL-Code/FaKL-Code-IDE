import { gsap } from 'gsap';

import { BAR, terminal } from '../h/estacoes';
import { q, videoEm, type Montar } from '../util';

/** 9:16, 31,6–44,2 s: as cinco estações em rolagem vertical, tipo feed. */
export const estacoesV: Montar = (root) => {
  const GAP = 2000;
  const tl = gsap.timeline({ paused: true });
  const CAM = { y: -1500, drift: 0 };
  const st = [0, 1, 2, 3, 4].map((i) => q(root, `#ve-${String(i)}`));
  const world = q(root, '#ve-world');
  const grid = q(root, '#ve-grid');
  const apply = (): void => {
    const cy = CAM.y + CAM.drift;
    world.style.transform = `translateY(${-cy}px)`;
    grid.style.transform = `translateY(${-cy * 0.35}px)`;
    st.forEach((el, i) => {
      const d = (i * GAP - cy) / GAP;
      const a = Math.min(1, Math.abs(d));
      el.style.transform = `translateZ(${-a * 420}px) rotateX(${d * 34}deg) scale(${1 - a * 0.08})`;
      el.style.opacity = String(1 - a * 0.55);
    });
  };
  tl.fromTo(
    CAM,
    { y: -1500 },
    { y: 0, duration: 0.42, ease: 'expo.out', immediateRender: false },
    0,
  );
  for (let i = 1; i < 5; i++)
    tl.fromTo(
      CAM,
      { y: (i - 1) * GAP },
      { y: i * GAP, duration: 0.42, ease: 'expo.inOut', immediateRender: false },
      i * BAR - 0.21,
    );
  tl.fromTo(
    CAM,
    { drift: -30 },
    { drift: 40, duration: 12.632, ease: 'none', immediateRender: false },
    0,
  );

  tl.fromTo(
    '.ve-r0',
    { opacity: 0, x: -30 },
    { opacity: 1, x: 0, duration: 0.3, ease: 'power3.out', stagger: 0.07 },
    0.3,
  );
  const graph = q(root, '#ve-graph') as HTMLVideoElement;
  const renderTerm = terminal(
    q(root, '#ve-term'),
    [
      { t: 0.25, type: 'uptime' },
      { t: 0.75, html: ' 14:32:07 up 41 days,  3:12,  load average: 0.08, 0.11, 0.09\n' },
      { t: 0.95, type: 'df -h /' },
      {
        t: 1.5,
        html: 'Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1    96G   31G   65G  33% /\n',
      },
      { t: 1.65, prompt: true },
    ],
    've-term-caret',
  );
  const S2 = 2 * BAR;
  tl.fromTo('#ve-ghwrap', { y: 0 }, { y: -300, duration: 2.3, ease: 'sine.inOut' }, S2);
  tl.fromTo(
    '#ve-gh-hl',
    { opacity: 0, scale: 1.04 },
    { opacity: 1, scale: 1, duration: 0.3, ease: 'power2.out' },
    S2 + 1.0,
  );
  const S3 = 3 * BAR;
  tl.fromTo(
    '.ve-r3',
    { opacity: 0, x: -30 },
    { opacity: 1, x: 0, duration: 0.28, ease: 'power3.out', stagger: 0.06 },
    S3 + 0.15,
  );
  tl.fromTo(
    '#ve-pal',
    { opacity: 0, y: 40, scale: 0.97 },
    { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'expo.out' },
    S3 + 0.55,
  );
  tl.to(
    '#ve-pal-sel',
    { backgroundColor: 'rgba(6,224,255,0.35)', duration: 0.08, yoyo: true, repeat: 1 },
    S3 + 1.9,
  );
  const palQ = q(root, '#ve-pal-q');
  const S4 = 4 * BAR;
  tl.fromTo(
    '.ve-r4',
    { opacity: 0, scale: 0.8 },
    { opacity: 1, scale: 1, duration: 0.25, ease: 'back.out(2)', stagger: 0.06 },
    S4 + 0.15,
  );
  tl.fromTo(
    '.ve-mcp',
    { opacity: 0, y: 40, scale: 0.94 },
    { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: 'back.out(1.6)', stagger: 0.06 },
    S4 + 0.35,
  );
  tl.fromTo(
    '#ve-i1',
    { scale: 0, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.25, ease: 'back.out(3)' },
    S4 + 1.1,
  );
  tl.fromTo(
    '#ve-i2',
    { scale: 0, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.25, ease: 'back.out(3)' },
    S4 + 1.45,
  );
  tl.fromTo(
    '#ve-stage',
    { scale: 1, opacity: 1 },
    { scale: 0.9, opacity: 0, duration: 0.35, ease: 'power3.in', immediateRender: false },
    12.28,
  );
  tl.eventCallback('onUpdate', () => {
    const t = tl.time();
    apply();
    renderTerm(t - BAR);
    videoEm(graph, t - 0.1, 4);
    palQ.textContent = 'lovable'.slice(
      0,
      Math.max(0, Math.min(7, Math.floor((t - S3 - 0.85) / 0.07))),
    );
  });
  apply();
  renderTerm(-1);
  return tl;
};
