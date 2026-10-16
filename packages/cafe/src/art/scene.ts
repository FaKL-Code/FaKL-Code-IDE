import { Pix, shade } from '../pixel.js';
import type { SpriteDef } from '../sprites.js';
import { C } from './palette.js';

/*
 * Desenhos provisórios do cenário (documento de assets, grupo G). Servem
 * para a cena funcionar e para fixar tamanho e âncora de cada arquivo; os
 * PNGs gerados por difusão entram por cima, com o mesmo nome e tamanho.
 */

type Pt = readonly [number, number];
type Paint = (p: Pix, o: Pt, frame: number) => void;

/**
 * Objeto de chão que ocupa `fw` x `fd` ladrilhos e sobe até `top` px acima do
 * canto de trás. A âncora é o canto de trás do chão (x e y mínimos).
 */
function prop(
  id: string,
  file: string,
  fw: number,
  fd: number,
  top: number,
  paint: Paint,
  frames = 1,
  outline = true,
): SpriteDef {
  const w = Math.ceil((fw + fd) * 16) + 2;
  const h = Math.ceil((fw + fd) * 8) + top + 2;
  const ax = Math.round(fd * 16) + 1;
  const ay = top + 1;
  return {
    id,
    file,
    w,
    h,
    frames,
    rows: 1,
    ax,
    ay,
    outline,
    paint: (p) => {
      for (let f = 0; f < frames; f++) {
        p.frame(f, 0, w, h);
        paint(p, [ax, ay], f);
      }
    },
  };
}

const iso = (o: Pt, x: number, y: number, z = 0): Pt => Pix.iso(o, x, y, z);

// --- Planos das paredes ----------------------------------------------------

/** Parede do fundo: `u` para a direita (desce meio pixel por pixel), `v` para cima. */
const backPlane =
  (bx: number, by: number) =>
  (u: number, v: number): Pt => [bx + u, by + Math.floor(u / 2) - v];

/** Parede da esquerda: `u` para a direita (sobe meio pixel por pixel), `v` para cima. */
const leftPlane =
  (bx: number, by: number) =>
  (u: number, v: number): Pt => [bx + u, by - Math.ceil(u / 2) - v];

type Plane = (u: number, v: number) => Pt;

function wrect(
  p: Pix,
  plane: Plane,
  u: number,
  v: number,
  w: number,
  h: number,
  color: string,
): void {
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      const [x, y] = plane(u + i, v + j);
      p.px(x, y, color);
    }
  }
}

function wclear(p: Pix, plane: Plane, u: number, v: number, w: number, h: number): void {
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      const [x, y] = plane(u + i, v + j);
      p.px(x, y, [0, 0, 0, 0]);
    }
  }
}

export const WALL_H = 72;

/** Uma coluna de parede: rodapé, lambri, papel de parede, neon e acabamento. */
function wallColumn(p: Pix, plane: Plane, u: number, worldU: number, dark: boolean): void {
  const k = dark ? -0.2 : 0;
  const t = (c: string) => (k ? shade(c, k) : c);
  for (let v = 0; v < WALL_H; v++) {
    let color: string;
    if (v < 3) color = t('#111827');
    else if (v < 24) color = worldU % 8 === 0 ? t(shade(C.wainscot, -0.25)) : t(C.wainscot);
    else if (v === 24) color = t(C.wainscotRail);
    else if (v === 25) color = t(shade(C.wainscotRail, -0.3));
    else if (v === 57 || v === 60) color = C.neonDim;
    else if (v === 58 || v === 59) color = C.neon;
    else if (v >= 69) color = v === 71 ? t(C.capLight) : t(C.cap);
    else if (v > 25 && v < 57 && (worldU + v * 2) % 12 === 0 && v % 6 === 0) color = t(C.wallLight);
    else color = t(C.wall);
    const [x, y] = plane(u, v);
    p.px(x, y, color);
  }
}

const wallBack: SpriteDef = {
  id: 'wall-back',
  file: 'tiles/wall-back.png',
  w: 16,
  h: 80,
  frames: 1,
  rows: 1,
  ax: 0,
  ay: WALL_H,
  outline: false,
  paint: (p) => {
    const plane = backPlane(0, WALL_H - 1);
    for (let u = 0; u < 16; u++) wallColumn(p, plane, u, u, false);
  },
};

const wallLeft: SpriteDef = {
  id: 'wall-left',
  file: 'tiles/wall-left.png',
  w: 16,
  h: 80,
  frames: 1,
  rows: 1,
  ax: 16,
  ay: WALL_H,
  outline: false,
  paint: (p) => {
    const plane = leftPlane(0, 79);
    for (let u = 0; u < 16; u++) wallColumn(p, plane, u, u, true);
  },
};

function leftDouble(
  id: string,
  file: string,
  frames: number,
  paint: (p: Pix, plane: Plane, f: number) => void,
): SpriteDef {
  return {
    id,
    file,
    w: 32,
    h: 88,
    frames,
    rows: 1,
    ax: 32,
    ay: WALL_H,
    outline: false,
    paint: (p) => {
      for (let f = 0; f < frames; f++) {
        p.frame(f, 0, 32, 88);
        const plane = leftPlane(0, 87);
        for (let u = 0; u < 32; u++) wallColumn(p, plane, u, u, true);
        paint(p, plane, f);
      }
    },
  };
}

