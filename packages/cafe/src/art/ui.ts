import type { Pix } from '../pixel.js';
import type { SpriteDef } from '../sprites.js';
import { C } from './palette.js';

/*
 * Telas dos monitores (grupo I) e emotes sobre a cabeça (grupo J), em
 * desenho provisório.
 */

function frames(
  id: string,
  file: string,
  w: number,
  h: number,
  count: number,
  paint: (p: Pix, f: number) => void,
  options: { ax?: number; ay?: number; outline?: boolean } = {},
): SpriteDef {
  return {
    id,
    file,
    w,
    h,
    frames: count,
    rows: 1,
    ax: options.ax ?? 0,
    ay: options.ay ?? 0,
    outline: options.outline ?? false,
    paint: (p) => {
      for (let f = 0; f < count; f++) {
        p.frame(f, 0, w, h);
        paint(p, f);
      }
    },
  };
}

// --- Telas 21x15 -----------------------------------------------------------

const screenOff = frames('screen-off', 'screens/screen-off.png', 21, 15, 1, (p) => {
  p.rect(0, 0, 21, 15, '#050608');
  p.line(2, 4, 5, 1, '#1f2937');
  p.line(3, 5, 7, 1, '#141b26');
});

const screenBoot = frames('screen-boot', 'screens/screen-boot.png', 21, 15, 4, (p, f) => {
  p.rect(0, 0, 21, 15, '#0f1726');
  p.px(7, 4, C.neon);
  p.px(8, 5, C.neon);
  p.px(7, 6, C.neon);
  p.rect(10, 6, 4, 1, f % 2 ? C.neonDim : C.neon);
  p.rect(4, 10, 13, 1, '#1f2937');
  p.rect(4, 10, Math.round((13 * f) / 3), 1, C.blue);
});

const screenSaver = frames('screen-saver', 'screens/screen-saver.png', 21, 15, 4, (p, f) => {
  p.rect(0, 0, 21, 15, '#0d1117');
  for (const [x, y] of [
    [3, 2],
    [16, 3],
    [10, 12],
    [18, 11],
  ] as const)
    p.px(x, y, '#334155');
  const path = [
    [3, 3],
    [8, 7],
    [13, 10],
    [16, 5],
  ] as const;
  const [x, y] = path[f] ?? [3, 3];
  const [px, py] = path[(f + 3) % 4] ?? [3, 3];
  p.px(px + 1, py + 1, C.blueDark);
  p.px(Math.round((x + px) / 2) + 1, Math.round((y + py) / 2) + 1, C.blue);
  p.rect(x, y, 3, 3, C.neon);
});

const screenError = frames('screen-error', 'screens/screen-error.png', 21, 15, 2, (p, f) => {
  p.rect(0, 0, 21, 15, '#2a0f14');
  const color = f === 0 ? C.red : '#7a2a33';
  p.poly(
    [
      [10.5, 1.5],
      [14.5, 9.5],
      [6.5, 9.5],
    ],
    color,
  );
  p.rect(10, 4, 1, 3, '#0d1117');
  p.px(10, 8, '#0d1117');
  p.rect(5, 11, 11, 1, '#52525b');
  p.rect(7, 13, 7, 1, '#3f3f46');
});

// --- Emotes 16x16 ----------------------------------------------------------

function bubble(p: Pix): void {
  p.rect(2, 1, 12, 11, '#f8fafc');
  p.rect(1, 2, 14, 9, '#f8fafc');
  p.rect(3, 12, 3, 1, '#f8fafc');
  p.rect(3, 13, 2, 1, '#f8fafc');
  p.px(3, 14, '#f8fafc');
  p.rect(2, 10, 12, 1, '#e2e8f0');
}

function emote(
  id: string,
  file: string,
  count: number,
  paint: (p: Pix, f: number) => void,
  withBubble = true,
): SpriteDef {
  return frames(
    id,
    `emotes/${file}`,
    16,
    16,
    count,
    (p, f) => {
      if (withBubble) bubble(p);
      paint(p, f);
    },
    { ax: 3, ay: 15, outline: true },
  );
}

