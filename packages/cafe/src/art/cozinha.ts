import type { Pix, Rgba } from '../pixel.js';
import type { SpriteDef } from '../sprites.js';
import { C, KEY } from './palette.js';

/*
 * Cozinha do CI (ADR 0051), em desenho provisório no mesmo estilo do resto do
 * café: vista de frente, contorno escuro automático, cores da paleta da marca.
 * Cada sprite tem arquivo, tamanho e âncora fixos, como os demais; um PNG com
 * o mesmo nome e tamanho em `assets/` substitui o provisório.
 */

export const COOK_W = 32;
export const COOK_H = 48;
export const COOK_FOOT_X = 16;
export const COOK_FOOT_Y = 46;

interface Spec {
  readonly id: string;
  readonly file: string;
  readonly w: number;
  readonly h: number;
  readonly frames: number;
  readonly ax?: number;
  readonly ay?: number;
  readonly outline?: boolean;
  readonly paint: (p: Pix, frame: number) => void;
}

function sprite(spec: Spec): SpriteDef {
  return {
    id: spec.id,
    file: spec.file,
    w: spec.w,
    h: spec.h,
    frames: spec.frames,
    rows: 1,
    ax: spec.ax ?? 0,
    ay: spec.ay ?? 0,
    outline: spec.outline ?? true,
    paint: (p) => {
      for (let f = 0; f < spec.frames; f++) {
        p.frame(f, 0, spec.w, spec.h);
        spec.paint(p, f);
      }
    },
  };
}

/** Pixel transparente: vaza a alça da xícara e o picote da senha. */
const CLEAR: Rgba = [0, 0, 0, 0];
const WHITE = '#f1f5f9';
const WHITE_SHADE = '#cbd5e1';

/** Pose do cozinheiro: onde ficam os braços e a boca. */
type Arms = 'down' | 'whisk' | 'stir' | 'up' | 'head';

function cook(p: Pix, arms: Arms, options: { mouth: 'flat' | 'smile' | 'open' }) {
  // Pernas e sapatos.
  p.rect(11, 38, 4, 8, KEY.pants);
  p.rect(17, 38, 4, 8, KEY.pants);
  p.rect(10, 45, 5, 2, KEY.shoe);
  p.rect(17, 45, 5, 2, KEY.shoe);
  // Jaleco branco com lenço azul no pescoço.
  p.rect(10, 23, 12, 16, WHITE);
  p.rect(10, 36, 12, 3, WHITE_SHADE);
  p.rect(15, 25, 2, 12, WHITE_SHADE);
  p.rect(13, 23, 6, 2, C.blue);
  p.px(16, 25, C.blueDark);
  // Cabeça.
  p.rect(12, 12, 8, 10, KEY.skin);
  p.rect(12, 20, 8, 2, KEY.skinDark);
  p.rect(14, 16, 1, 2, KEY.eye);
  p.rect(18, 16, 1, 2, KEY.eye);
  if (options.mouth === 'smile') {
    p.rect(14, 19, 4, 1, '#7a2a33');
    p.px(13, 18, '#7a2a33');
    p.px(18, 18, '#7a2a33');
  } else if (options.mouth === 'open') {
    p.rect(15, 18, 3, 3, '#3b0d12');
  } else {
    p.rect(15, 19, 3, 1, '#7a2a33');
  }
  // Touca de cozinheiro.
  p.rect(11, 9, 10, 3, WHITE);
  p.rect(10, 4, 12, 6, WHITE);
  p.rect(12, 2, 8, 3, WHITE);
  p.rect(11, 9, 10, 1, WHITE_SHADE);
  // Braços.
  const arm = (x: number, y: number, h: number) => {
    p.rect(x, y, 3, h, WHITE);
    p.rect(x, y + h, 3, 2, KEY.skin);
  };
  switch (arms) {
    case 'down':
      arm(7, 24, 9);
      arm(22, 24, 9);
      break;
    case 'whisk':
      arm(7, 24, 9);
      // Braço direito dobrado à frente, com a colher no alto.
      p.rect(22, 24, 3, 6, WHITE);
      p.rect(24, 22, 3, 2, KEY.skin);
      p.rect(26, 16, 1, 7, C.woodLight);
      p.rect(25, 14, 3, 3, C.metal);
      break;
    case 'stir':
      arm(7, 24, 9);
      p.rect(22, 24, 3, 6, WHITE);
      p.rect(24, 28, 3, 2, KEY.skin);
      p.rect(26, 24, 1, 8, C.woodLight);
      p.rect(25, 31, 3, 2, C.metal);
      break;
    case 'up':
      // Os dois braços para o alto: comemorando.
      p.rect(7, 12, 3, 12, WHITE);
      p.rect(7, 9, 3, 3, KEY.skin);
      p.rect(22, 12, 3, 12, WHITE);
      p.rect(22, 9, 3, 3, KEY.skin);
      break;
    case 'head':
      // Mãos na cabeça: susto.
      p.rect(7, 15, 3, 9, WHITE);
      p.rect(8, 11, 3, 4, KEY.skin);
      p.rect(22, 15, 3, 9, WHITE);
      p.rect(21, 11, 3, 4, KEY.skin);
      break;
  }
}