/** Janela: o vidro fica vazado; o céu e a cidade são desenhados por trás, conforme a hora. */
const windowLeft = leftDouble('wall-left-window', 'tiles/wall-left-window.png', 1, (p, plane) => {
  wrect(p, plane, 3, 17, 26, 3, C.capLight);
  wrect(p, plane, 3, 16, 26, 1, shade(C.cap, -0.3));
  wrect(p, plane, 5, 20, 22, 42, C.cap);
  wrect(p, plane, 6, 21, 20, 40, shade(C.cap, 0.15));
  wclear(p, plane, 7, 22, 18, 38);
  wrect(p, plane, 15, 22, 2, 38, C.cap);
  wrect(p, plane, 7, 40, 18, 1, C.cap);
  // Cortininha (bandô) no alto.
  wrect(p, plane, 4, 59, 24, 4, C.blueDark);
  for (let u = 4; u < 28; u += 3) wrect(p, plane, u, 58, 2, 1, C.blueDark);
  wrect(p, plane, 4, 62, 24, 1, C.blueLight);
});

function door(p: Pix, plane: Plane, open: boolean): void {
  wrect(p, plane, 5, 2, 22, 54, C.cap);
  wrect(p, plane, 6, 2, 20, 53, shade(C.cap, 0.12));
  if (open) {
    wrect(p, plane, 7, 2, 18, 51, '#0b1220');
    wrect(p, plane, 7, 2, 18, 5, '#1f2937');
    for (let u = 9; u < 25; u += 4) wrect(p, plane, u, 2, 2, 5, '#2b3647');
    wrect(p, plane, 7, 2, 3, 51, '#4a3426');
    wrect(p, plane, 9, 2, 1, 51, '#3a2a1e');
  } else {
    wrect(p, plane, 7, 2, 18, 51, '#4a3426');
    wrect(p, plane, 9, 6, 14, 14, '#56402f');
    wrect(p, plane, 9, 24, 14, 12, '#56402f');
    wrect(p, plane, 12, 40, 8, 8, '#1e3a5f');
    wrect(p, plane, 13, 41, 6, 6, '#2b5d8f');
    wrect(p, plane, 13, 46, 2, 1, C.blueLight);
    wrect(p, plane, 22, 26, 2, 2, C.yellow);
  }
  // Luz de "aberto" em cima do batente.
  wrect(p, plane, 15, 57, 2, 2, C.neon);
  wrect(p, plane, 14, 56, 4, 1, C.neonDim);
}

const doorClosed = leftDouble('wall-left-door', 'tiles/wall-left-door.png', 1, (p, plane) => {
  door(p, plane, false);
});
const doorOpen = leftDouble(
  'wall-left-door-open',
  'tiles/wall-left-door-open.png',
  1,
  (p, plane) => {
    door(p, plane, true);
  },
);

// --- Piso ------------------------------------------------------------------

function tile(id: string, file: string, color: (x: number, y: number) => string): SpriteDef {
  return {
    id,
    file,
    w: 32,
    h: 16,
    frames: 1,
    rows: 1,
    ax: 16,
    ay: 0,
    outline: false,
    paint: (p) => {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 32; x++) {
          const dx = Math.abs(x + 0.5 - 16) / 16;
          const dy = Math.abs(y + 0.5 - 8) / 8;
          if (dx + dy <= 1) p.px(x, y, color(x, y));
        }
      }
    },
  };
}

const floorA = tile('floor-a', 'tiles/floor-a.png', (x, y) =>
  x + 2 * y < 17 && x + 2 * y >= 14 && x < 16 ? shade(C.floorA, 0.12) : C.floorA,
);
const floorB = tile('floor-b', 'tiles/floor-b.png', (x, y) =>
  x + 2 * y < 17 && x + 2 * y >= 14 && x < 16 ? shade(C.floorB, 0.1) : C.floorB,
);
const floorCarpet = tile('floor-carpet', 'tiles/floor-carpet.png', (x, y) =>
  (x + 2 * y) % 8 === 0 && y % 2 === 0
    ? C.carpetDark
    : (x * 3 + y * 5) % 23 === 0
      ? shade(C.carpet, 0.12)
      : C.carpet,
);
const floorWood = tile('floor-wood', 'tiles/floor-wood.png', (x, y) => {
  const band = Math.floor((y - x / 2 + 32) / 4);
  const seam = Math.floor(y - x / 2 + 32) % 4 === 0;
  if (seam) return shade(C.plankDark, -0.2);
  return band % 2 ? C.plank : C.plankDark;
});

const floorEdgeLeft: SpriteDef = {
  id: 'floor-edge-left',
  file: 'tiles/floor-edge-left.png',
  w: 16,
  h: 14,
  frames: 1,
  rows: 1,
  ax: 0,
  ay: 0,
  outline: false,
  paint: (p) => {
    p.poly(
      [
        [0, 0],
        [16, 8],
        [16, 14],
        [0, 6],
      ],
      '#151c28',
    );
    p.line(0, 0, 15, 7, '#334155');
  },
};

const floorEdgeRight: SpriteDef = {
  id: 'floor-edge-right',
  file: 'tiles/floor-edge-right.png',
  w: 16,
  h: 14,
  frames: 1,
  rows: 1,
  ax: 16,
  ay: 0,
  outline: false,
  paint: (p) => {
    p.poly(
      [
        [16, 0],
        [0, 8],
        [0, 14],
        [16, 6],
      ],
      '#0b1220',
    );
    p.line(15, 0, 0, 7, '#253045');
  },
};

// --- Mobília ---------------------------------------------------------------

