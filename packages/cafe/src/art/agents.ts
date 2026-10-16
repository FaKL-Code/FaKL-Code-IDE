import type { Pix } from '../pixel.js';
import { rgba } from '../pixel.js';
import type { SpriteDef } from '../sprites.js';
import { C, KEY } from './palette.js';

/*
 * Personagem provisório (documento de assets, grupo H): quadros de 32x48 com
 * o pé em (16, 46), pintados nas cores-chave para a troca de paleta. Cada
 * agente sai daqui com a camisa do provedor, a pele e o cabelo dele.
 */

export const FRAME_W = 32;
export const FRAME_H = 48;
export const FOOT_X = 16;
export const FOOT_Y = 46;

type View = 'front' | 'back';
type Arm =
  | 'down'
  | 'swingF'
  | 'swingB'
  | 'up'
  | 'upOut'
  | 'type'
  | 'type2'
  | 'head'
  | 'chin'
  | 'cup'
  | 'cupBack'
  | 'cupLow'
  | 'hold'
  | 'control'
  | 'gesture'
  | 'none';
type Legs = 'stand' | 'stepL' | 'stepR' | 'hidden' | 'lap';

interface Pose {
  readonly view: View;
  readonly legs: Legs;
  readonly armL: Arm;
  readonly armR: Arm;
  /** Sobe (negativo) ou desce o corpo inteiro. */
  readonly dy?: number;
  /** Desloca o corpo para os lados (girar na cadeira). */
  readonly dx?: number;
  /** Olhar para a direita (+1) ou esquerda (-1), só de frente. */
  readonly look?: number;
  readonly eyes?: 'open' | 'closed' | 'happy';
  readonly mouth?: 'smile' | 'open' | 'flat';
  /** Cabeça caída (dormindo). */
  readonly slump?: number;
  /** Fones no pescoço (pausado). */
  readonly neckPhones?: boolean;
  /** Cor da xícara ou copo na mão. */
  readonly cup?: string;
  /** Taco de sinuca, deslocado ao longo da linha. */
  readonly cue?: number;
}

function arm(p: Pix, side: 'L' | 'R', kind: Arm, s: number, view: View, pose: Pose): void {
  // Coluna externa do braço: 8 (esquerdo) ou 23 (direito); `x(k)` anda para dentro.
  const x = (k: number) => (side === 'L' ? 8 + k : 23 - k);
  const sleeve = (k: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) {
      p.px(x(k), y, side === 'L' ? KEY.shirt : KEY.shirtDark);
      p.px(x(k + 1), y, KEY.shirtDark);
    }
  };
  const skin = (k: number, y0: number, y1: number, w = 2) => {
    for (let y = y0; y <= y1; y++)
      for (let i = 0; i < w; i++) p.px(x(k + i), y, i === w - 1 ? KEY.skinDark : KEY.skin);
  };
  switch (kind) {
    case 'none':
      return;
    case 'down':
      sleeve(0, s, s + 4);
      skin(0, s + 5, s + 8);
      return;
    case 'swingF':
      sleeve(0, s, s + 4);
      skin(0, s + 5, s + 7);
      return;
    case 'swingB':
      sleeve(0, s + 1, s + 5);
      skin(0, s + 6, s + 9);
      return;
    case 'up':
      sleeve(0, s - 4, s + 1);
      skin(0, s - 9, s - 5);
      return;
    case 'upOut':
      sleeve(-1, s - 3, s + 1);
      skin(-1, s - 8, s - 4);
      return;
    case 'type':
    case 'type2': {
      const t = kind === 'type2' ? 1 : 0;
      sleeve(0, s + t, s + 4 + t);
      p.px(x(1), s + 5 + t, KEY.shirtDark);
      if (view === 'front') skin(1, s + 6 + t, s + 7 + t);
      return;
    }
    case 'control':
      sleeve(0, s, s + 4);
      p.px(x(1), s + 5, KEY.shirtDark);
      p.px(x(2), s + 5, KEY.shirtDark);
      return;
    case 'head':
      sleeve(0, s - 1, s + 2);
      sleeve(-1, s - 3, s - 1);
      skin(1, s - 8, s - 4);
      skin(2, s - 11, s - 9, 3);
      return;
    case 'chin':
      if (view === 'back') {
        sleeve(0, s - 1, s + 3);
        skin(1, s - 6, s - 2);
        return;
      }
      sleeve(0, s, s + 3);
      skin(1, s - 1, s + 2, 3);
      for (let y = s - 4; y <= s - 2; y++) for (let k = 4; k <= 6; k++) p.px(x(k), y, KEY.skin);
      return;
    case 'cup': {
      sleeve(0, s, s + 3);
      skin(1, s - 2, s + 1);
      const cup = pose.cup ?? C.cream;
      for (let y = s - 6; y <= s - 3; y++) for (let k = 3; k <= 5; k++) p.px(x(k), y, cup);
      p.px(x(3), s - 6, '#ffffff');
      return;
    }
    case 'cupBack': {
      sleeve(-1, s - 2, s + 2);
      p.px(x(-1), s - 3, KEY.shirtDark);
      const cup = pose.cup ?? C.cream;
      for (let y = s - 7; y <= s - 4; y++) for (let k = 2; k <= 3; k++) p.px(x(k), y, cup);
      return;
    }
    case 'cupLow': {
      sleeve(0, s, s + 4);
      skin(1, s + 5, s + 6, 3);
      const cup = pose.cup ?? C.cream;
      for (let y = s + 3; y <= s + 6; y++) for (let k = 4; k <= 6; k++) p.px(x(k), y, cup);
      return;
    }
    case 'hold':
      sleeve(0, s, s + 4);
      skin(2, s + 5, s + 6);
      return;
    case 'gesture':
      sleeve(0, s, s + 3);
      skin(-1, s - 3, s);
      p.px(x(-1), s - 4, KEY.skin);
      return;
    default:
      return;
  }
}