const cookSprite = sprite({
  id: 'kitchen-cook',
  file: 'agents/kitchen-cook.png',
  w: COOK_W,
  h: COOK_H,
  frames: 5,
  ax: COOK_FOOT_X,
  ay: COOK_FOOT_Y,
  paint: (p, f) => {
    const poses: [Arms, 'flat' | 'smile' | 'open'][] = [
      ['down', 'flat'],
      ['whisk', 'flat'],
      ['stir', 'flat'],
      ['up', 'smile'],
      ['head', 'open'],
    ];
    const [arms, mouth] = poses[f] ?? poses[0] ?? ['down', 'flat'];
    cook(p, arms, { mouth });
  },
});

/** Xícara de um job: vazia, enchendo, servida, rachada, virada e com senha. */
const cupSprite = sprite({
  id: 'kitchen-cup',
  file: 'props/kitchen-cup.png',
  w: 10,
  h: 12,
  frames: 6,
  ax: 5,
  ay: 11,
  paint: (p, f) => {
    const body = (fill: string | undefined, level: number, rim: string) => {
      p.rect(1, 3, 7, 7, C.cream);
      p.rect(2, 10, 5, 1, C.cream);
      p.rect(8, 4, 2, 4, C.cream);
      p.rect(9, 5, 1, 2, CLEAR);
      p.rect(1, 3, 7, 1, rim);
      if (fill) p.rect(2, 4 + (6 - level), 5, level, fill);
      p.rect(2, 10, 5, 1, WHITE_SHADE);
    };
    switch (f) {
      case 0:
        body(undefined, 0, WHITE_SHADE);
        break;
      case 1:
        body('#6b4423', 3, WHITE_SHADE);
        break;
      case 2:
        body('#6b4423', 5, C.green);
        p.px(4, 5, '#a9744a');
        break;
      case 3:
        body('#6b4423', 4, C.red);
        // Rachadura.
        p.line(4, 3, 3, 6, C.out);
        p.line(3, 6, 5, 9, C.out);
        break;
      case 4:
        // Virada: sem café, cinza.
        p.rect(1, 3, 7, 7, C.muted);
        p.rect(1, 2, 7, 1, C.metalDark);
        p.rect(8, 4, 2, 4, C.muted);
        p.rect(9, 5, 1, 2, CLEAR);
        break;
      default:
        body(undefined, 0, C.yellow);
        // Senha enfiada na xícara.
        p.rect(5, 0, 4, 4, C.yellow);
        p.px(6, 1, C.out);
        p.px(8, 2, C.out);
        break;
    }
  },
});

/** Sino de balcão: quieto e tocando. */
const bellSprite = sprite({
  id: 'kitchen-bell',
  file: 'props/kitchen-bell.png',
  w: 16,
  h: 14,
  frames: 2,
  ax: 8,
  ay: 13,
  paint: (p, f) => {
    p.rect(2, 11, 12, 2, C.metalDark);
    p.rect(4, 6, 8, 5, C.yellow);
    p.rect(5, 4, 6, 2, C.yellow);
    p.rect(7, 2, 2, 2, C.orange);
    p.rect(5, 7, 1, 3, '#fff3c4');
    if (f === 1) {
      p.px(1, 4, C.yellow);
      p.px(0, 6, C.yellow);
      p.px(14, 4, C.yellow);
      p.px(15, 6, C.yellow);
      p.px(2, 2, C.yellow);
      p.px(13, 2, C.yellow);
    }
  },
});