const desk = prop('desk', 'props/desk.png', 1.6, 0.7, 16, (p, o) => {
  const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
  const legs = [C.woodLight, C.woodDark, C.woodDeep] as const;
  p.box(P(0.04, 0.06), 0.1, 0.58, 12, legs);
  p.box(P(0.14, 0.06), 1.32, 0.06, 9, legs, 3);
  p.box(P(1.1, 0.16), 0.28, 0.46, 11, [C.dark, C.darker, C.darkest]);
  const led = P(1.16, 0.62, 8);
  p.px(led[0], led[1], C.neon);
  const vent = P(1.22, 0.62, 4);
  p.px(vent[0], vent[1], C.darkest);
  p.px(vent[0] + 2, vent[1] + 1, C.darkest);
  p.box(P(1.46, 0.06), 0.1, 0.58, 12, legs);
  p.box(P(0, 0), 1.6, 0.7, 2, [C.wood, C.woodDark, C.woodDeep], 12);
  p.line(...P(0.05, 0.02, 14), ...P(1.55, 0.02, 14), C.woodLight);
  p.box(P(0.3, 0.42), 0.62, 0.16, 1, ['#4b5563', '#374151', C.dark], 14);
  for (let i = 0; i < 5; i++) {
    const k = P(0.36 + i * 0.11, 0.48, 15);
    p.px(k[0], k[1], '#6b7280');
  }
  p.box(P(1.1, 0.46), 0.1, 0.12, 1, [C.metal, C.metalMid, C.metalDark], 14);
});

/** Monitor: a tela de 21x15 fica vazada para a miniatura do agente entrar por trás. */
const monitor: SpriteDef = {
  id: 'monitor-front',
  file: 'props/monitor-front.png',
  w: 27,
  h: 32,
  frames: 1,
  rows: 1,
  ax: 12,
  ay: 28,
  outline: false,
  paint: (p) => {
    for (let c = 1; c <= 23; c++) {
      const top = 1 + Math.floor((c - 1) / 2);
      for (let r = top; r <= top + 16; r++) p.px(c, r, C.ink);
      p.px(c, top, '#2d2d38');
      p.px(c, top - 1, C.out);
      p.px(c, top + 17, C.out);
    }
    for (let c = 2; c <= 22; c++) {
      const top = 1 + Math.floor((c - 1) / 2);
      for (let r = top + 1; r <= top + 15; r++) p.px(c, r, [0, 0, 0, 0]);
    }
    for (let r = 1; r <= 18; r++) p.px(0, r, C.out);
    const rightTop = 1 + Math.floor(22 / 2);
    for (let r = rightTop; r <= rightTop + 16; r++) p.px(24, r + 1, '#2d2d38');
    for (let r = rightTop; r <= rightTop + 18; r++) p.px(25, r + 1, C.out);
    p.px(21, 1 + Math.floor(20 / 2) + 16, C.neon);
    p.rect(11, 24, 3, 3, '#2d2d38');
    p.rect(10, 24, 1, 3, C.out);
    p.rect(14, 24, 1, 3, C.out);
    p.poly(
      [
        [6, 28],
        [12, 25],
        [18, 28],
        [12, 31],
      ],
      '#2d2d38',
    );
    p.line(6, 28, 12, 25, C.out);
    p.line(12, 25, 18, 28, C.out);
    p.line(18, 28, 12, 31, C.out);
    p.line(12, 31, 6, 28, C.out);
  },
};

const chairColors = ['#4a4a5e', '#3a3a48', '#2e2e3a'] as const;

const chair = prop(
  'chair',
  'props/chair.png',
  0.5,
  0.5,
  28,
  (p, o, f) => {
    const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
    const c = P(0.25, 0.25);
    p.line(c[0] - 5, c[1], c[0] + 5, c[1], '#2b2b33');
    p.line(c[0], c[1] - 2, c[0], c[1] + 2, '#2b2b33');
    p.rect(c[0] - 1, c[1] - 9, 2, 9, '#2b2b33');
    const t = f === 1 ? -0.06 : f === 2 ? 0.06 : 0;
    if (f === 3) p.box(P(0.05, 0), 0.4, 0.07, 14, chairColors, 11);
    p.box(P(0.05, 0.05), 0.4, 0.4, 3, chairColors, 9);
    if (f !== 3) {
      p.box(P(0.05 + t, 0.42 - t), 0.4, 0.07, 14, ['#555570', '#454558', '#3a3a48'], 11);
      p.line(...P(0.07 + t, 0.49 - t, 21), ...P(0.43 + t, 0.49 - t, 21), C.neon);
    } else {
      p.line(...P(0.07, 0.07, 21), ...P(0.43, 0.07, 21), C.neon);
    }
  },
  4,
);

const waterCooler = prop(
  'water-cooler',
  'props/water-cooler.png',
  0.6,
  0.6,
  44,
  (p, o, f) => {
    const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
    p.box(P(0.05, 0.05), 0.5, 0.5, 22, [C.metal, C.metalMid, C.metalDark]);
    p.box(P(0.08, 0.5), 0.3, 0.06, 3, [C.darker, C.darkest, C.darkest], 6);
    const tapA = P(0.18, 0.55, 15);
    const tapB = P(0.36, 0.55, 15);
    p.rect(tapA[0], tapA[1], 2, 2, C.blue);
    p.rect(tapB[0], tapB[1], 2, 2, C.red);
    p.box(P(0.12, 0.12), 0.36, 0.36, 15, [C.waterLight, C.water, '#5aa9e6'], 22);
    p.box(P(0.2, 0.2), 0.2, 0.2, 4, [C.waterLight, C.water, '#5aa9e6'], 37);
    p.line(...P(0.15, 0.48, 24), ...P(0.15, 0.48, 35), '#e0f2fe');
    const b1 = P(0.26, 0.48, 23 + ((f * 4) % 13));
    const b2 = P(0.38, 0.48, 23 + ((f * 4 + 7) % 13));
    p.px(b1[0], b1[1], '#ffffff');
    p.px(b2[0], b2[1], '#ffffff');
    p.px(b2[0] + 1, b2[1], '#e0f2fe');
  },
  4,
);

