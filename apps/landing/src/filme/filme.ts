import { gsap } from 'gsap';

import { lenis, reducedMotion } from '../scripts/chrome';
import { cafe } from './h/cafe';
import { celular } from './h/celular';
import { chat } from './h/chat';
import { estacoes } from './h/estacoes';
import { gancho } from './h/gancho';
import { marca } from './h/marca';
import { mesa } from './h/mesa';
import { CLIPES, DURACAO, FIM, INTRO, RITMO, type Clipe, type Orientacao } from './roteiro';
import { criarSala, type Sala } from './sala';
import type { Cena } from './util';
import { cafeV, travV } from './v/cafe';
import { celularV, fechamentoV } from './v/celular';
import { chatV } from './v/chat';
import { estacoesV } from './v/estacoes';
import { ganchoV } from './v/gancho';
import { mesaV } from './v/mesa';

/*
 * A página inteira é uma composição: um só player com as cenas do filme pousa
 * no monitor de cada seção, e a rolagem faz o papel do relógio. Entre uma seção
 * e a outra, o player voa de um monitor para o seguinte enquanto o clipe novo
 * começa a rodar.
 */

const CENAS: Record<Orientacao, readonly Cena[]> = {
  h: [
    { id: 'g1-gancho', dur: 6.316, montar: gancho },
    { id: 'cf-cafe', dur: 15.158, montar: cafe },
    { id: 'ms-mesa', dur: 7.579, montar: mesa },
    { id: 'ch-chat', dur: 5.052, montar: chat },
    { id: 'es-estacoes', dur: 12.632, montar: estacoes },
    { id: 'cl-celular', dur: 15.158, montar: celular },
    { id: 'mk-marca', dur: 10.105, montar: marca },
  ],
  v: [
    { id: 'v1-gancho', dur: 6.316, montar: ganchoV },
    { id: 'vc-cafe', dur: 10.105, montar: cafeV },
    { id: 'vt-trav', dur: 2.526, montar: travV },
    { id: 'vm-mesa', dur: 7.579, montar: mesaV },
    { id: 'vh-chat', dur: 5.053, montar: chatV },
    { id: 've-estacoes', dur: 12.632, montar: estacoesV },
    { id: 'vp-celular', dur: 5.052, montar: celularV },
    { id: 'vf-fechamento', dur: 10.105, montar: fechamentoV },
  ],
};

const CAFE = new Set([
  'cf-cafe',
  'cl-celular',
  'mk-marca',
  'vc-cafe',
  'vp-celular',
  'vf-fechamento',
]);

/**
 * Cortes da página sobre o filme, em segundos a partir do início ou do fim de
 * cada clipe. A transição da página (a grade de pixels) substitui as do filme:
 * cada clipe sai antes da própria saída e entra depois da própria entrada, o
 * gancho sai antes do cursor crescer e o café entra sem a grade dele.
 */
const CORTE: Readonly<Record<string, readonly [number, number]>> = {
  gancho: [0, -0.716],
  cafe: [0.3, -0.45],
  chat: [0.6, -0.45],
  estacoes: [0.5, -0.45],
  celular: [0.9, -0.45],
  marca: [0.3, 0],
};
const CORTE_PADRAO = [0, -0.45] as const;
/** No 9:16 a Mesa começa depois do antigo mergulho (vt-trav), que não aparece mais. */
const CORTE_V: Readonly<Record<string, readonly [number, number]>> = {
  mesa: [2.6, -0.45],
};

/** Rolagem de cada transição, em alturas de tela. */
const TRANSICAO = 0.9;

/** Rolagem por segundo de filme, em alturas de tela. */
const ROLAGEM_POR_SEGUNDO = 0.42;

/** Velocidade da digitação dos passos, em segundos de filme por letra. */
const POR_LETRA = 0.028;

const vertical = window.matchMedia('(max-aspect-ratio: 17/20)');

