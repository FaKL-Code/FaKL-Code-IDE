/**
 * Operações mínimas sobre imagens RGBA em memória, o suficiente para compor
 * os bitmaps do instalador do Windows sem depender de ImageMagick.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Pixels RGBA, 4 bytes por pixel, linha a linha de cima para baixo. */
  readonly data: Uint8Array;
}

export type Rgb = readonly [number, number, number];

export function createImage(
  width: number,
  height: number,
  fill: (x: number, y: number) => Rgb,
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Desenha `top` sobre `base` na posição (left, topY) usando o alfa de `top`. */
export function composite(base: RgbaImage, top: RgbaImage, left: number, topY: number): RgbaImage {
  const data = Uint8Array.from(base.data);
  for (let y = 0; y < top.height; y++) {
    const by = y + topY;
    if (by < 0 || by >= base.height) continue;
    for (let x = 0; x < top.width; x++) {
      const bx = x + left;
      if (bx < 0 || bx >= base.width) continue;
      const t = (y * top.width + x) * 4;
      const b = (by * base.width + bx) * 4;
      const alpha = (top.data[t + 3] ?? 0) / 255;
      for (let c = 0; c < 3; c++) {
        const over = top.data[t + c] ?? 0;
        const under = data[b + c] ?? 0;
        data[b + c] = Math.round(over * alpha + under * (1 - alpha));
      }
      data[b + 3] = 255;
    }
  }
  return { width: base.width, height: base.height, data };
}

/** Interpola linearmente entre duas cores; `t` vai de 0 a 1. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

/**
 * Codifica um BMP de 24 bits sem compressão, o formato que o Inno Setup aceita
 * nas imagens do assistente. O alfa é ignorado; componha sobre um fundo antes.
 */
export function encodeBmp24(image: RgbaImage): Uint8Array {
  const rowSize = Math.ceil((image.width * 3) / 4) * 4;
  const pixelBytes = rowSize * image.height;
  const fileSize = 54 + pixelBytes;
  const out = new Uint8Array(fileSize);
  const view = new DataView(out.buffer);

  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, image.width, true);
  view.setInt32(22, image.height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);

  for (let y = 0; y < image.height; y++) {
    // BMP guarda as linhas de baixo para cima, com canais em BGR.
    const row = 54 + (image.height - 1 - y) * rowSize;
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      out[row + x * 3] = image.data[i + 2] ?? 0;
      out[row + x * 3 + 1] = image.data[i + 1] ?? 0;
      out[row + x * 3 + 2] = image.data[i] ?? 0;
    }
  }
  return out;
}