const barCounter = prop('bar-counter', 'props/bar-counter.png', 3.4, 0.6, 26, (p, o) => {
  const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
  p.box(P(0, 0), 3.4, 0.6, 20, [C.woodLight, C.wood, C.woodDark]);
  for (let x = 0.4; x < 3.4; x += 0.42) p.line(...P(x, 0.6, 4), ...P(x, 0.6, 18), C.woodDark);
  p.line(...P(0, 0.6, 3), ...P(3.4, 0.6, 3), C.neon);
  p.box(P(-0.05, -0.05), 3.5, 0.7, 3, ['#e7e5e4', '#a8a29e', '#78716c'], 20);
  p.line(...P(-0.03, 0.63, 23), ...P(3.43, 0.63, 23), '#fafaf9');
  for (const x of [0.25, 0.45])
    p.box(P(x, 0.15), 0.12, 0.12, 4, [C.cream, '#e7e2d0', '#cfc8b0'], 23);
  // Redoma de doces.
  p.box(P(1.3, 0.1), 0.4, 0.4, 2, ['#d6d3d1', '#a8a29e', '#78716c'], 23);
  const dome = P(1.5, 0.3, 30);
  p.ellipse(dome[0], dome[1], 6, 5, '#bae6fd');
  p.ellipse(dome[0], dome[1] + 2, 4, 2, C.orange);
  p.px(dome[0] - 3, dome[1] - 3, '#ffffff');
});

const barShelf = prop('bar-shelf', 'props/bar-shelf.png', 2.4, 0.35, 48, (p, o) => {
  const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
  const wood = [C.woodLight, C.wood, C.woodDark] as const;
  p.box(P(0, 0), 2.4, 0.35, 12, [C.wood, C.woodDark, C.woodDeep]);
  for (let x = 0.2; x < 2.3; x += 0.75)
    p.box(P(x, 0.33), 0.5, 0.02, 9, [C.woodLight, C.woodLight, C.woodLight], 2);
  p.box(P(0, 0), 0.08, 0.35, 46, wood);
  const bottles = ['#16a34a', '#b45309', '#2563eb', '#be123c', C.cream, '#facc15'];
  for (const [n, z] of [12, 26, 40].entries()) {
    p.box(P(0, 0), 2.4, 0.35, 2, wood, z);
    for (let i = 0; i < 6; i++) {
      const x = 0.25 + i * 0.38;
      const color = bottles[(i + n * 3) % bottles.length] ?? C.cream;
      const tall = (i + n) % 3 === 0;
      if (color === C.cream)
        p.box(P(x, 0.1), 0.12, 0.12, 4, [C.cream, '#e7e2d0', '#cfc8b0'], z + 2);
      else {
        p.box(
          P(x, 0.1),
          0.1,
          0.1,
          tall ? 9 : 6,
          [shade(color, 0.3), color, shade(color, -0.3)],
          z + 2,
        );
        const neck = P(x + 0.05, 0.15, z + 2 + (tall ? 9 : 6) + 2);
        p.rect(neck[0], neck[1], 1, 2, shade(color, -0.4));
      }
    }
  }
  p.box(P(2.32, 0), 0.08, 0.35, 46, wood);
});

const espresso = prop(
  'espresso',
  'props/espresso.png',
  0.55,
  0.4,
  24,
  (p, o, f) => {
    const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
    // Corpo cromado, painel escuro no alto e xícaras em cima.
    p.box(P(0, 0), 0.55, 0.4, 16, [C.metal, C.metalMid, C.metalDark]);
    p.poly([P(0.03, 0.4, 11), P(0.52, 0.4, 11), P(0.52, 0.4, 15), P(0.03, 0.4, 15)], C.darker);
    const l1 = P(0.1, 0.4, 13);
    const l2 = P(0.2, 0.4, 13);
    p.px(l1[0], l1[1], f ? C.orange : C.green);
    p.px(l2[0], l2[1], C.neon);
    for (const x of [0.08, 0.3])
      p.box(P(x, 0.12), 0.12, 0.12, 3, [C.cream, '#e7e2d0', '#cfc8b0'], 16);
    // Grupo, porta-filtro com cabo e bandeja.
    p.box(P(0.2, 0.4), 0.14, 0.1, 3, [C.darker, C.darkest, C.darkest], 7);
    p.line(...P(0.34, 0.5, 8), ...P(0.55, 0.62, 8), C.ink);
    p.box(P(0.05, 0.4), 0.45, 0.14, 1, [C.metalDark, C.dark, C.darker], 0);
    p.box(P(0.22, 0.42), 0.1, 0.1, 3, [C.cream, '#e7e2d0', '#cfc8b0'], 1);
    if (f) {
      const drip = P(0.27, 0.47, 6);
      p.px(drip[0], drip[1], '#78350f');
    }
  },
  2,
);

const barStool = prop('bar-stool', 'props/bar-stool.png', 0.4, 0.4, 16, (p, o) => {
  const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
  const c = P(0.2, 0.2);
  p.ellipse(c[0], c[1], 5, 2.5, C.metalDark);
  p.rect(c[0] - 1, c[1] - 12, 2, 12, C.metalMid);
  p.ellipse(c[0], c[1] - 5, 4, 2, C.metalDark);
  p.ellipse(c[0], c[1] - 12, 6, 3, '#9f1239');
  p.ellipse(c[0], c[1] - 13, 6, 3, '#e11d48');
  p.px(c[0] - 3, c[1] - 14, '#fb7185');
});

