/**
 * Gera os ícones da FaKL-Code para macOS, Windows, Linux e servidor web a
 * partir de `logo/`. A saída em `resources/stable/` espelha `src/stable/` do
 * VSCodium e é copiada por cima dele no build (ver `build/prepare.sh`).
 *
 * Rode com `pnpm --filter @fakl/branding icons` depois de mudar o logo e
 * commite os arquivos gerados: o build não depende de ferramentas gráficas.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';
import png2icons from 'png2icons';

import { composite, createImage, encodeBmp24, mix, type Rgb, type RgbaImage } from './raster.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'resources', 'stable');

/** Logo com a margem da grade de ícones do macOS (824 de 1024). */
const logo = readFileSync(join(root, 'logo', 'fakl-code.svg'), 'utf8');
/** Mesmo logo sem margem, para Windows, Linux e web. */
const logoSquare = logo.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"');
const mark = readFileSync(join(root, 'logo', 'fakl-code-mark.svg'), 'utf8');

// Paleta do brand kit Terminal: fundo #0D1117 e azul primário #2563EB.
const NIGHT: Rgb = [0x0d, 0x11, 0x17];
const BLUE: Rgb = [0x25, 0x63, 0xeb];

function write(relative: string, data: Uint8Array | string): void {
  const file = join(out, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`  ${relative}`);
}

function renderPng(svg: string, width: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
}

function renderRgba(svg: string, width: number): RgbaImage {
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
  return { width: rendered.width, height: rendered.height, data: new Uint8Array(rendered.pixels) };
}

function icns(svg: string): Buffer {
  const result = png2icons.createICNS(renderPng(svg, 1024), png2icons.BICUBIC2, 0);
  if (!result) throw new Error('falha ao gerar .icns');
  return result;
}

function ico(svg: string): Buffer {
  const result = png2icons.createICO(renderPng(svg, 256), png2icons.BICUBIC2, 0, false, true);
  if (!result) throw new Error('falha ao gerar .ico');
  return result;
}

function letterpress(fill: string, opacity?: number): string {
  const attrs =
    opacity === undefined ? '' : ` fill-opacity="${opacity}" stroke-opacity="${opacity}"`;
  return mark
    .replaceAll('currentColor', fill)
    .replace('<svg ', `<svg${attrs} `)
    .replace(/<title>.*<\/title>\n\s*/, '');
}

/** Imagem lateral do instalador: degradê da marca com o logo no terço superior. */
function innoBig(width: number, height: number): Uint8Array {
  const base = createImage(width, height, (x, y) =>
    mix(NIGHT, BLUE, ((x / width + y / height) / 2) ** 2),
  );
  const size = Math.round(width * 0.72);
  const icon = renderRgba(logoSquare, size);
  return encodeBmp24(
    composite(base, icon, Math.round((width - size) / 2), Math.round(height * 0.18)),
  );
}

/** Ícone pequeno do canto do instalador, sobre fundo branco. */
function innoSmall(width: number, height: number): Uint8Array {
  const base = createImage(width, height, () => [255, 255, 255]);
  const size = Math.round(Math.min(width, height) * 0.9);
  const icon = renderRgba(logoSquare, size);
  return encodeBmp24(
    composite(base, icon, Math.round((width - size) / 2), Math.round((height - size) / 2)),
  );
}

// Tamanhos iguais aos do VS Code para cada escala de DPI do Windows.
const INNO_BIG: Record<number, [number, number]> = {
  100: [164, 314],
  125: [192, 386],
  150: [246, 459],
  175: [273, 556],
  200: [328, 604],
  225: [355, 700],
  250: [410, 797],
};
const INNO_SMALL: Record<number, [number, number]> = {
  100: [55, 55],
  125: [64, 68],
  150: [83, 80],
  175: [92, 97],
  200: [110, 106],
  225: [119, 123],
  250: [138, 140],
};

console.log(`Gerando ícones em ${out}`);

write('resources/darwin/code.icns', icns(logo));

write('resources/win32/code.ico', ico(logoSquare));
write('resources/win32/code_70x70.png', renderPng(logoSquare, 70));
write('resources/win32/code_150x150.png', renderPng(logoSquare, 150));
for (const [scale, [w, h]] of Object.entries(INNO_BIG)) {
  write(`resources/win32/inno-big-${scale}.bmp`, innoBig(w, h));
}
for (const [scale, [w, h]] of Object.entries(INNO_SMALL)) {
  write(`resources/win32/inno-small-${scale}.bmp`, innoSmall(w, h));
}

write('resources/linux/code.png', renderPng(logoSquare, 512));
write('resources/linux/code.svg', logoSquare);

write('resources/server/code-192.png', renderPng(logoSquare, 192));
write('resources/server/code-512.png', renderPng(logoSquare, 512));
write('resources/server/favicon.ico', ico(logoSquare));

write('src/vs/workbench/browser/media/code-icon.svg', logoSquare);
const media = 'src/vs/workbench/browser/parts/editor/media';
write(`${media}/letterpress-dark.svg`, letterpress('#B2B2B2', 0.3));
write(`${media}/letterpress-light.svg`, letterpress('#B2B2B2', 0.1));
write(`${media}/letterpress-hcDark.svg`, letterpress('#3C3C3C'));
write(`${media}/letterpress-hcLight.svg`, letterpress('#B2B2B2'));
