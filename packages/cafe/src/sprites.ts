import { l10n } from '@fakl/i18n';

import { context, findHole, newCanvas, Pix, recolor, type Hole } from './pixel.js';

/*
 * Catálogo de sprites do café. Cada sprite tem um arquivo em
 * `packages/cafe/assets/` (nome e tamanho do documento de assets) e um
 * desenho provisório feito aqui. Quando o PNG existe, ele substitui o
 * provisório sem mudar uma linha da cena; o tamanho tem de bater.
 */

export interface SpriteDef {
  readonly id: string;
  /** Caminho dentro de `assets/`, por exemplo `props/desk.png`. */
  readonly file: string;
  /** Tamanho de um quadro. */
  readonly w: number;
  readonly h: number;
  readonly frames: number;
  readonly rows: number;
  /** Pixel do quadro que cai no ponto de ancoragem da cena. */
  readonly ax: number;
  readonly ay: number;
  /** Desenho provisório, na folha inteira. */
  readonly paint: (p: Pix) => void;
  /** Contorno escuro automático no provisório. */
  readonly outline?: boolean;
}

interface Entry {
  readonly def: SpriteDef;
  image: HTMLCanvasElement;
  /** Veio de um PNG em `assets/`. */
  real: boolean;
}

const entries = new Map<string, Entry>();
const tints = new Map<string, HTMLCanvasElement>();
const holes = new Map<string, (Hole & { tops: number[] }) | null>();
let version = 0;

function placeholder(def: SpriteDef): HTMLCanvasElement {
  const p = new Pix(def.w * def.frames, def.h * def.rows);
  def.paint(p);
  if (def.outline !== false) p.outline();
  return p.toCanvas();
}

export function register(defs: readonly SpriteDef[]): void {
  for (const def of defs) {
    if (entries.has(def.id)) continue;
    entries.set(def.id, { def, image: placeholder(def), real: false });
  }
}

export function spriteDef(id: string): SpriteDef {
  const entry = entries.get(id);
  if (!entry) throw new Error(l10n.t('Unknown sprite: {0}', id));
  return entry.def;
}

export function allSprites(): readonly SpriteDef[] {
  return [...entries.values()].map((e) => e.def);
}

/** Muda sempre que um PNG substitui um provisório; caches da cena usam isto. */
export function spritesVersion(): number {
  return version;
}

export function sheet(id: string): HTMLCanvasElement {
  const entry = entries.get(id);
  if (!entry) throw new Error(l10n.t('Unknown sprite: {0}', id));
  return entry.image;
}

/** Folha com cores-chave trocadas; `key` identifica a combinação no cache. */
export function tinted(
  id: string,
  key: string,
  swaps: ReadonlyMap<string, string>,
): HTMLCanvasElement {
  const cacheKey = `${id}|${key}|${String(version)}`;
  let image = tints.get(cacheKey);
  if (!image) {
    image = recolor(sheet(id), swaps);
    tints.set(cacheKey, image);
  }
  return image;
}

/**
 * Desenha o quadro com a âncora em (x, y). `image` permite passar uma folha
 * com a paleta trocada; `flip` espelha na horizontal em torno da âncora.
 */
export function draw(
  ctx: CanvasRenderingContext2D,
  id: string,
  x: number,
  y: number,
  frame = 0,
  row = 0,
  options: { image?: HTMLCanvasElement; flip?: boolean; alpha?: number } = {},
): void {
  const def = spriteDef(id);
  const image = options.image ?? sheet(id);
  const f = ((frame % def.frames) + def.frames) % def.frames;
  const sx = f * def.w;
  const sy = Math.min(row, def.rows - 1) * def.h;
  const alpha = options.alpha ?? 1;
  if (alpha <= 0) return;
  if (alpha < 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
  }
  if (options.flip) {
    ctx.save();
    ctx.translate(Math.round(x), 0);
    ctx.scale(-1, 1);
    ctx.drawImage(image, sx, sy, def.w, def.h, -def.ax, Math.round(y) - def.ay, def.w, def.h);
    ctx.restore();
  } else {
    ctx.drawImage(
      image,
      sx,
      sy,
      def.w,
      def.h,
      Math.round(x) - def.ax,
      Math.round(y) - def.ay,
      def.w,
      def.h,
    );
  }
  if (alpha < 1) ctx.restore();
}

/**
 * Área vazada de um quadro (tela do monitor, vidro da janela), com o topo
 * de cada coluna, para desenhar conteúdo inclinado no plano da parede.
 */