const emotes = [
  emote('emote-thinking', 'emote-thinking.png', 3, (p, f) => {
    for (let i = 0; i <= f; i++) p.rect(3 + i * 4, 5, 2, 2, '#334155');
  }),
  emote(
    'emote-alert',
    'emote-alert.png',
    2,
    (p, f) => {
      const color = f === 0 ? C.yellow : '#ffe39a';
      p.poly(
        [
          [8, 0.5],
          [15.5, 8],
          [8, 15.5],
          [0.5, 8],
        ],
        color,
      );
      p.rect(7, 3, 2, 6, '#1b1b22');
      p.rect(7, 10, 2, 2, '#1b1b22');
    },
    false,
  ),
  emote('emote-ok', 'emote-ok.png', 1, (p) => {
    p.line(4, 6, 6, 8, C.green);
    p.line(4, 5, 6, 7, C.green);
    p.line(6, 8, 11, 3, C.green);
    p.line(6, 7, 11, 2, C.green);
  }),
  emote('emote-error', 'emote-error.png', 1, (p) => {
    p.line(5, 3, 10, 8, C.red);
    p.line(6, 3, 11, 8, C.red);
    p.line(10, 3, 5, 8, C.red);
    p.line(11, 3, 6, 8, C.red);
  }),
  emote('emote-coffee', 'emote-coffee.png', 1, (p) => {
    p.rect(5, 5, 5, 4, '#78350f');
    p.rect(5, 5, 5, 1, '#a16207');
    p.px(10, 6, '#78350f');
    p.px(11, 6, '#78350f');
    p.px(11, 7, '#78350f');
    p.px(6, 3, '#94a3b8');
    p.px(8, 2, '#94a3b8');
  }),
  emote('emote-water', 'emote-water.png', 1, (p) => {
    p.ellipse(8, 7, 3, 3, '#38bdf8');
    p.rect(7, 2, 2, 2, '#38bdf8');
    p.px(8, 1, '#38bdf8');
    p.px(7, 6, '#e0f2fe');
  }),
  emote('emote-idea', 'emote-idea.png', 1, (p) => {
    p.ellipse(8, 5, 3, 3, C.yellow);
    p.rect(7, 8, 3, 2, '#94a3b8');
    p.px(7, 4, '#ffffff');
  }),
  emote(
    'emote-zzz',
    'emote-zzz.png',
    3,
    (p, f) => {
      const z = (x: number, y: number, s: number) => {
        p.rect(x, y, s, 1, '#e0e7ff');
        p.line(x + s - 1, y + 1, x, y + s - 2, '#e0e7ff');
        p.rect(x, y + s - 1, s, 1, '#e0e7ff');
      };
      z(2, 10 - f, 4);
      if (f >= 1) z(7, 6 - f, 4);
      if (f >= 2) z(11, 1, 3);
    },
    false,
  ),
  emote(
    'emote-confetti',
    'emote-confetti.png',
    3,
    (p, f) => {
      const colors = [C.pink, C.yellow, C.neon, C.green, C.purpleLight, C.orange];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const r = 2 + f * 2.5;
        const x = 8 + Math.cos(a) * r;
        const y = 9 + Math.sin(a) * r * 0.8 + f;
        p.rect(
          Math.round(x),
          Math.round(y),
          i % 3 === 0 ? 2 : 1,
          1,
          colors[i % colors.length] ?? C.pink,
        );
      }
    },
    false,
  ),
  emote('emote-chat', 'emote-chat.png', 2, (p, f) => {
    p.rect(4, 4, f ? 5 : 8, 1, '#64748b');
    p.rect(4, 7, f ? 7 : 4, 1, '#94a3b8');
  }),
  emote(
    'emote-music',
    'emote-music.png',
    2,
    (p, f) => {
      const color = f ? C.pink : C.neon;
      p.rect(4, 4 - f, 1, 7, color);
      p.rect(9, 3 - f, 1, 7, color);
      p.rect(4, 3 - f, 6, 2, color);
      p.rect(2, 10 - f, 3, 2, color);
      p.rect(7, 9 - f, 3, 2, color);
    },
    false,
  ),
];

export const uiSprites: readonly SpriteDef[] = [
  screenOff,
  screenBoot,
  screenSaver,
  screenError,
  ...emotes,
];
