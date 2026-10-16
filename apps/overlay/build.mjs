// Gera o overlay do modo minimizado (ADR 0032) dentro do dist da extensão
// fakl-core, de onde o processo principal o carrega:
// - index.html e overlay.css: a página, com CSP sem script inline;
// - overlay.js: o app (pet e painel);
// - preload.cjs: a ponte `window.faklOverlay` (contextBridge + ipcRenderer).
// Só a pasta overlay/ é recriada: o resto do dist é do build da extensão,
// e os dois podem rodar em qualquer ordem.
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'extensions', 'fakl-core', 'dist', 'overlay');

const common = {
  bundle: true,
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await Promise.all([
  copyFile(join(here, 'static', 'index.html'), join(out, 'index.html')),
  copyFile(join(here, 'static', 'overlay.css'), join(out, 'overlay.css')),
  build({
    ...common,
    entryPoints: [join(here, 'src', 'main.ts')],
    outfile: join(out, 'overlay.js'),
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  }),
  build({
    ...common,
    entryPoints: [join(here, 'src', 'preload.ts')],
    outfile: join(out, 'preload.cjs'),
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    // O Electron entrega o módulo ao preload, mesmo com sandbox.
    external: ['electron'],
  }),
]);