const arcade = prop(
  'arcade',
  'props/arcade.png',
  0.8,
  0.6,
  50,
  (p, o, f) => {
    const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
    p.box(P(0, 0), 0.8, 0.6, 46, [C.purpleLight, C.purple, C.purpleDark]);
    p.box(P(0, 0.05), 0.8, 0.55, 3, [C.pink, C.pink, '#c23b62'], 46);
    p.poly([P(0.08, 0.6, 26), P(0.72, 0.6, 26), P(0.72, 0.6, 39), P(0.08, 0.6, 39)], '#0a0a12');
    const dots = [
      [0.2 + 0.1 * f, 33, C.pink],
      [0.55, 30 + (f % 2) * 2, C.neon],
      [0.4, 36 - f, C.yellow],
    ] as const;
    for (const [x, z, color] of dots) {
      const d = P(x, 0.6, z);
      p.rect(d[0], d[1], 2, 2, color);
    }
    p.poly([P(0.05, 0.6, 41), P(0.75, 0.6, 41), P(0.75, 0.6, 45), P(0.05, 0.6, 45)], C.yellow);
    p.box(P(0.05, 0.6), 0.7, 0.18, 3, [C.dark, C.darker, C.darkest], 20);
    const stick = P(0.25, 0.7, 23);
    p.rect(stick[0], stick[1] - 3, 1, 3, C.metal);
    p.rect(stick[0] - 1, stick[1] - 4, 3, 2, C.red);
    for (const [x, color] of [
      [0.5, C.neon],
      [0.6, C.yellow],
    ] as const) {
      const b = P(x, 0.7, 23);
      p.rect(b[0], b[1] - 1, 2, 1, color);
    }
    p.line(...P(0.8, 0.05, 8), ...P(0.8, 0.55, 40), C.pink);
  },
  4,
);

const jukebox = prop(
  'jukebox',
  'props/jukebox.png',
  0.8,
  0.5,
  38,
  (p, o, f) => {
    const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
    p.box(P(0, 0), 0.8, 0.5, 30, [C.woodLight, C.wood, C.woodDark]);
    p.box(P(0.1, 0), 0.6, 0.5, 5, [C.woodLight, C.wood, C.woodDark], 30);
    p.poly([P(0.08, 0.5, 3), P(0.72, 0.5, 3), P(0.72, 0.5, 10), P(0.08, 0.5, 10)], C.darker);
    for (let x = 0.12; x < 0.7; x += 0.12) p.line(...P(x, 0.5, 4), ...P(x, 0.5, 9), C.dark);
    const hues = [C.pink, C.yellow, C.neon, C.purpleLight, C.green, C.orange];
    for (let i = 0; i < 6; i++) {
      const color = hues[(i + f) % hues.length] ?? C.neon;
      const x = 0.12 + i * 0.1;
      p.line(...P(x, 0.5, 13), ...P(x, 0.5, 27 + (i === 2 || i === 3 ? 4 : 0)), color);
    }
    p.poly([P(0.25, 0.5, 18), P(0.55, 0.5, 18), P(0.55, 0.5, 24), P(0.25, 0.5, 24)], '#111827');
    const disc = P(0.4, 0.5, 21);
    p.rect(disc[0] - 1, disc[1], 3, 1, f % 2 ? C.metal : C.metalMid);
  },
  4,
);

const poolTable = prop('pool-table', 'props/pool-table.png', 2.2, 1.2, 14, (p, o) => {
  const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
  const leg = [C.woodDark, C.woodDeep, '#3f2f22'] as const;
  for (const [x, y] of [
    [0.05, 0.05],
    [2.0, 0.05],
    [0.05, 1.0],
    [2.0, 1.0],
  ] as const)
    p.box(P(x, y), 0.15, 0.15, 8, leg);
  p.box(P(0, 0), 2.2, 1.2, 4, [C.woodDark, C.wood, C.woodDeep], 8);
  p.poly([P(0.12, 0.12, 12), P(2.08, 0.12, 12), P(2.08, 1.08, 12), P(0.12, 1.08, 12)], C.felt);
  p.line(...P(0.12, 0.13, 12), ...P(2.08, 0.13, 12), C.feltDark);
  p.line(...P(0.13, 0.12, 12), ...P(0.13, 1.08, 12), C.feltDark);
  for (const [x, y] of [
    [0.1, 0.1],
    [1.1, 0.1],
    [2.1, 0.1],
    [0.1, 1.1],
    [1.1, 1.1],
    [2.1, 1.1],
  ] as const) {
    const h = P(x, y, 12);
    p.rect(h[0] - 1, h[1] - 1, 2, 2, C.out);
  }
  const spot = P(1.6, 0.6, 12);
  p.px(spot[0], spot[1], '#86efac');
});

const sofa = prop('sofa', 'props/sofa.png', 2, 0.8, 22, (p, o) => {
  const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
  const body = [C.sofa, C.sofaDark, C.sofaDeep] as const;
  for (const x of [0.05, 1.85]) p.box(P(x, 0.7), 0.1, 0.08, 2, [C.darker, C.darkest, C.darkest]);
  p.box(P(0, 0), 2, 0.25, 19, [shade(C.sofa, 0.15), C.sofaDark, C.sofaDeep]);
  p.box(P(0, 0.1), 2, 0.7, 8, body, 1);
  for (const x of [0.24, 1.02]) {
    p.box(P(x, 0.27), 0.74, 0.5, 3, [shade(C.sofa, 0.2), C.sofa, C.sofaDark], 9);
    p.box(P(x, 0.12), 0.74, 0.15, 8, [shade(C.sofa, 0.25), shade(C.sofa, 0.1), C.sofaDark], 9);
  }
  p.box(P(0, 0.1), 0.22, 0.7, 6, body, 8);
  p.box(P(1.78, 0.1), 0.22, 0.7, 6, body, 8);
  // Almofada de enfeite.
  p.box(P(0.3, 0.2), 0.25, 0.1, 6, [C.yellow, '#eab308', '#ca8a04'], 12);
});

