import { gsap } from 'gsap';

import { langDoDocumento, textos } from '../../i18n';
import { q, videoEm, type Montar } from '../util';

export const BAR = 2.526;

interface Passo {
  readonly t: number;
  readonly html?: string;
  readonly type?: string;
  readonly prompt?: boolean;
}

/** Terminal SSH digitado a partir do tempo local (qualquer posição dá o mesmo texto). */
export function terminal(
  el: HTMLElement,
  script: readonly Passo[],
  caretId: string,
): (lt: number) => void {
  const host = textos(langDoDocumento()).cena.estacoes.vps;
  const P = `<span class="g">root@${host}</span>:<span class="c">~</span># `;
  const caret = `<span id="${caretId}"></span>`;
  let ultimo = '';
  return (lt) => {
    let out = '';
    for (const s of script) {
      if (lt < s.t) break;
      if (s.html) out += s.html;
      if (s.type) {
        const n = Math.min(s.type.length, Math.floor((lt - s.t) / 0.045));
        out += P + s.type.slice(0, n) + (n >= s.type.length ? '\n' : '');
        if (n < s.type.length) break;
      }
      if (s.prompt) out += P;
    }
    out += caret;
    if (out !== ultimo) {
      ultimo = out;
      el.innerHTML = out;
    }
  };
}

/** 34,1–46,7 s: travelling em coverflow por Vault, SSH, GitHub, Hostinger e Lovable, MCP. */
export const estacoes: Montar = (root) => {
  const GAP = 2000;
  const tl = gsap.timeline({ paused: true });
  const CAM = { x: -1300, drift: 0 };
  const stations = [0, 1, 2, 3, 4].map((i) => q(root, `#es-${String(i)}`));
  const world = q(root, '#es-world');
  const grid = q(root, '#es-grid');
  const apply = (): void => {
    const cx = CAM.x + CAM.drift;
    world.style.transform = `translateX(${-cx}px)`;
    grid.style.transform = `translateX(${-cx * 0.35}px)`;
    stations.forEach((el, i) => {
      const d = (i * GAP - cx) / GAP;
      const a = Math.min(1, Math.abs(d));
      el.style.transform = `translateZ(${-a * 420}px) rotateY(${-d * 38}deg) scale(${1 - a * 0.08})`;
      el.style.opacity = String(1 - a * 0.55);
    });
  };
  tl.fromTo(
    CAM,
    { x: -1300 },
    { x: 0, duration: 0.42, ease: 'expo.out', immediateRender: false },
    0,
  );
  for (let i = 1; i < 5; i++)
    tl.fromTo(
      CAM,
      { x: (i - 1) * GAP },
      { x: i * GAP, duration: 0.42, ease: 'expo.inOut', immediateRender: false },
      i * BAR - 0.21,
    );
  tl.fromTo(
    CAM,
    { drift: -40 },
    { drift: 60, duration: 12.632, ease: 'none', immediateRender: false },
    0,
  );

  // 1. Vault: backlinks entram enquanto o grafo se forma.
  tl.fromTo(
    '.es-row0',
    { opacity: 0, x: -30 },
    { opacity: 1, x: 0, duration: 0.3, ease: 'power3.out', stagger: 0.07 },
    0.25,
  );
  const graph = q(root, '#es-graph') as HTMLVideoElement;

  // 2. SSH: o agente roda uptime e df -h num host com política só leitura.
  const renderTerm = terminal(
    q(root, '#es-term'),
    [
      {
        t: 0.25,
        html: `<span class="m">${textos(langDoDocumento()).cena.estacoes.terminalAgente}</span>\n`,
      },
      { t: 0.45, type: 'uptime' },
      { t: 1.0, html: ' 14:32:07 up 41 days,  3:12,  load average: 0.08, 0.11, 0.09\n' },
      { t: 1.15, type: 'df -h /' },
      {
        t: 1.7,
        html: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        96G   31G   65G  33% /\n',
      },
      { t: 1.85, prompt: true },
    ],
    'es-term-caret',
  );

  // 3. GitHub: a página sobe e o PR do maestro ganha destaque.
  const S2 = 2 * BAR;
  tl.fromTo('#es-gh-wrap', { y: 0 }, { y: -110, duration: 2.4, ease: 'sine.inOut' }, S2);
  tl.fromTo(
    '#es-gh-hl',
    { opacity: 0, scale: 1.04 },
    { opacity: 1, scale: 1, duration: 0.3, ease: 'power2.out' },
    S2 + 1.0,
  );

  // 4. Hostinger e Lovable: árvore entra, paleta abre e filtra "lovable".
  const S3 = 3 * BAR;
  tl.fromTo(
    '.es-row3',
    { opacity: 0, x: -30 },
    { opacity: 1, x: 0, duration: 0.28, ease: 'power3.out', stagger: 0.06 },
    S3 + 0.15,
  );
  tl.fromTo(
    '#es-pal',
    { opacity: 0, y: -24, scale: 0.97 },
    { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'expo.out' },
    S3 + 0.55,
  );
  const palQ = q(root, '#es-pal-q');
  const WORD = 'lovable';
  tl.to(
    '#es-pal-sel',
    { backgroundColor: 'rgba(6,224,255,0.35)', duration: 0.08, yoyo: true, repeat: 1 },
    S3 + 1.9,
  );

  // 5. Extensões e MCP: cartões em cascata, dois servidores instalados.
  const S4 = 4 * BAR;
  tl.fromTo(
    '.es-row4',
    { opacity: 0, x: -30 },
    { opacity: 1, x: 0, duration: 0.28, ease: 'power3.out', stagger: 0.06 },
    S4 + 0.15,
  );
  tl.fromTo(
    '.es-mcp',
    { opacity: 0, y: 40, scale: 0.94 },
    { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: 'back.out(1.6)', stagger: 0.06 },
    S4 + 0.3,
  );
  tl.fromTo(
    '#es-i1',
    { scale: 0, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.25, ease: 'back.out(3)' },
    S4 + 1.05,
  );
  tl.fromTo(
    '#es-i2',
    { scale: 0, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.25, ease: 'back.out(3)' },
    S4 + 1.4,
  );
  tl.fromTo(
    '#es-stage',
    { scale: 1, opacity: 1 },
    { scale: 0.9, opacity: 0, duration: 0.35, ease: 'power3.in', immediateRender: false },
    12.28,
  );

  tl.eventCallback('onUpdate', () => {
    const t = tl.time();
    apply();
    renderTerm(t - BAR);
    videoEm(graph, t - 0.1, 4);
    const n = Math.max(0, Math.min(WORD.length, Math.floor((t - S3 - 0.85) / 0.07)));
    palQ.textContent = WORD.slice(0, n);
  });
  apply();
  renderTerm(-1);
  return tl;
};