/** Pinta um quadro do personagem nas cores-chave. */
function body(p: Pix, pose: Pose): void {
  const dy = pose.dy ?? 0;
  const dx = pose.dx ?? 0;
  const view = pose.view;
  const ox = p.ox;
  p.ox += dx;
  const y = (n: number) => n + dy;

  // Pernas e sapatos.
  if (pose.legs === 'stand' || pose.legs === 'stepL' || pose.legs === 'stepR') {
    const left = pose.legs === 'stepL' ? 1 : pose.legs === 'stepR' ? -1 : 0;
    const right = -left;
    const leg = (x0: number, shift: number) => {
      for (let r = 35; r <= 42 + shift; r++)
        for (let i = 0; i < 4; i++) p.px(x0 + i, y(r), KEY.pants);
      for (let i = -1; i < 4; i++) {
        p.px(x0 + i + (x0 < 16 ? 0 : 1), y(43 + shift), '#3a3a48');
        p.px(x0 + i + (x0 < 16 ? 0 : 1), y(44 + shift), KEY.shoe);
        if (shift >= 0) p.px(x0 + i + (x0 < 16 ? 0 : 1), y(45 + shift), KEY.shoe);
      }
    };
    leg(11, Math.min(0, left));
    leg(17, Math.min(0, right));
    for (let r = 35; r <= 36; r++) for (let i = 15; i <= 16; i++) p.px(i, y(r), KEY.pants);
  } else if (pose.legs === 'lap') {
    for (let r = 34; r <= 37; r++) for (let i = 10; i <= 21; i++) p.px(i, y(r), KEY.pants);
    for (let r = 38; r <= 42; r++) {
      for (let i = 11; i <= 13; i++) p.px(i, y(r), KEY.pants);
      for (let i = 18; i <= 20; i++) p.px(i, y(r), KEY.pants);
    }
    for (let i = 10; i <= 14; i++) p.px(i, y(43), KEY.shoe);
    for (let i = 17; i <= 21; i++) p.px(i, y(43), KEY.shoe);
  } else {
    for (let i = 11; i <= 20; i++) p.px(i, y(35), KEY.pants);
  }

  // Tronco.
  const s = y(24);
  for (let r = 24; r <= 34; r++) {
    for (let i = 10; i <= 21; i++) {
      const dark = i >= 20 || r === 34;
      p.px(i, y(r), dark ? KEY.shirtDark : KEY.shirt);
    }
  }
  if (view === 'front') {
    p.px(15, y(24), KEY.skin);
    p.px(16, y(24), KEY.skinDark);
    p.rect(12, y(27), 2, 2, C.neon);
  } else {
    for (let r = 26; r <= 32; r += 3) p.px(15, y(r), KEY.shirtDark);
  }

  // Braços (o de trás primeiro).
  arm(p, 'L', pose.armL, s, view, pose);
  arm(p, 'R', pose.armR, s, view, pose);

  if (pose.armL === 'hold' || pose.armR === 'hold') {
    p.rect(11, s + 2, 10, 7, C.cream);
    p.rect(13, s + 4, 6, 1, '#94a3b8');
    p.rect(13, s + 6, 4, 1, '#94a3b8');
  }

  // Pescoço e cabeça.
  const hy = (n: number) => y(n) + (pose.slump ?? 0);
  for (let i = 14; i <= 17; i++) p.px(i, y(23), KEY.skinDark);
  for (let r = 12; r <= 22; r++) {
    for (let i = 10; i <= 21; i++) {
      if ((r === 12 || r === 22) && (i === 10 || i === 21)) continue;
      const dark = i === 21 || r === 22;
      p.px(i, hy(r), dark ? KEY.skinDark : KEY.skin);
    }
  }
  for (const i of [9, 22])
    for (let r = 16; r <= 18; r++) p.px(i, hy(r), i === 9 ? KEY.skin : KEY.skinDark);

  if (view === 'front') {
    // Cabelo de frente: topo, laterais e franja.
    for (let r = 8; r <= 13; r++) {
      for (let i = 10; i <= 21; i++) {
        if (r === 8 && (i < 12 || i > 19)) continue;
        p.px(i, hy(r), r >= 12 || i >= 20 ? KEY.hairDark : KEY.hair);
      }
    }
    for (let r = 11; r <= 15; r++) {
      p.px(9, hy(r), KEY.hairDark);
      p.px(10, hy(r), KEY.hair);
      p.px(21, hy(r), KEY.hairDark);
      p.px(22, hy(r), KEY.hairDark);
    }
    for (const i of [11, 12, 15, 16, 19]) p.px(i, hy(14), KEY.hairDark);
    p.px(13, hy(9), '#7a5236');
    p.px(14, hy(9), '#7a5236');
    // Rosto.
    const look = pose.look ?? 0;
    const eyes = pose.eyes ?? 'open';
    for (const ex of [13 + look, 18 + look]) {
      if (eyes === 'open') {
        p.px(ex, hy(16), KEY.eye);
        p.px(ex, hy(17), KEY.eye);
        p.px(ex + 1, hy(16), '#ffffff');
      } else if (eyes === 'happy') {
        p.px(ex - 1, hy(17), KEY.eye);
        p.px(ex, hy(16), KEY.eye);
        p.px(ex + 1, hy(17), KEY.eye);
      } else {
        p.px(ex, hy(17), KEY.eye);
        p.px(ex + 1, hy(17), KEY.eye);
      }
    }
    p.px(12 + look, hy(19), '#e8a3a3');
    p.px(19 + look, hy(19), '#e8a3a3');
    const mouth = pose.mouth ?? 'smile';
    if (mouth === 'open') {
      p.rect(15 + look, hy(19), 2, 2, '#7f1d1d');
    } else if (mouth === 'smile') {
      p.px(14 + look, hy(19), KEY.skinDark);
      p.px(15 + look, hy(20), KEY.skinDark);
      p.px(16 + look, hy(20), KEY.skinDark);
      p.px(17 + look, hy(19), KEY.skinDark);
    } else {
      p.px(15 + look, hy(20), KEY.skinDark);
      p.px(16 + look, hy(20), KEY.skinDark);
    }
  } else {
    // Cabelo de costas cobre a cabeça.
    for (let r = 8; r <= 21; r++) {
      for (let i = 10; i <= 21; i++) {
        if (r === 8 && (i < 12 || i > 19)) continue;
        p.px(i, hy(r), r >= 19 || i >= 20 ? KEY.hairDark : KEY.hair);
      }
    }
    for (let r = 11; r <= 18; r++) {
      p.px(9, hy(r), KEY.hairDark);
      p.px(22, hy(r), KEY.hairDark);
    }
    for (let r = 15; r <= 17; r++) {
      p.px(9, hy(r), KEY.skin);
      p.px(22, hy(r), KEY.skinDark);
    }
    p.px(13, hy(10), '#7a5236');
    p.px(14, hy(10), '#7a5236');
  }

  // Braço de trás da cabeça desenhado de novo por cima quando sobe.
  if (pose.armR === 'head' || pose.armR === 'up' || pose.armR === 'upOut')
    arm(p, 'R', pose.armR, s, view, pose);
  if (pose.armL === 'up' || pose.armL === 'upOut') arm(p, 'L', pose.armL, s, view, pose);
  if (pose.armR === 'cup' && view === 'front') arm(p, 'R', 'cup', s, view, pose);

  if (pose.neckPhones) {
    for (let i = 11; i <= 20; i++) p.px(i, y(23), '#2a2a2a');
    p.rect(9, y(23), 3, 3, '#2a2a2a');
    p.rect(20, y(23), 3, 3, '#2a2a2a');
    p.px(10, y(24), C.neon);
  }

  if (pose.cue !== undefined) {
    const t = pose.cue;
    p.line(3 + t, s + 11 - t / 2, 28 + t, s - 2 - t / 2, '#c99a5b');
    p.px(28 + t, s - 2 - t / 2, C.cream);
    p.rect(7 + t, s + 7, 2, 2, KEY.skin);
    p.rect(22 + t, s + 1, 2, 2, KEY.skin);
  }

  p.ox = ox;
}