interface Montado {
  readonly tl: gsap.core.Timeline;
  readonly cenas: readonly {
    readonly el: HTMLElement;
    readonly id: string;
    readonly fim: number;
  }[];
  readonly videos: readonly HTMLVideoElement[];
}

/** Junta as cenas de um corte numa linha do tempo só. */
function montar(palco: HTMLElement, cenas: readonly Cena[], sala: Sala): Montado {
  const tl = gsap.timeline({ paused: true });
  const lista: { el: HTMLElement; id: string; fim: number }[] = [];
  let t = 0;
  for (const c of cenas) {
    const el = palco.querySelector<HTMLElement>(`[data-cena="${c.id}"]`);
    if (!el) continue;
    const sub = c.montar(el, sala);
    sub.paused(false);
    tl.add(sub, t);
    t += c.dur;
    lista.push({ el, id: c.id, fim: t });
  }
  tl.to({}, { duration: 0.001 }, t);
  return { tl, cenas: lista, videos: [...palco.querySelectorAll('video')] };
}

/** As palavras de impacto da página, no tempo do filme. */
function montarSlams(): gsap.core.Timeline {
  const tl = gsap.timeline({ paused: true });
  document.querySelectorAll<HTMLElement>('[data-slam]').forEach((b) => {
    const s = Number(b.dataset.start);
    const d = Number(b.dataset.dur);
    tl.fromTo(
      b,
      { scale: 1.5, opacity: 0, y: 0 },
      { scale: 1, opacity: 1, duration: 0.09, ease: 'power4.out', immediateRender: false },
      s,
    );
    tl.to(b, { scale: 0.94, opacity: 0, y: -14, duration: 0.1, ease: 'power2.in' }, s + d - 0.1);
  });
  tl.to({}, { duration: 0.001 }, DURACAO.h);
  return tl;
}

type Trecho = readonly [number, number, number];

interface Mapa {
  readonly total: number;
  tempo(p: number): number;
}

/** Rolagem → tempo dentro de um clipe, com os pesos do RITMO. */
function mapa(a: number, b: number, ritmo: readonly Trecho[]): Mapa {
  const trechos: Trecho[] = [];
  let x = a;
  for (const [ra, rb, w] of [...ritmo].sort((m, n) => m[0] - n[0])) {
    const ia = Math.max(ra, x);
    const ib = Math.min(rb, b);
    if (ib <= ia) continue;
    if (ia > x) trechos.push([x, ia, 1]);
    trechos.push([ia, ib, w]);
    x = ib;
  }
  if (x < b) trechos.push([x, b, 1]);
  const total = trechos.reduce((s, [m, n, w]) => s + (n - m) * w, 0);
  return {
    total,
    tempo(p) {
      let resto = Math.max(0, Math.min(1, p)) * total;
      for (const [m, n, w] of trechos) {
        const len = (n - m) * w;
        if (resto <= len) return m + resto / w;
        resto -= len;
      }
      return b;
    },
  };
}

interface Passo {
  readonly li: HTMLElement;
  readonly letras: readonly HTMLElement[];
  t: number;
  fim: number;
  estado: string;
  n: number;
}

interface Secao {
  readonly clipe: Clipe;
  readonly el: HTMLElement;
  readonly monitor: HTMLElement;
  readonly tela: boolean;
  readonly passos: Passo[];
  readonly ancora: HTMLElement;
  /** O que sai e entra em sequência nas transições. */
  readonly pecas: readonly HTMLElement[];
  /** Trecho do filme que roda com a seção no palco. */
  a: number;
  b: number;
  m: Mapa;
  /** Começo do trecho na rolagem da composição, e o tamanho dele, em px. */
  y: number;
  len: number;
  /** Monitor no palco, medido no layout. */
  r: Retangulo;
}