const coffeeTable = prop('coffee-table', 'props/coffee-table.png', 1, 0.6, 12, (p, o) => {
  const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
  const leg = [C.woodDark, C.woodDeep, '#3f2f22'] as const;
  for (const [x, y] of [
    [0.05, 0.05],
    [0.85, 0.05],
    [0.05, 0.45],
    [0.85, 0.45],
  ] as const)
    p.box(P(x, y), 0.1, 0.1, 6, leg);
  p.box(P(0, 0), 1, 0.6, 2, [C.woodLight, C.wood, C.woodDark], 6);
  p.box(P(0.15, 0.15), 0.35, 0.25, 1, [C.blueLight, C.blue, C.blueDark], 8);
  p.box(P(0.65, 0.25), 0.12, 0.12, 4, [C.cream, '#e7e2d0', '#cfc8b0'], 8);
});

const rug = prop(
  'rug',
  'props/rug.png',
  4,
  2.4,
  2,
  (p, o) => {
    const P = (x: number, y: number) => iso(o, x, y, 0);
    p.poly([P(0, 0), P(4, 0), P(4, 2.4), P(0, 2.4)], '#5b4a8a');
    p.poly([P(0.15, 0.15), P(3.85, 0.15), P(3.85, 2.25), P(0.15, 2.25)], '#3b2f5c');
    p.poly([P(0.35, 0.35), P(3.65, 0.35), P(3.65, 2.05), P(0.35, 2.05)], '#463870');
    p.poly([P(2, 0.6), P(3, 1.2), P(2, 1.8), P(1, 1.2)], '#5b4a8a');
    p.poly([P(2, 0.85), P(2.6, 1.2), P(2, 1.55), P(1.4, 1.2)], C.neonDim);
  },
  1,
  false,
);

const floorLamp = prop('floor-lamp', 'props/floor-lamp.png', 0.35, 0.35, 48, (p, o) => {
  const c = iso(o, 0.175, 0.175, 0);
  p.ellipse(c[0], c[1], 5, 2, C.darker);
  p.rect(c[0], c[1] - 38, 1, 38, C.metalMid);
  p.poly(
    [
      [c[0] - 4, c[1] - 46],
      [c[0] + 4, c[1] - 46],
      [c[0] + 7, c[1] - 37],
      [c[0] - 7, c[1] - 37],
    ],
    '#fde68a',
  );
  p.line(c[0] - 6, c[1] - 38, c[0] + 6, c[1] - 38, '#f59e0b');
  p.line(c[0] - 3, c[1] - 45, c[0] - 5, c[1] - 39, '#fef3c7');
});

function leaves(p: Pix, cx: number, cy: number, size: number): void {
  const blobs = [
    [-0.6, 0.2, 0.55, C.leafDark],
    [0.6, 0.25, 0.55, C.leafDark],
    [0, -0.4, 0.6, C.leafMid],
    [-0.45, -0.15, 0.45, C.leafMid],
    [0.45, -0.1, 0.45, C.leafMid],
    [-0.2, -0.7, 0.35, C.leaf],
    [-0.5, -0.35, 0.25, C.leaf],
    [0.25, -0.5, 0.3, C.leaf],
  ] as const;
  for (const [dx, dy, r, color] of blobs)
    p.ellipse(cx + dx * size, cy + dy * size, r * size, r * size * 0.9, color);
  p.px(cx - size * 0.3, cy - size * 0.8, '#86efac');
}

const plantTall = prop('plant-tall', 'props/plant-tall.png', 0.5, 0.5, 46, (p, o) => {
  const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
  p.box(P(0.08, 0.08), 0.34, 0.34, 11, [C.pot, C.pot, C.potDark]);
  p.box(P(0.1, 0.1), 0.3, 0.3, 1, ['#3f2a1e', '#3f2a1e', '#3f2a1e'], 10);
  const c = P(0.25, 0.25, 30);
  p.rect(c[0], c[1] + 4, 1, 16, C.leafDark);
  leaves(p, c[0], c[1], 13);
});

const plantSmall = prop('plant-small', 'props/plant-small.png', 0.4, 0.4, 24, (p, o) => {
  const P = (x: number, y: number, z = 0) => iso(o, x, y, z);
  p.box(P(0.08, 0.08), 0.24, 0.24, 7, [C.pot, C.pot, C.potDark]);
  const c = P(0.2, 0.2, 15);
  leaves(p, c[0], c[1], 8);
});

// --- Parede do fundo: relógio, placar, cardápio, neon ------------------------

/** Relógio: só o mostrador; os ponteiros são da hora real, em código. Centro em (8, 9). */
const wallClock: SpriteDef = {
  id: 'wall-clock',
  file: 'props/wall-clock.png',
  w: 17,
  h: 19,
  frames: 1,
  rows: 1,
  ax: 8,
  ay: 9,
  paint: (p) => {
    p.ellipse(8.5, 9.5, 7, 8, C.cap);
    p.ellipse(8.5, 9.5, 6, 7, C.cream);
    for (const [x, y] of [
      [8, 3],
      [14, 9],
      [8, 16],
      [2, 9],
    ] as const)
      p.px(x, y, C.ink);
  },
};

