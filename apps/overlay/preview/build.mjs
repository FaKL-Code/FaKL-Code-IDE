// Gera preview/dist/ com o overlay falando com um Core de mentira
// (preview/fake-core.ts), para ver e fotografar o pet e o painel sem a IDE.
// Abra preview/dist/index.html?forma=painel no navegador.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const statics = join(here, '..', 'static');

// Limpa o conteúdo, não a pasta: no Windows, um servidor aberto nela a prende.
await mkdir(out, { recursive: true });
for (const entry of await readdir(out)) {
  await rm(join(out, entry), { recursive: true, force: true });
}

// A mesma página do build, com a folha da prévia depois da do app.
const html = (await readFile(join(statics, 'index.html'), 'utf8')).replace(
  '<link rel="stylesheet" href="overlay.css" />',
  '<link rel="stylesheet" href="overlay.css" />\n    <link rel="stylesheet" href="preview.css" />',
);

await Promise.all([
  writeFile(join(out, 'index.html'), html),
  copyFile(join(statics, 'overlay.css'), join(out, 'overlay.css')),
  copyFile(join(here, 'preview.css'), join(out, 'preview.css')),
  build({
    entryPoints: [join(here, 'preview.ts')],
    outfile: join(out, 'overlay.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'info',
  }),
]);
console.log(`Prévia em ${join(out, 'index.html')}`);