interface Anim {
  readonly id: string;
  readonly file: string;
  readonly frames: readonly Pose[] | readonly (readonly Pose[])[];
}

function sheet(anim: Anim): SpriteDef {
  const rows = (
    Array.isArray(anim.frames[0]) ? anim.frames : [anim.frames]
  ) as readonly (readonly Pose[])[];
  const frames = rows[0]?.length ?? 1;
  return {
    id: anim.id,
    file: `agents/${anim.file}`,
    w: FRAME_W,
    h: FRAME_H,
    frames,
    rows: rows.length,
    ax: FOOT_X,
    ay: FOOT_Y,
    paint: (p) => {
      rows.forEach((list, r) => {
        list.forEach((pose, f) => {
          p.frame(f, r, FRAME_W, FRAME_H, r === 1 || r === 3);
          body(p, pose);
        });
      });
    },
  };
}

const walkFront: readonly Pose[] = [
  { view: 'front', legs: 'stand', armL: 'down', armR: 'down', look: 1 },
  { view: 'front', legs: 'stepL', armL: 'swingB', armR: 'swingF', look: 1, dy: -1 },
  { view: 'front', legs: 'stand', armL: 'down', armR: 'down', look: 1 },
  { view: 'front', legs: 'stepR', armL: 'swingF', armR: 'swingB', look: 1, dy: -1 },
];
const walkBack: readonly Pose[] = walkFront.map((pose) => ({ ...pose, view: 'back' }));