export function hole(id: string, frame = 0): (Hole & { tops: number[] }) | undefined {
  const key = `${id}|${String(frame)}|${String(version)}`;
  const cached = holes.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const def = spriteDef(id);
  const found = findHole(sheet(id), frame * def.w, 0, def.w, def.h);
  if (!found) {
    holes.set(key, null);
    return undefined;
  }
  const data = context(found.mask).getImageData(0, 0, def.w, def.h).data;
  const tops: number[] = [];
  for (let x = found.x; x < found.x + found.w; x++) {
    let top = found.y;
    for (let y = found.y; y < found.y + found.h; y++) {
      if ((data[(y * def.w + x) * 4 + 3] ?? 0) > 0) {
        top = y;
        break;
      }
    }
    tops.push(top);
  }
  const result = { ...found, tops };
  holes.set(key, result);
  return result;
}

/**
 * Pinta `content` dentro do buraco de um sprite já posicionado em
 * (left, top), coluna a coluna a partir do topo de cada coluna do buraco:
 * assim um retângulo vira o paralelogramo da parede ou da tela.
 */
export function drawInHole(
  ctx: CanvasRenderingContext2D,
  id: string,
  frame: number,
  left: number,
  top: number,
  content: (g: CanvasRenderingContext2D, w: number, h: number) => void,
): void {
  const found = hole(id, frame);
  if (!found) return;
  const columns = found.tops.map((t, i) => columnHeight(found, i, t));
  const contentH = Math.max(1, ...columns);
  const def = spriteDef(id);
  const { flat, sheared } = buffers(`${id}|${String(frame)}`, found.w, contentH, def.w, def.h);
  const fctx = context(flat);
  fctx.clearRect(0, 0, flat.width, flat.height);
  content(fctx, found.w, contentH);
  const sctx = context(sheared);
  sctx.globalCompositeOperation = 'source-over';
  sctx.clearRect(0, 0, sheared.width, sheared.height);
  found.tops.forEach((t, i) => {
    const h = columns[i] ?? 0;
    if (h > 0) sctx.drawImage(flat, i, 0, 1, h, found.x + i, t, 1, h);
  });
  sctx.globalCompositeOperation = 'destination-in';
  sctx.drawImage(found.mask, 0, 0);
  ctx.drawImage(sheared, Math.round(left), Math.round(top));
}

const pool = new Map<string, { flat: HTMLCanvasElement; sheared: HTMLCanvasElement }>();

/** Telas de rascunho reaproveitadas a cada quadro, uma por sprite. */
function buffers(
  key: string,
  fw: number,
  fh: number,
  sw: number,
  sh: number,
): { flat: HTMLCanvasElement; sheared: HTMLCanvasElement } {
  let entry = pool.get(key);
  if (entry?.flat.width !== fw || entry.flat.height !== fh || entry.sheared.width !== sw) {
    entry = { flat: newCanvas(fw, fh), sheared: newCanvas(sw, sh) };
    pool.set(key, entry);
  }
  return entry;
}

const heights = new WeakMap<Hole, number[]>();

function columnHeight(found: Hole & { tops: number[] }, i: number, top: number): number {
  let list = heights.get(found);
  if (!list) {
    const data = context(found.mask).getImageData(0, 0, found.mask.width, found.mask.height).data;
    list = found.tops.map((t, c) => {
      let h = 0;
      const x = found.x + c;
      for (let y = t; y < found.mask.height; y++) {
        if ((data[(y * found.mask.width + x) * 4 + 3] ?? 0) === 0) break;
        h++;
      }
      return h;
    });
    heights.set(found, list);
  }
  return list[i] ?? found.h - (top - found.y);
}

/**
 * Troca provisórios pelos PNGs que existem em `base`. `files` lista o que há
 * (gerado no build); sem a lista, tenta todos e ignora os que faltam.
 * Arquivo com tamanho diferente do documento fica de fora, com aviso.
 */
export async function loadAssets(base: string, files?: readonly string[]): Promise<number> {
  const root = base.endsWith('/') ? base : `${base}/`;
  const wanted = [...entries.values()].filter((e) => !files || files.includes(e.def.file));
  let loaded = 0;
  await Promise.all(
    wanted.map(async (entry) => {
      try {
        const response = await fetch(root + entry.def.file);
        if (!response.ok) return;
        const bitmap = await createImageBitmap(await response.blob());
        const { def } = entry;
        if (bitmap.width !== def.w * def.frames || bitmap.height !== def.h * def.rows) {
          console.warn(
            l10n.t(
              'cafe: {0} is {1}x{2}, expected {3}x{4}; the placeholder stays.',
              def.file,
              String(bitmap.width),
              String(bitmap.height),
              String(def.w * def.frames),
              String(def.h * def.rows),
            ),
          );
          return;
        }
        const canvas = newCanvas(bitmap.width, bitmap.height);
        context(canvas).drawImage(bitmap, 0, 0);
        entry.image = canvas;
        entry.real = true;
        loaded++;
      } catch {
        // Sem o arquivo, fica o provisório.
      }
    }),
  );
  if (loaded > 0) {
    version++;
    tints.clear();
    holes.clear();
  }
  return loaded;
}