/** Placar do dia: moldura e três linhas vazias; números e ícones são escritos em código. */
const scoreboard: SpriteDef = {
  id: 'scoreboard',
  file: 'props/scoreboard.png',
  w: 50,
  h: 54,
  frames: 1,
  rows: 1,
  ax: 1,
  ay: 28,
  paint: (p) => {
    const plane = backPlane(1, 28);
    wrect(p, plane, 0, 0, 48, 28, C.cap);
    wrect(p, plane, 1, 1, 46, 26, '#0b0f19');
    wrect(p, plane, 1, 21, 46, 6, '#0e2a3a');
    wrect(p, plane, 1, 21, 46, 1, C.neon);
    for (let u = 4; u < 44; u += 3) wrect(p, plane, u, 23, 2, 2, C.neonDim);
    wrect(p, plane, 0, 27, 48, 1, C.capLight);
  },
};

/** Cardápio de giz sobre o balcão. Rabiscos sem letras. */
const menuBoard: SpriteDef = {
  id: 'menu-board',
  file: 'props/menu-board.png',
  w: 40,
  h: 42,
  frames: 1,
  rows: 1,
  ax: 1,
  ay: 23,
  paint: (p) => {
    const plane = backPlane(1, 23);
    wrect(p, plane, 0, 0, 37, 23, C.woodDark);
    wrect(p, plane, 1, 1, 35, 21, C.chalk);
    // Xícara desenhada em giz.
    wrect(p, plane, 3, 13, 5, 4, '#d6d3d1');
    wrect(p, plane, 8, 14, 1, 2, '#d6d3d1');
    wrect(p, plane, 4, 18, 1, 2, '#a8a29e');
    wrect(p, plane, 6, 18, 1, 2, '#a8a29e');
    for (const [v, len] of [
      [16, 14],
      [12, 18],
      [8, 12],
      [4, 16],
    ] as const) {
      for (let u = 11; u < 11 + len; u += 3) wrect(p, plane, u, v, 2, 1, '#e7e5e4');
      wrect(p, plane, 31, v, 3, 1, C.yellow);
    }
  },
};

/** Letreiro de neon de xícara. Quadro 2 é a piscada. */
const neonSign: SpriteDef = {
  id: 'neon-sign',
  file: 'props/neon-sign.png',
  w: 24,
  h: 31,
  frames: 2,
  rows: 1,
  ax: 1,
  ay: 19,
  outline: false,
  paint: (p) => {
    for (let f = 0; f < 2; f++) {
      p.frame(f, 0, 24, 31);
      const plane = backPlane(1, 19);
      const lit = f === 0 ? C.neon : C.neonDim;
      const pink = f === 0 ? C.pink : '#9d3a58';
      wrect(p, plane, 3, 3, 1, 9, lit);
      wrect(p, plane, 14, 3, 1, 9, lit);
      wrect(p, plane, 4, 2, 10, 1, lit);
      wrect(p, plane, 2, 0, 15, 1, lit);
      wrect(p, plane, 15, 9, 3, 1, lit);
      wrect(p, plane, 17, 5, 1, 4, lit);
      wrect(p, plane, 15, 5, 2, 1, lit);
      for (const [u, v] of [
        [6, 14],
        [7, 15],
        [6, 16],
        [7, 17],
        [10, 14],
        [11, 15],
        [10, 16],
        [11, 17],
      ] as const)
        wrect(p, plane, u, v, 1, 1, pink);
    }
  },
};

/**
 * Pôster da marca na parede da esquerda, entre as janelas: banner 4:3 (28x21)
 * inclinado no ângulo da parede (1 px para cima a cada 2 colunas), por isso 28x35.
 */
const poster: SpriteDef = {
  id: 'poster',
  file: 'props/poster.png',
  w: 28,
  h: 35,
  frames: 1,
  rows: 1,
  ax: 8,
  ay: 30,
  paint: (p) => {
    // Provisório com a mesma inclinação da arte; u é a coluna e r a linha do banner (de cima para baixo).
    const plane: Plane = (u, r) => [u, 14 + r - Math.ceil(u / 2)];
    wrect(p, plane, 2, 2, 24, 17, '#0d1117');
    wrect(p, plane, 4, 6, 20, 10, C.blue);
    wrect(p, plane, 5, 7, 18, 8, '#111827');
    wrect(p, plane, 4, 3, 20, 2, C.blueDark);
    wrect(p, plane, 7, 9, 1, 1, C.neon);
    wrect(p, plane, 8, 10, 1, 1, C.neon);
    wrect(p, plane, 7, 11, 1, 1, C.neon);
    wrect(p, plane, 10, 11, 4, 1, C.neon);
  },
};

function trophyDef(id: string, file: string, cup: string, dark: string): SpriteDef {
  return {
    id,
    file,
    w: 10,
    h: 12,
    frames: 1,
    rows: 1,
    ax: 5,
    ay: 11,
    paint: (p) => {
      p.rect(2, 1, 6, 4, cup);
      p.rect(3, 5, 4, 1, cup);
      p.rect(4, 6, 2, 2, dark);
      p.rect(3, 8, 4, 2, dark);
      p.px(1, 2, cup);
      p.px(8, 2, cup);
      p.px(3, 2, '#ffffff');
    },
  };
}

const trophies = [
  trophyDef('trophy-five-agents', 'props/trophy-five-agents.png', C.yellow, '#b45309'),
  trophyDef('trophy-hundred-prs', 'props/trophy-hundred-prs.png', '#c7d2fe', '#6366f1'),
  trophyDef('trophy-locked', 'props/trophy-locked.png', '#374151', '#1f2937'),
];