/** Luz de alarme: apagada e acesa. */
const alarmSprite = sprite({
  id: 'kitchen-alarm',
  file: 'props/kitchen-alarm.png',
  w: 14,
  h: 14,
  frames: 2,
  ax: 7,
  ay: 13,
  paint: (p, f) => {
    p.rect(2, 11, 10, 2, C.metalDark);
    p.rect(3, 5, 8, 6, f === 1 ? C.red : '#7a2a33');
    p.rect(4, 3, 6, 2, f === 1 ? C.red : '#7a2a33');
    p.rect(4, 5, 2, 4, f === 1 ? '#ffb4b4' : '#a24550');
    if (f === 1) {
      p.px(0, 7, C.red);
      p.px(13, 7, C.red);
      p.px(1, 3, C.red);
      p.px(12, 3, C.red);
    }
  },
});

/** Fumaça que sobe da bancada que falhou. */
const smokeSprite = sprite({
  id: 'kitchen-smoke',
  file: 'props/kitchen-smoke.png',
  w: 12,
  h: 16,
  frames: 4,
  ax: 6,
  ay: 15,
  outline: false,
  paint: (p, f) => {
    const puffs: [number, number, number][] = [
      [6, 13 - f * 2, 3],
      [5 + (f % 2), 8 - f * 2 + 2, 3],
      [6 - (f % 2), 3 + ((f * 2) % 6), 2],
    ];
    puffs.forEach(([x, y, r], i) => {
      p.ellipse(x, Math.max(2, y), r, r, i === 0 ? '#52525b' : i === 1 ? '#71717a' : '#a1a1aa');
    });
  },
});

/** Vapor leve de quem está cozinhando. */
const steamSprite = sprite({
  id: 'kitchen-steam',
  file: 'props/kitchen-steam.png',
  w: 8,
  h: 12,
  frames: 3,
  ax: 4,
  ay: 11,
  outline: false,
  paint: (p, f) => {
    for (let i = 0; i < 3; i++) {
      const y = 10 - ((f * 3 + i * 4) % 11);
      p.px(2 + (i % 2) * 3, y, '#e2e8f0');
      p.px(3 + (i % 2) * 3, y - 1, '#94a3b8');
    }
  },
});

/** Senha da fila (execução esperando aprovação): pisca. */
const ticketSprite = sprite({
  id: 'kitchen-ticket',
  file: 'props/kitchen-ticket.png',
  w: 12,
  h: 16,
  frames: 2,
  ax: 6,
  ay: 15,
  paint: (p, f) => {
    p.rect(1, 1, 10, 14, f === 0 ? C.yellow : '#ffe39a');
    p.rect(1, 1, 10, 3, C.orange);
    p.rect(3, 6, 6, 1, C.out);
    p.rect(3, 8, 4, 1, C.out);
    p.rect(3, 10, 6, 1, C.out);
    // Picote embaixo.
    for (let x = 1; x < 11; x += 2) p.px(x, 15, CLEAR);
  },
});

/** Avental pendurado no gancho: a bancada vazia (execução cancelada). */
const apronSprite = sprite({
  id: 'kitchen-apron',
  file: 'props/kitchen-apron.png',
  w: 14,
  h: 22,
  frames: 1,
  ax: 7,
  ay: 21,
  paint: (p) => {
    p.rect(6, 0, 2, 3, C.metalDark);
    p.rect(3, 3, 8, 3, WHITE_SHADE);
    p.rect(2, 6, 10, 14, WHITE);
    p.rect(2, 17, 10, 3, WHITE_SHADE);
    p.rect(4, 11, 6, 4, WHITE_SHADE);
    p.rect(4, 11, 6, 1, C.muted);
  },
});

/** Bancada de frente: tampo de madeira e a frente do balcão. */
const counterSprite = sprite({
  id: 'kitchen-counter',
  file: 'props/kitchen-counter.png',
  w: 64,
  h: 22,
  frames: 1,
  ax: 0,
  ay: 0,
  paint: (p) => {
    p.rect(0, 0, 64, 4, C.woodLight);
    p.rect(0, 3, 64, 1, C.wood);
    p.rect(1, 4, 62, 16, C.woodDark);
    p.rect(1, 4, 62, 1, C.woodDeep);
    for (let x = 8; x < 62; x += 14) p.rect(x, 7, 1, 11, C.woodDeep);
    p.rect(1, 19, 62, 3, C.woodDeep);
  },
});

export const kitchenSprites: readonly SpriteDef[] = [
  cookSprite,
  cupSprite,
  bellSprite,
  alarmSprite,
  smokeSprite,
  steamSprite,
  ticketSprite,
  apronSprite,
  counterSprite,
];