const seatBack = { view: 'back', legs: 'hidden' } as const;

const anims: readonly Anim[] = [
  // Linhas: baixo-direita, baixo-esquerda (espelhada), cima-direita, cima-esquerda (espelhada).
  { id: 'agent-walk', file: 'agent-walk.png', frames: [walkFront, walkFront, walkBack, walkBack] },
  {
    id: 'agent-sit-typing',
    file: 'agent-sit-typing.png',
    frames: [
      { ...seatBack, armL: 'type', armR: 'type2' },
      { ...seatBack, armL: 'type2', armR: 'type' },
      { ...seatBack, armL: 'type', armR: 'type', dy: 1 },
    ],
  },
  {
    id: 'agent-sit-idle',
    file: 'agent-sit-idle.png',
    frames: [
      { ...seatBack, armL: 'down', armR: 'down', dx: -1 },
      { ...seatBack, armL: 'down', armR: 'down', dx: 1 },
    ],
  },
  {
    id: 'agent-sit-thinking',
    file: 'agent-sit-thinking.png',
    frames: [
      { ...seatBack, armL: 'down', armR: 'chin' },
      { ...seatBack, armL: 'down', armR: 'chin', dx: 1 },
    ],
  },
  {
    id: 'agent-sit-hand-up',
    file: 'agent-sit-hand-up.png',
    frames: [
      { ...seatBack, armL: 'down', armR: 'up' },
      { ...seatBack, armL: 'down', armR: 'upOut' },
    ],
  },
  {
    id: 'agent-sit-scratch',
    file: 'agent-sit-scratch.png',
    frames: [
      { ...seatBack, armL: 'down', armR: 'head' },
      { ...seatBack, armL: 'down', armR: 'head', dy: 1 },
    ],
  },
  {
    id: 'agent-sit-paused',
    file: 'agent-sit-paused.png',
    frames: [
      { ...seatBack, armL: 'down', armR: 'down', neckPhones: true, dy: 1 },
      { ...seatBack, armL: 'down', armR: 'down', neckPhones: true, dy: 1, dx: 1 },
    ],
  },
  {
    id: 'agent-sit-sleep',
    file: 'agent-sit-sleep.png',
    frames: [
      { ...seatBack, armL: 'type', armR: 'type', slump: 3, dy: 1 },
      { ...seatBack, armL: 'type', armR: 'type', slump: 2, dy: 1 },
    ],
  },
  {
    id: 'agent-sit-stretch',
    file: 'agent-sit-stretch.png',
    frames: [
      { ...seatBack, armL: 'upOut', armR: 'upOut', dy: 1 },
      { ...seatBack, armL: 'up', armR: 'up', dy: -1 },
      { ...seatBack, armL: 'up', armR: 'up', dy: -1, dx: 1 },
      { ...seatBack, armL: 'upOut', armR: 'upOut' },
    ],
  },
  {
    id: 'agent-celebrate',
    file: 'agent-celebrate.png',
    frames: [
      { view: 'front', legs: 'stand', armL: 'up', armR: 'up', eyes: 'happy', mouth: 'open' },
      {
        view: 'front',
        legs: 'stand',
        armL: 'upOut',
        armR: 'upOut',
        eyes: 'happy',
        mouth: 'open',
        dy: -3,
      },
      {
        view: 'front',
        legs: 'stand',
        armL: 'up',
        armR: 'up',
        eyes: 'happy',
        mouth: 'open',
        dy: -5,
      },
      {
        view: 'front',
        legs: 'stand',
        armL: 'upOut',
        armR: 'upOut',
        eyes: 'happy',
        mouth: 'smile',
        dy: -2,
      },
    ],
  },
  {
    id: 'agent-deliver',
    file: 'agent-deliver.png',
    frames: [
      { view: 'front', legs: 'stand', armL: 'hold', armR: 'hold', mouth: 'smile' },
      { view: 'front', legs: 'stand', armL: 'hold', armR: 'hold', mouth: 'open', dy: -1 },
    ],
  },
  {
    id: 'agent-drink-water',
    file: 'agent-drink-water.png',
    frames: [
      { view: 'back', legs: 'stand', armL: 'down', armR: 'cupLow', cup: C.waterLight },
      { view: 'back', legs: 'stand', armL: 'down', armR: 'cupBack', cup: C.waterLight },
      { view: 'back', legs: 'stand', armL: 'down', armR: 'cupBack', cup: C.waterLight, slump: -1 },
    ],
  },
  {
    id: 'agent-cooler-chat',
    file: 'agent-cooler-chat.png',
    frames: [
      {
        view: 'front',
        legs: 'stand',
        armL: 'cupLow',
        armR: 'down',
        cup: C.waterLight,
        look: 1,
        mouth: 'smile',
      },
      {
        view: 'front',
        legs: 'stand',
        armL: 'cupLow',
        armR: 'gesture',
        cup: C.waterLight,
        look: 1,
        mouth: 'open',
      },
      {
        view: 'front',
        legs: 'stand',
        armL: 'cupLow',
        armR: 'down',
        cup: C.waterLight,
        look: 1,
        eyes: 'happy',
        mouth: 'open',
      },
    ],
  },
  {
    id: 'agent-drink-coffee',
    file: 'agent-drink-coffee.png',
    frames: [
      { view: 'back', legs: 'hidden', armL: 'down', armR: 'cupLow', cup: C.cream },
      { view: 'back', legs: 'hidden', armL: 'down', armR: 'cupBack', cup: C.cream },
      { view: 'back', legs: 'hidden', armL: 'control', armR: 'cupLow', cup: C.cream },
    ],
  },
  {
    id: 'agent-arcade',
    file: 'agent-arcade.png',
    frames: [
      { view: 'back', legs: 'stand', armL: 'control', armR: 'type' },
      { view: 'back', legs: 'stand', armL: 'type2', armR: 'control', dx: 1 },
    ],
  },
  {
    id: 'agent-pool',
    file: 'agent-pool.png',
    frames: [
      { view: 'front', legs: 'stand', armL: 'none', armR: 'none', cue: 0, look: 1 },
      { view: 'front', legs: 'stand', armL: 'none', armR: 'none', cue: -2, look: 1 },
      { view: 'front', legs: 'stand', armL: 'none', armR: 'none', cue: 2, look: 1, mouth: 'open' },
    ],
  },
  {
    id: 'agent-sofa-chat',
    file: 'agent-sofa-chat.png',
    frames: [
      { view: 'front', legs: 'lap', armL: 'down', armR: 'down', look: 1, mouth: 'smile', dy: 1 },
      { view: 'front', legs: 'lap', armL: 'down', armR: 'gesture', look: 1, mouth: 'open', dy: 1 },
    ],
  },
  {
    id: 'agent-sofa-sip',
    file: 'agent-sofa-sip.png',
    frames: [
      { view: 'front', legs: 'lap', armL: 'down', armR: 'cupLow', cup: C.cream, dy: 1 },
      {
        view: 'front',
        legs: 'lap',
        armL: 'down',
        armR: 'cup',
        cup: C.cream,
        eyes: 'closed',
        dy: 1,
      },
    ],
  },
];

