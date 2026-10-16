// Gera dist/ com o app do celular, que o relay serve (SDD 12.4).
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';

import { build } from 'esbuild';

const common = {
  bundle: true,
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
  target: ['es2022', 'safari16'],
  platform: 'browser',
};

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await Promise.all([
  cp('static', 'dist', { recursive: true }),
  copyFile('../../branding/logo/fakl-code.svg', 'dist/icon.svg'),
  build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/app.js', format: 'iife' }),
  build({ ...common, entryPoints: ['src/sw/sw.ts'], outfile: 'dist/sw.js', format: 'iife' }),
]);
