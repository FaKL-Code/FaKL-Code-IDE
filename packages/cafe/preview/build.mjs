// Gera preview/dist/index.html, a prévia do café num arquivo só, com o
// script embutido. `--serve` serve a pasta do pacote, para a prévia achar
// os PNGs de assets/ em http://localhost:8123/preview/dist/?assets=../../assets/
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, context } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const options = {
  entryPoints: [join(here, 'preview.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  logLevel: 'info',
};

async function page(js) {
  const html = await readFile(join(here, 'index.html'), 'utf8');
  await mkdir(join(here, 'dist'), { recursive: true });
  await writeFile(
    join(here, 'dist', 'index.html'),
    html.replace('<!--script-->', `<script>${js}</script>`),
  );
}

if (process.argv.includes('--serve')) {
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: 'page',
        setup(b) {
          b.onEnd(async (result) => {
            if (result.outputFiles?.[0]) await page(result.outputFiles[0].text);
          });
        },
      },
    ],
  });
  await ctx.watch();
  // Servidor estático da pasta do pacote, só para a prévia achar assets/.
  const root = join(here, '..');
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.png': 'image/png',
    '.js': 'text/javascript',
  };
  createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    const file = join(root, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res
        .writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  }).listen(8123, () => {
    console.log('Prévia em http://localhost:8123/preview/dist/?assets=../../assets/');
  });
} else {
  const result = await build(options);
  await page(result.outputFiles[0].text);
}
