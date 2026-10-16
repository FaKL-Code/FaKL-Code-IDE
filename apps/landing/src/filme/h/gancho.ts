import { gsap } from 'gsap';

import { langDoDocumento, textos } from '../../i18n';
import { q, type Montar } from '../util';

/** Fonte de pixels 5×7 do título da abertura. */
const FONTE: Readonly<Record<string, readonly string[]>> = {
  J: ['..###', '....#', '....#', '....#', '#...#', '#...#', '.###.'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
};

/** Os três agentes trabalham ao mesmo tempo, cada um num terço das letras. */
const AGENTES = [
  { nome: 'Claude', cor: '#e08a62' },
  { nome: 'Codex', cor: '#3ecf8e' },
  { nome: 'Gemini', cor: '#6ea8ff' },
] as const;

const INICIO = 0.5;
const FIM_OBRA = 3.4;
const PRONTO = 3.7;

interface Quadro {
  /** Lado de cada pixel, em pixels do palco. */
  readonly lado: number;
  /** Canto superior esquerdo da palavra no palco. */
  readonly x: number;
  readonly y: number;
  /** A palavra quebrada em linhas: uma no 16:9, duas no 9:16. */
  readonly linhas: readonly string[];
}

/**
 * Abertura: a palavra JUNTOS. em pixels gigantes, montada ao vivo por três
 * cursores (Claude, Codex e Gemini), cada um nas suas letras, em paralelo.
 */
export function montarJuntos(root: HTMLElement, sel: string, quadro: Quadro): gsap.core.Timeline {
  const palco = q(root, sel);
  const { lado, x, y } = quadro;
  const largura = (l: string): number =>
    Array.from(l, (c) => FONTE[c]?.[0]?.length ?? 0).reduce((a, b) => a + b + 1, -1);
  const maior = Math.max(...quadro.linhas.map(largura));
  const letras = quadro.linhas.flatMap((l, li) =>
    Array.from(l, (c, k) => ({ c, li, primeira: k === 0, recuo: (maior - largura(l)) / 2 })),
  );
  let coluna = 0;
  const porLetra = letras.map(({ c, li, primeira, recuo }) => {
    if (primeira) coluna = Math.round(recuo);
    const topo = y + li * 9 * lado;
    const linhas = FONTE[c] ?? [];
    const cols = linhas[0]?.length ?? 0;
    const pontos: { el: HTMLElement; cx: number; cy: number }[] = [];
    // Coluna a coluna, de cima para baixo, como quem pinta.
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < linhas.length; j++)
        if (linhas[j]?.[i] === '#') {
          const el = document.createElement('i');
          const px = x + (coluna + i) * lado;
          const py = topo + j * lado;
          el.style.cssText = `left:${String(px)}px;top:${String(py)}px;width:${String(lado - 4)}px;height:${String(lado - 4)}px`;
          if (c === '.') el.className = 'ponto';
          palco.appendChild(el);
          pontos.push({ el, cx: px + lado / 2, cy: py + lado / 2 });
        }
    coluna += cols + 1;
    return pontos;
  });

  const equipes = AGENTES.map((a, k) => {
    // JUNTOS. (7 letras) fica 2, 2 e 3; TOGETHER. (9) fica 3, 3 e 3.
    const de = Math.floor((k * porLetra.length) / AGENTES.length);
    const ate = Math.floor(((k + 1) * porLetra.length) / AGENTES.length);
    const pontos = porLetra.slice(de, ate).flat();
    for (const p of pontos) p.el.style.setProperty('--cor', a.cor);
    const cursor = document.createElement('div');
    cursor.className = 'juntos-cursor';
    cursor.style.setProperty('--cor', a.cor);
    cursor.style.animationDelay = `${String(-k * 1.7)}s`;
    cursor.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2l17 9-7.5 1.8L9 21z"/></svg><span>${a.nome}</span>`;
    palco.appendChild(cursor);
    // Terminado, o cursor descansa embaixo das próprias letras.
    const base = Math.max(...pontos.map((p) => p.cy));
    const ultimaLinha = pontos.filter((p) => p.cy > base - lado * 7);
    const meio = ultimaLinha.reduce((m, p) => m + p.cx, 0) / Math.max(1, ultimaLinha.length);
    const descanso = { x: meio - lado * 1.2, y: base + lado * 0.9 };
    return { pontos, cursor, n: -1, descanso };
  });

  const tl = gsap.timeline({ paused: true });
  tl.set({}, {}, 6.316);
  tl.eventCallback('onUpdate', () => {
    const t = tl.time();
    const pronto = t >= PRONTO;
    palco.classList.toggle('pronto', pronto);
    for (const e of equipes) {
      const total = e.pontos.length;
      const f = Math.max(0, Math.min(1, (t - INICIO) / (FIM_OBRA - INICIO))) * total;
      const n = Math.floor(f);
      if (n !== e.n) {
        e.pontos.forEach((p, i) => p.el.classList.toggle('on', i < n));
        e.n = n;
      }
      // O cursor vai de um pixel ao seguinte; quando termina, desce para descansar.
      const a = e.pontos[Math.min(total - 1, Math.max(0, n - 1))];
      const b = e.pontos[Math.min(total - 1, n)];
      const u = f - n;
      let cx = (a?.cx ?? x) + ((b?.cx ?? x) - (a?.cx ?? x)) * u;
      let cy = (a?.cy ?? y) + ((b?.cy ?? y) - (a?.cy ?? y)) * u;
      if (t < INICIO) {
        cx = b?.cx ?? x;
        cy = y - lado * 2;
      } else if (t > FIM_OBRA) {
        const v = Math.min(1, (t - FIM_OBRA) / 0.6);
        const s = 1 - (1 - v) ** 3;
        cx += (e.descanso.x - cx) * s;
        cy += (e.descanso.y - cy) * s;
      }
      e.cursor.style.transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px)`;
      e.cursor.style.opacity = t < INICIO - 0.3 ? '0' : '1';
    }
  });
  return tl;
}

/** 0–6,3 s no 16:9. A palavra de abertura muda com o idioma (JUNTOS. / TOGETHER.). */
export const gancho: Montar = (root) => {
  const en = langDoDocumento() === 'en';
  return montarJuntos(root, '#g1-juntos', {
    lado: en ? 30 : 40,
    x: en ? 225 : 220,
    y: en ? 275 : 240,
    linhas: textos(langDoDocumento()).cena.abertura.h,
  });
};
