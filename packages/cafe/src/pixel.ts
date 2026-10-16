import { l10n } from '@fakl/i18n';

/*
 * Ferramentas de pixel art do café: uma "prancheta" de pixels sem
 * anti-aliasing, contorno automático, troca de paleta, máscara das áreas
 * vazadas (vidro da janela, tela do monitor) e uma fonte de 3x5.
 */

export type Rgba = readonly [number, number, number, number];

export function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  return canvas;
}

export function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error(l10n.t('Canvas 2D unavailable.'));
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

export function rgba(hex: string, alpha = 255): Rgba {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

export function hex([r, g, b]: Rgba): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Clareia (`amount` > 0) ou escurece (`amount` < 0) uma cor, em fração. */
export function shade(color: string, amount: number): string {
  const [r, g, b] = rgba(color);
  const f = (c: number) =>
    Math.round(Math.max(0, Math.min(255, amount >= 0 ? c + (255 - c) * amount : c * (1 + amount))));
  return hex([f(r), f(g), f(b), 255]);
}

export function mix(a: string, b: string, t: number): string {
  const ca = rgba(a);
  const cb = rgba(b);
  const f = (i: 0 | 1 | 2) => Math.round(ca[i] + (cb[i] - ca[i]) * t);
  return hex([f(0), f(1), f(2), 255]);
}

type Pt = readonly [number, number];

/**
 * Prancheta de pixels. Tudo é escrito pixel a pixel num ImageData, então não
 * há meio-tom nas bordas: o resultado já sai na grade, como pixel art.
 */
export class Pix {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  /** Deslocamento do quadro atual dentro da folha. */
  ox = 0;
  oy = 0;
  /** Espelha o quadro atual na horizontal (largura `frameW`). */
  flip = false;
  frameW = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  /** Posiciona o quadro `index` da linha `row` numa folha de quadros `w`x`h`. */
  frame(index: number, row: number, w: number, h: number, flip = false): this {
    this.ox = index * w;
    this.oy = row * h;
    this.frameW = w;
    this.flip = flip;
    return this;
  }

  private at(x: number, y: number): number {
    const fx = this.flip ? this.frameW - 1 - x : x;
    const px = Math.floor(fx) + this.ox;
    const py = Math.floor(y) + this.oy;
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return -1;
    return (py * this.width + px) * 4;
  }

  px(x: number, y: number, color: string | Rgba): void {
    const i = this.at(x, y);
    if (i < 0) return;
    const [r, g, b, a] = typeof color === 'string' ? rgba(color) : color;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  get(x: number, y: number): Rgba {
    const i = this.at(x, y);
    if (i < 0) return [0, 0, 0, 0];
    return [this.data[i] ?? 0, this.data[i + 1] ?? 0, this.data[i + 2] ?? 0, this.data[i + 3] ?? 0];
  }

  rect(x: number, y: number, w: number, h: number, color: string | Rgba): void {
    const c = typeof color === 'string' ? rgba(color) : color;
    for (let j = Math.round(y); j < Math.round(y + h); j++)
      for (let i = Math.round(x); i < Math.round(x + w); i++) this.px(i, j, c);
  }

  /** Linha de Bresenham. */
  line(x0: number, y0: number, x1: number, y1: number, color: string | Rgba): void {
    const c = typeof color === 'string' ? rgba(color) : color;
    let x = Math.round(x0);
    let y = Math.round(y0);
    const xe = Math.round(x1);
    const ye = Math.round(y1);
    const dx = Math.abs(xe - x);
    const dy = -Math.abs(ye - y);
    const sx = x < xe ? 1 : -1;
    const sy = y < ye ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x, y, c);
      if (x === xe && y === ye) return;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Polígono preenchido pelo centro de cada pixel: borda em escada, sem meio-tom. */
  poly(points: readonly Pt[], color: string | Rgba): void {
    const c = typeof color === 'string' ? rgba(color) : color;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const minX = Math.floor(Math.min(...xs));
    const maxX = Math.ceil(Math.max(...xs));
    const minY = Math.floor(Math.min(...ys));
    const maxY = Math.ceil(Math.max(...ys));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (inside(points, x + 0.5, y + 0.5)) this.px(x, y, c);
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: string | Rgba): void {
    const c = typeof color === 'string' ? rgba(color) : color;
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.px(x, y, c);
      }
    }
  }

  /**
   * Caixa isométrica 2:1. `o` é o canto de trás no chão (x, y mínimos), em
   * pixels; `w` e `d` em ladrilhos nos eixos x e y; `h` e `z` em pixels.
   */
  box(
    o: Pt,
    w: number,
    d: number,
    h: number,
    colors: readonly [string, string, string],
    z = 0,
  ): void {
    const p = (x: number, y: number, zz: number): Pt => [
      o[0] + (x - y) * 16,
      o[1] + (x + y) * 8 - zz,
    ];
    const [top, left, right] = colors;
    this.poly([p(0, d, z), p(w, d, z), p(w, d, z + h), p(0, d, z + h)], left);
    this.poly([p(w, 0, z), p(w, d, z), p(w, d, z + h), p(w, 0, z + h)], right);
    this.poly([p(0, 0, z + h), p(w, 0, z + h), p(w, d, z + h), p(0, d, z + h)], top);
  }

  /** Ponto isométrico relativo a `o` (canto de trás no chão). */
  static iso(o: Pt, x: number, y: number, z = 0): Pt {
    return [o[0] + (x - y) * 16, o[1] + (x + y) * 8 - z];
  }

  /** Contorno de 1 px em volta de tudo o que é opaco, na folha inteira. */
  outline(color = '#0d1117'): void {
    const c = rgba(color);
    const { width, height, data } = this;
    const solid = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < width && y < height && (data[(y * width + x) * 4 + 3] ?? 0) > 0;
    const marks: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (solid(x, y)) continue;
        if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))
          marks.push((y * width + x) * 4);
      }
    }
    for (const i of marks) {
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
    }
  }

  toCanvas(): HTMLCanvasElement {
    const canvas = newCanvas(this.width, this.height);
    const image = new ImageData(this.width, this.height);
    image.data.set(this.data);
    context(canvas).putImageData(image, 0, 0);
    return canvas;
  }
}

