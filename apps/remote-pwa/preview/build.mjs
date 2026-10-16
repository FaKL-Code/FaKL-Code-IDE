// Gera preview/dist/ com o app do celular falando com uma IDE de mentira
// (preview/fake-remote.ts), para ver e fotografar as telas sem relay nem Core.
// Abra preview/dist/index.html?tela=conversa no navegador.
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

/** Os módulos de rede e de armazenamento viram os de mentira. */
const fakes = {
  name: 'fakes',
  setup(b) {
    b.onResolve({ filter: /^@fakl\/remote$/ }, (args) =>
      args.importer.endsWith('fake-remote.ts') || args.importer.endsWith('fake-storage.ts')
        ? undefined
        : { path: join(here, 'fake-remote.ts') },
    );
    b.onResolve({ filter: /\/storage\.js$/ }, (args) =>
      args.importer.includes(`${join('preview', 'fake-storage.ts')}`)
        ? undefined
        : { path: join(here, 'fake-storage.ts') },
    );
  },
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await Promise.all([
  cp(join(here, '..', 'static'), out, { recursive: true }),
  copyFile(
    join(here, '..', '..', '..', 'branding', 'logo', 'fakl-code.svg'),
    join(out, 'icon.svg'),
  ),
  build({
    entryPoints: [join(here, 'preview.ts')],
    outfile: join(out, 'app.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'info',
    plugins: [fakes],
  }),
]);