/** Fone do maestro, desenhado por cima: de frente, de costas, de lado direito e esquerdo. */
const headset: SpriteDef = {
  id: 'agent-maestro-headset',
  file: 'agents/agent-maestro-headset.png',
  w: FRAME_W,
  h: FRAME_H,
  frames: 4,
  rows: 1,
  ax: FOOT_X,
  ay: FOOT_Y,
  paint: (p) => {
    for (let f = 0; f < 4; f++) {
      p.frame(f, 0, FRAME_W, FRAME_H, f === 3);
      const band = '#1b1b22';
      for (let i = 12; i <= 19; i++) p.px(i, 6, band);
      p.px(10, 7, band);
      p.px(11, 7, band);
      p.px(20, 7, band);
      p.px(21, 7, band);
      for (let r = 8; r <= 13; r++) {
        p.px(9, r, band);
        p.px(22, r, band);
      }
      p.rect(7, 14, 3, 5, band);
      p.rect(22, 14, 3, 5, band);
      p.px(8, 15, C.neon);
      p.px(23, 15, C.neon);
      if (f !== 1) {
        p.line(9, 18, 13, 21, band);
        p.px(14, 21, C.neon);
      }
    }
  },
};

/** Barista do balcão: de frente, com avental e boné da marca. Quadros 1-2 limpando, 3-4 servindo. */
const barista: SpriteDef = {
  id: 'npc-barista',
  file: 'agents/npc-barista.png',
  w: FRAME_W,
  h: FRAME_H,
  frames: 4,
  rows: 1,
  ax: FOOT_X,
  ay: FOOT_Y,
  paint: (p) => {
    const poses: Pose[] = [
      { view: 'front', legs: 'stand', armL: 'down', armR: 'cupLow', cup: C.cream, look: 0 },
      { view: 'front', legs: 'stand', armL: 'down', armR: 'hold', look: 1 },
      { view: 'front', legs: 'stand', armL: 'down', armR: 'gesture', mouth: 'open' },
      { view: 'front', legs: 'stand', armL: 'cupLow', armR: 'down', cup: C.cream, eyes: 'happy' },
    ];
    poses.forEach((pose, f) => {
      p.frame(f, 0, FRAME_W, FRAME_H);
      body(p, { ...pose, armL: pose.armL, armR: pose.armR === 'hold' ? 'swingF' : pose.armR });
      // Avental.
      p.rect(11, 27, 10, 8, '#e7e5e4');
      p.rect(11, 27, 10, 1, '#a8a29e');
      p.px(16, 30, '#a8a29e');
      // Boné.
      p.rect(10, 7, 12, 4, C.blue);
      p.rect(9, 10, 14, 1, C.blueDark);
      p.rect(20, 10, 4, 1, C.blueDark);
      p.px(15, 8, C.neon);
      if (f === 1) p.rect(18, 33, 4, 2, C.cream);
    });
    const swaps = new Map<string, string>([
      [KEY.shirt, '#334155'],
      [KEY.shirtDark, '#1e293b'],
      [KEY.skin, '#c68642'],
      [KEY.skinDark, '#8d5524'],
      [KEY.hair, '#1b1b1b'],
      [KEY.hairDark, '#111111'],
    ]);
    swapIn(p, swaps);
  },
};