function inside(points: readonly Pt[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i] ?? [0, 0];
    const [xj, yj] = points[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Troca cores-chave por outras (palette swap), pixel a pixel e só nas cores
 * exatas. É assim que um único personagem vira cada agente.
 */
export function recolor(
  source: HTMLCanvasElement,
  swaps: ReadonlyMap<string, string>,
): HTMLCanvasElement {
  const out = newCanvas(source.width, source.height);
  const ctx = context(out);
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const table = new Map<number, Rgba>();
  for (const [from, to] of swaps) {
    const [r, g, b] = rgba(from);
    table.set((r << 16) | (g << 8) | b, rgba(to));
  }
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    if ((d[i + 3] ?? 0) === 0) continue;
    const to = table.get(((d[i] ?? 0) << 16) | ((d[i + 1] ?? 0) << 8) | (d[i + 2] ?? 0));
    if (!to) continue;
    d[i] = to[0];
    d[i + 1] = to[1];
    d[i + 2] = to[2];
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

/** Área vazada de um sprite: pixels transparentes cercados por pixels opacos. */
export interface Hole {
  /** Branco onde é vazado; serve de máscara com `destination-in`. */
  readonly mask: HTMLCanvasElement;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Acha o "buraco" de um quadro (o vidro da janela, a tela do monitor):
 * enche a partir das bordas pelos pixels transparentes; o que sobrar
 * transparente está cercado e é o buraco.
 */
export function findHole(
  source: CanvasImageSource & { width: number; height: number },
  sx = 0,
  sy = 0,
  w = source.width,
  h = source.height,
): Hole | undefined {
  const tmp = newCanvas(w, h);
  const tctx = context(tmp);
  tctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
  const d = tctx.getImageData(0, 0, w, h).data;
  const clear = (x: number, y: number) => (d[(y * w + x) * 4 + 3] ?? 0) < 128;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) stack.push(x, 0, x, h - 1);
  for (let y = 0; y < h; y++) stack.push(0, y, w - 1, y);
  while (stack.length > 0) {
    const y = stack.pop() ?? 0;
    const x = stack.pop() ?? 0;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (outside[i] || !clear(x, y)) continue;
    outside[i] = 1;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  const mask = newCanvas(w, h);
  const mctx = context(mask);
  const image = mctx.createImageData(w, h);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (outside[i] || !clear(x, y)) continue;
      image.data.set([255, 255, 255, 255], i * 4);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return undefined;
  mctx.putImageData(image, 0, 0);
  return { mask, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// --- Fonte 3x5 -------------------------------------------------------------

const GLYPHS: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001010010010',
  '8': '111101111101111',
  '9': '111101111001111',
  '.': '000000000000010',
  ',': '000000000010100',
  ':': '000010000010000',
  '-': '000000111000000',
  '+': '000010111010000',
  '%': '101001010100101',
  ' ': '000000000000000',
  H: '101101111101101',
  I: '111010010010111',
  k: '100101110101101',
  K: '101101110101101',
};

/** Largura em pixels de um texto na fonte 3x5. */
export function textWidth(text: string): number {
  return Math.max(0, text.length * 4 - 1);
}

/**
 * Escreve na fonte 3x5. `put` recebe cada pixel aceso, para quem chama
 * aplicar a inclinação do plano da parede.
 */
export function text(value: string, put: (x: number, y: number) => void): void {
  let cx = 0;
  for (const ch of value) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' '] ?? '';
    for (let i = 0; i < 15; i++) {
      if (glyph[i] === '1') put(cx + (i % 3), Math.floor(i / 3));
    }
    cx += 4;
  }
}