interface Retangulo {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;
const limite = (f: number): number => Math.max(0, Math.min(1, f));
const suave = (f: number): number => (f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2);
const saida = (f: number): number => 1 - (1 - f) ** 3;

export function initFilme(): void {
  const raiz = document.querySelector<HTMLElement>('[data-composicao]');
  const estagio = raiz?.querySelector<HTMLElement>('[data-estagio]');
  const player = raiz?.querySelector<HTMLElement>('[data-player]');
  const wipe = player?.querySelector<HTMLElement>('[data-wipe]');
  if (!raiz || !estagio || !player || !wipe) return;
  const fecha = raiz.querySelector<HTMLElement>('[data-fecha]');
  const cursor = document.createElement('i');
  cursor.className = 'passo-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  const sala = criarSala();
  const montados: Partial<Record<Orientacao, Montado>> = {};
  const slams = montarSlams();
  const parado = reducedMotion();

  const secoes: Secao[] = CLIPES.flatMap((clipe) => {
    const el = raiz.querySelector<HTMLElement>(`[data-clipe="${clipe.id}"]`);
    const monitor = el?.querySelector<HTMLElement>('[data-monitor]');
    if (!el || !monitor) return [];
    const passos = [...el.querySelectorAll<HTMLElement>('[data-passo]')].map((li) => {
      const alvoTexto = li.querySelector<HTMLElement>('.passo-t') ?? li;
      const letras = Array.from(alvoTexto.textContent, (c) => {
        const span = document.createElement('span');
        span.textContent = c;
        return span;
      });
      alvoTexto.replaceChildren(...letras);
      return { li, letras, t: 0, fim: 0, estado: '', n: -1 };
    });
    // O id vai para uma âncora na rolagem: a seção vira camada do palco.
    const ancora = document.createElement('span');
    ancora.className = 'ancora';
    ancora.id = el.id;
    el.removeAttribute('id');
    raiz.appendChild(ancora);
    return [
      {
        clipe,
        el,
        monitor,
        tela: clipe.arranjo === 'tela',
        passos,
        ancora,
        pecas: [
          ...el.querySelectorAll<HTMLElement>(
            '.clipe-cab, .passos li, .clipe-corpo, .monitor-tag, .abre, .slams',
          ),
        ],
        a: 0,
        b: 0,
        m: mapa(0, 1, []),
        y: 0,
        len: 0,
        r: { x: 0, y: 0, w: 0, h: 0 },
      },
    ];
  });
  if (secoes.length === 0) return;
  raiz.toggleAttribute('data-vivo', true);

  let o: Orientacao = vertical.matches ? 'v' : 'h';
  let ativa = '';
  let fimVisivel = false;
  let introFeita = parado || window.scrollY > 10;
  let intro: gsap.core.Tween | null = null;
  const estado = { t: 0 };
  let alvo = -1;
  let noAr = false;
  let transicao = 0;
  let celulas: HTMLElement[] = [];
  let atraso: number[] = [];

  /** Tempos, rolagem, monitores e a grade da transição para o corte atual. */
  const medir = (): void => {
    o = vertical.matches ? 'v' : 'h';
    const palco = raiz.querySelector<HTMLElement>(`[data-palco="${o}"]`);
    if (palco) montados[o] ??= montar(palco, CENAS[o], sala);
    ativa = '';
    const vh = window.innerHeight;
    transicao = Math.round(vh * TRANSICAO);
    const base = estagio.getBoundingClientRect();
    let y = 0;
    secoes.forEach((s, i) => {
      const [a, b] = s.clipe[o];
      const [ca, cb] =
        (o === 'v' ? CORTE_V[s.clipe.id] : undefined) ?? CORTE[s.clipe.id] ?? CORTE_PADRAO;
      s.a = s.clipe.id === 'gancho' ? INTRO : a + ca;
      s.b = b + cb;
      s.m = mapa(s.a, s.b, RITMO[o]);
      s.len = Math.round(s.m.total * vh * ROLAGEM_POR_SEGUNDO);
      if (i > 0) y += transicao;
      s.y = y;
      s.ancora.style.top = `${String(y)}px`;
      y += s.len;
      const m = s.monitor.getBoundingClientRect();
      s.r = { x: m.left - base.left, y: m.top - base.top, w: m.width, h: m.height };
      s.passos.forEach((p, k) => {
        const def = s.clipe.passos[k];
        // Passo que cairia antes do corte entra logo no começo do trecho.
        p.t = Math.max(def ? def[o] : 0, s.a + 0.1);
        p.n = -1;
        p.estado = '';
      });
      s.passos.forEach((p, k) => {
        p.fim = s.passos[k + 1]?.t ?? s.b + 1;
      });
    });
    raiz.style.height = `${String(y + vh)}px`;

    // Grade da transição: diagonal a partir do canto de cima.
    const [cols, rows] = o === 'h' ? [16, 9] : [9, 16];
    wipe.style.setProperty('--cols', String(cols));
    wipe.style.setProperty('--rows', String(rows));
    celulas = Array.from({ length: cols * rows }, () => document.createElement('i'));
    atraso = celulas.map(
      (_, k) => ((k % cols) / cols) * 0.55 + (Math.floor(k / cols) / rows) * 0.45,
    );
    wipe.replaceChildren(...celulas);
  };

  /** Índice do clipe que contém o tempo t. */
  const trecho = (t: number): number => {
    let i = 0;
    secoes.forEach((s, k) => {
      if (t >= s.clipe[o][0]) i = k;
    });
    return i;
  };

  /** Quadro do filme: cena no ar, sala, vídeos e passos. */
  const desenhar = (): void => {
    const mo = montados[o];
    if (!mo) return;
    const t = estado.t;
    mo.tl.time(t);
    if (o === 'h') slams.time(t);
    const cena = mo.cenas.find((c) => t < c.fim) ?? mo.cenas[mo.cenas.length - 1];
    if (cena && cena.id !== ativa) {
      ativa = cena.id;
      for (const c of mo.cenas) c.el.classList.toggle('no-ar', c === cena);
      if (CAFE.has(cena.id) && noAr) sala.retomar();
      else sala.pausar();
      // iOS só mostra quadros de vídeo depois de um play.
      for (const v of mo.videos)
        if (v.readyState < 2 && cena.el.contains(v))
          void v
            .play()
            .then(() => {
              v.pause();
            })
            .catch(() => undefined);
    }

    for (const s of secoes)
      for (const p of s.passos) {
        const e = parado ? 'agora' : t < p.t ? 'futuro' : t < p.fim ? 'agora' : 'passado';
        if (e !== p.estado) {
          p.estado = e;
          p.li.dataset.estado = e;
        }
        const total = p.letras.length;
        let n = 0;
        if (e === 'agora') n = parado ? total : Math.min(total, Math.floor((t - p.t) / POR_LETRA));
        if (n !== p.n) {
          const [de, ate] = n > p.n ? [Math.max(0, p.n), n] : [n, p.n];
          for (let i = de; i < ate; i++) p.letras[i]?.classList.toggle('on', i < n);
          p.n = n;
          if (e === 'agora' && !parado) (p.letras[n - 1] ?? p.letras[0])?.after(cursor);
        }
      }

    const mostrar = t >= FIM[o] - 0.01;
    if (mostrar !== fimVisivel && fecha) {
      fimVisivel = mostrar;
      gsap.to(fecha, {
        autoAlpha: mostrar ? 1 : 0,
        y: mostrar ? 0 : 16,
        duration: 0.4,
        ease: 'power2.out',
      });
    }
  };

  let ret: Retangulo = { x: 0, y: 0, w: 0, h: 0 };
  let raio = -1;

  const pousar = (r: Retangulo, tela: number): void => {
    if (r.x !== ret.x || r.y !== ret.y || r.w !== ret.w || r.h !== ret.h) {
      ret = r;
      player.style.transform = `translate3d(${r.x.toFixed(2)}px, ${r.y.toFixed(2)}px, 0)`;
      player.style.width = `${r.w.toFixed(2)}px`;
      player.style.height = `${r.h.toFixed(2)}px`;
      const [lw, lh] = o === 'h' ? [1920, 1080] : [1080, 1920];
      const contem = Math.min(r.w / lw, r.h / lh);
      const cobre = Math.max(r.w / lw, r.h / lh);
      // Em tela cheia o filme corta um pouco das bordas; no monitor, cabe inteiro.
      const s = Math.min(cobre, contem * (o === 'v' ? 1.1 : 1.25));
      player.style.setProperty('--s', s.toFixed(5));
    }
    const rr = (1 - tela) * 10;
    if (Math.abs(rr - raio) > 0.01) {
      raio = rr;
      player.style.setProperty('--raio', `${rr.toFixed(2)}px`);
      player.style.setProperty('--borda', (1 - tela).toFixed(3));
    }
  };

  /** Peças de uma camada: saem subindo (f de 0 a 1) ou entram subindo. */
  const pecas = (s: Secao, f: number, entrando: boolean): void => {
    s.pecas.forEach((el, k) => {
      const atrasoK = k * 0.06;
      const local = limite((f - atrasoK) / 0.55);
      const e = entrando ? saida(local) : local * local;
      const y = entrando ? (1 - e) * 26 : -e * 26;
      const op = entrando ? e : 1 - e;
      el.style.transform = y ? `translateY(${y.toFixed(2)}px)` : '';
      el.style.opacity = op < 1 ? op.toFixed(3) : '';
    });
  };
  const limpar = (s: Secao): void => {
    for (const el of s.pecas) {
      el.style.transform = '';
      el.style.opacity = '';
    }
  };

  /** A grade: enche (f de 0 a 0,5) e esvazia (0,5 a 1) em degraus, pela diagonal. */
  const grade = (f: number | null): void => {
    wipe.toggleAttribute('data-on', f !== null);
    if (f === null) return;
    const enche = f < 0.5;
    const g = enche ? limite((f - 0.04) / 0.42) : limite((f - 0.54) / 0.42);
    celulas.forEach((c, k) => {
      const local = limite((g - (atraso[k] ?? 0) * 0.55) / 0.45);
      const q = Math.ceil(local * 4) / 4;
      const escala = enche ? q : 1 - q;
      const ciano = enche ? local > 0 && local < 0.35 : local > 0.7 && local < 1;
      c.style.transform = `scale(${escala.toFixed(2)})`;
      c.style.background = ciano ? 'var(--cyan)' : '';
    });
  };

  let camada = -1;
  let par = -1;

  /** Lê a rolagem, escolhe camada ou transição e põe o player no monitor. */
  const quadro = (): void => {
    const caixa = raiz.getBoundingClientRect();
    let pos = -caixa.top;
    let t = alvo;
    let r: Retangulo | null = null;
    let tela = 0;
    let esta = secoes.length - 1;
    let f: number | null = null;

    for (let i = 0; i < secoes.length; i++) {
      const s = secoes[i];
      if (!s) continue;
      if (pos <= s.len || i === secoes.length - 1) {
        esta = i;
        const p = limite(pos / Math.max(1, s.len));
        if (s.clipe.id === 'gancho' && !introFeita) {
          if (p > 0.002) {
            introFeita = true;
            intro?.kill();
            t = s.m.tempo(p);
          } else t = -1;
        } else t = parado ? s.b - 0.3 : s.m.tempo(p);
        r = s.r;
        tela = s.tela ? 1 : 0;
        break;
      }
      pos -= s.len;
      const prox = secoes[i + 1];
      if (prox && pos < transicao) {
        // Transição: o texto sai, a grade cobre o filme, o player vai ao
        // monitor seguinte e a grade abre no clipe novo.
        esta = i;
        f = limite(pos / transicao);
        const e = suave(limite((f - 0.2) / 0.6));
        r = {
          x: lerp(s.r.x, prox.r.x, e),
          y: lerp(s.r.y, prox.r.y, e),
          w: lerp(s.r.w, prox.r.w, e),
          h: lerp(s.r.h, prox.r.h, e),
        };
        tela = lerp(s.tela ? 1 : 0, prox.tela ? 1 : 0, e);
        t = f < 0.5 ? s.b - 0.02 : prox.a;
        if (parado) t = f < 0.5 ? s.b - 0.3 : prox.b - 0.3;
        if (!introFeita) {
          introFeita = true;
          intro?.kill();
        }
        break;
      }
      pos -= transicao;
    }

    // Camadas visíveis e peças de texto.
    const emTransicao = f !== null;
    if (esta !== camada || emTransicao || par !== -1) {
      secoes.forEach((s, k) => {
        const viva = k === esta || (emTransicao && k === esta + 1);
        s.el.toggleAttribute('data-ativo', viva);
      });
      if (emTransicao && !parado) {
        const a = secoes[esta];
        const b = secoes[esta + 1];
        if (a) pecas(a, limite((f ?? 0) / 0.5), false);
        if (b) pecas(b, limite(((f ?? 0) - 0.45) / 0.55), true);
        par = esta;
      } else {
        if (par !== -1) {
          const a = secoes[par];
          const b = secoes[par + 1];
          if (a) limpar(a);
          if (b) limpar(b);
        }
        par = -1;
        if (emTransicao) {
          // Sem movimento: troca seca no meio.
          secoes.forEach((s, k) => {
            s.el.toggleAttribute('data-ativo', k === ((f ?? 0) < 0.5 ? esta : esta + 1));
          });
        }
      }
      camada = esta;
    }
    grade(emTransicao && !parado ? f : null);

    const visivel = r !== null && caixa.bottom > 0;
    if (visivel !== noAr) {
      noAr = visivel;
      player.toggleAttribute('data-no-ar', visivel);
      if (!visivel) sala.pausar();
      else if (CAFE.has(ativa)) sala.retomar();
    }
    if (r && visivel) pousar(r, tela);

    // O tempo anda suave dentro de um trecho e salta nos cortes.
    if (t >= 0) {
      alvo = t;
      const d = alvo - estado.t;
      // Nunca suaviza através de um corte: a cena da seção anterior não volta.
      if (parado || Math.abs(d) > 1.2 || trecho(alvo) !== trecho(estado.t)) estado.t = alvo;
      else if (Math.abs(d) > 1e-4) estado.t += d * (lenis ? 0.35 : 0.22);
      else estado.t = alvo;
      if (Math.abs(d) > 1e-5 || parado) desenhar();
    }
    requestAnimationFrame(quadro);
  };

  medir();
  // As fontes mudam a largura do texto e, com ela, o lugar dos monitores.
  void document.fonts.ready.then(() => {
    medir();
    ret = { x: 0, y: 0, w: 0, h: 0 };
  });
  if (!introFeita) {
    // O gancho digita sozinho; quem rolar antes pula para o fim da frase.
    desenhar();
    intro = gsap.to(estado, {
      t: INTRO,
      duration: INTRO,
      delay: 0.3,
      ease: 'none',
      onUpdate: desenhar,
      onComplete() {
        introFeita = true;
      },
    });
  }
  requestAnimationFrame(quadro);

  let espera = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(espera);
    espera = window.setTimeout(() => {
      const antes = o;
      medir();
      ret = { x: 0, y: 0, w: 0, h: 0 };
      camada = -1;
      if (antes !== o) {
        alvo = -1;
        estado.t = 0;
        desenhar();
      }
    }, 150);
  });
}
