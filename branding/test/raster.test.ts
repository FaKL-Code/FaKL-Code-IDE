import { describe, expect, it } from 'vitest';

import { composite, createImage, encodeBmp24, mix } from '../scripts/raster.ts';

describe('raster', () => {
  it('codifica BMP de 24 bits com cabeçalho e preenchimento de linha corretos', () => {
    const image = createImage(3, 2, (x, y) => [x * 10, y * 10, 200]);
    const bmp = encodeBmp24(image);
    const view = new DataView(bmp.buffer);

    expect(String.fromCharCode(bmp[0] ?? 0, bmp[1] ?? 0)).toBe('BM');
    // 3 pixels * 3 bytes = 9, arredondado para 12 por linha.
    expect(bmp.length).toBe(54 + 12 * 2);
    expect(view.getUint32(2, true)).toBe(bmp.length);
    expect(view.getInt32(18, true)).toBe(3);
    expect(view.getInt32(22, true)).toBe(2);
    expect(view.getUint16(28, true)).toBe(24);

    // Primeira linha gravada é a de baixo (y = 1), em BGR.
    expect([bmp[54], bmp[55], bmp[56]]).toEqual([200, 10, 0]);
    // Primeiro pixel da linha de cima (y = 0) começa após 12 bytes.
    expect([bmp[66], bmp[67], bmp[68]]).toEqual([200, 0, 0]);
  });

  it('compõe respeitando o alfa e recortando fora da base', () => {
    const base = createImage(2, 1, () => [0, 0, 0]);
    const top = {
      width: 2,
      height: 1,
      data: Uint8Array.from([255, 255, 255, 255, 255, 0, 0, 0]),
    };
    const out = composite(base, top, 1, 0);
    expect(Array.from(out.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(Array.from(base.data)).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });

  it('aplica meio alfa como média', () => {
    const base = createImage(1, 1, () => [0, 0, 0]);
    const top = { width: 1, height: 1, data: Uint8Array.from([200, 100, 50, 128]) };
    expect(Array.from(composite(base, top, 0, 0).data.slice(0, 3))).toEqual([100, 50, 25]);
  });

  it('interpola cores e limita t ao intervalo', () => {
    expect(mix([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
    expect(mix([0, 0, 0], [100, 200, 50], 2)).toEqual([100, 200, 50]);
    expect(mix([10, 10, 10], [100, 200, 50], -1)).toEqual([10, 10, 10]);
  });
});