// --- Efeitos e céu ---------------------------------------------------------

const smoke: SpriteDef = {
  id: 'smoke',
  file: 'props/smoke.png',
  w: 12,
  h: 20,
  frames: 4,
  rows: 1,
  ax: 6,
  ay: 19,
  outline: false,
  paint: (p) => {
    for (let f = 0; f < 4; f++) {
      p.frame(f, 0, 12, 20);
      for (let i = 0; i < 3; i++) {
        const t = ((f + i * 1.33) % 4) / 4;
        const y = 17 - t * 15;
        const x = 6 + Math.sin(t * 6 + i) * 2;
        p.ellipse(x, y, 1.5 + t * 2.5, 1.5 + t * 2, t > 0.6 ? '#9ca3af' : '#6b7280');
      }
    }
  },
};

const steam: SpriteDef = {
  id: 'steam',
  file: 'props/steam.png',
  w: 6,
  h: 10,
  frames: 3,
  rows: 1,
  ax: 3,
  ay: 9,
  outline: false,
  paint: (p) => {
    for (let f = 0; f < 3; f++) {
      p.frame(f, 0, 6, 10);
      for (let i = 0; i < 4; i++) {
        const y = 9 - ((i * 3 + f) % 10);
        const x = 2 + ((i + f) % 2) + (i % 2);
        p.px(x, y, '#ffffff');
      }
    }
  },
};

const poolBalls: SpriteDef = {
  id: 'pool-balls',
  file: 'props/pool-balls.png',
  w: 3,
  h: 3,
  frames: 3,
  rows: 1,
  ax: 1,
  ay: 2,
  outline: false,
  paint: (p) => {
    ['#f8fafc', '#dc2626', '#facc15'].forEach((color, f) => {
      p.frame(f, 0, 3, 3);
      p.rect(0, 0, 3, 3, color);
      p.px(0, 0, [0, 0, 0, 0]);
      p.px(2, 0, [0, 0, 0, 0]);
      p.px(0, 2, [0, 0, 0, 0]);
      p.px(2, 2, shade(color, -0.4));
      p.px(1, 0, '#ffffff');
    });
  },
};

/** Cidade vista pela janela: quadro 1 de dia, quadro 2 de noite com janelas acesas. */
const skyline: SpriteDef = {
  id: 'skyline',
  file: 'sky/skyline.png',
  w: 40,
  h: 56,
  frames: 2,
  rows: 1,
  ax: 0,
  ay: 56,
  outline: false,
  paint: (p) => {
    const buildings = [
      [0, 6, 26],
      [5, 8, 38],
      [12, 6, 22],
      [17, 9, 44],
      [25, 7, 30],
      [31, 9, 36],
    ] as const;
    for (let f = 0; f < 2; f++) {
      p.frame(f, 0, 40, 56);
      const night = f === 1;
      buildings.forEach(([x, w, h], i) => {
        const body = night ? (i % 2 ? '#111827' : '#0b1220') : i % 2 ? '#64748b' : '#475569';
        p.rect(x, 56 - h, w, h, body);
        p.rect(x, 56 - h, 1, h, night ? '#1f2937' : '#94a3b8');
        for (let wy = 56 - h + 3; wy < 54; wy += 4) {
          for (let wx = x + 2; wx < x + w - 1; wx += 2) {
            const lit = (wx * 7 + wy * 13 + i) % 5 < 2;
            if (night && lit) p.px(wx, wy, (wx + wy) % 3 ? C.yellow : C.neon);
            else if (!night && (wx + wy) % 4 === 0) p.px(wx, wy, '#cbd5e1');
          }
        }
      });
      p.rect(19, 56 - 48, 1, 4, night ? C.red : '#94a3b8');
    }
  },
};

const sun: SpriteDef = {
  id: 'sky-sun',
  file: 'sky/sun.png',
  w: 9,
  h: 9,
  frames: 1,
  rows: 1,
  ax: 4,
  ay: 4,
  outline: false,
  paint: (p) => {
    p.ellipse(4.5, 4.5, 4.5, 4.5, '#fde68a');
    p.ellipse(4.5, 4.5, 3.2, 3.2, '#fbbf24');
  },
};

const moon: SpriteDef = {
  id: 'sky-moon',
  file: 'sky/moon.png',
  w: 9,
  h: 9,
  frames: 1,
  rows: 1,
  ax: 4,
  ay: 4,
  outline: false,
  paint: (p) => {
    p.ellipse(4.5, 4.5, 4, 4, '#f1f5f9');
    p.ellipse(6, 3.5, 3.4, 3.4, [0, 0, 0, 0]);
    p.px(3, 5, '#cbd5e1');
  },
};

export const sceneSprites: readonly SpriteDef[] = [
  wallBack,
  wallLeft,
  windowLeft,
  doorClosed,
  doorOpen,
  floorA,
  floorB,
  floorCarpet,
  floorWood,
  floorEdgeLeft,
  floorEdgeRight,
  desk,
  monitor,
  chair,
  waterCooler,
  barCounter,
  barShelf,
  espresso,
  barStool,
  arcade,
  jukebox,
  poolTable,
  sofa,
  coffeeTable,
  rug,
  floorLamp,
  plantTall,
  plantSmall,
  wallClock,
  scoreboard,
  menuBoard,
  neonSign,
  poster,
  ...trophies,
  smoke,
  steam,
  poolBalls,
  skyline,
  sun,
  moon,
];