/** Gato do café. Uma linha virada para a direita; a esquerda é espelhada em código. */
const cat: SpriteDef = {
  id: 'cat',
  file: 'agents/cat.png',
  w: 16,
  h: 16,
  frames: 5,
  rows: 1,
  ax: 8,
  ay: 15,
  paint: (p) => {
    const fur = '#f59e0b';
    const dark = '#b45309';
    const belly = '#fde68a';
    for (let f = 0; f < 5; f++) {
      p.frame(f, 0, 16, 16);
      if (f <= 2) {
        const step = f === 1 ? 1 : 0;
        p.rect(3, 8, 9, 4, fur);
        p.rect(4, 11, 7, 1, belly);
        for (const x of [4, 10]) p.rect(x + step, 12, 1, 2, dark);
        for (const x of [5, 11]) p.rect(x - step, 12, 1, 2, fur);
        p.rect(10, 5, 5, 5, fur);
        p.px(10, 4, fur);
        p.px(14, 4, fur);
        p.px(13, 7, C.out);
        p.px(11, 7, C.out);
        p.px(12, 8, '#fda4af');
        p.line(3, 8, 1, 4 + (f === 2 ? 1 : 0), dark);
        p.px(6, 8, dark);
        p.px(8, 8, dark);
      } else if (f === 3) {
        p.rect(5, 7, 6, 7, fur);
        p.rect(6, 10, 4, 4, belly);
        p.rect(9, 3, 5, 5, fur);
        p.px(9, 2, fur);
        p.px(13, 2, fur);
        p.px(10, 5, C.out);
        p.px(12, 5, C.out);
        p.line(4, 13, 2, 10, dark);
      } else {
        p.ellipse(8, 11, 6, 3, fur);
        p.rect(4, 9, 3, 1, dark);
        p.rect(9, 9, 2, 1, dark);
        p.rect(11, 9, 4, 4, fur);
        p.px(11, 8, fur);
        p.px(14, 8, fur);
        p.px(12, 11, dark);
        p.px(13, 11, dark);
      }
    }
  },
};

function swapIn(p: Pix, swaps: ReadonlyMap<string, string>): void {
  const table = new Map<string, readonly [number, number, number, number]>();
  for (const [from, to] of swaps) table.set(rgba(from).slice(0, 3).join(','), rgba(to));
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    if ((d[i + 3] ?? 0) === 0) continue;
    const to = table.get(`${String(d[i])},${String(d[i + 1])},${String(d[i + 2])}`);
    if (!to) continue;
    d[i] = to[0];
    d[i + 1] = to[1];
    d[i + 2] = to[2];
  }
}

export const agentSprites: readonly SpriteDef[] = [...anims.map(sheet), headset, barista, cat];
