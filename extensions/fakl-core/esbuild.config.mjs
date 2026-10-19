// Gera dois arquivos em dist/, com as dependências embutidas, porque o build do
// VS Code empacota extensões embutidas sem instalar node_modules:
// - extension.js: a extensão, que mostra o estado do Core na barra de status;
// - chat/: o chat dos agentes (webview), que roda no navegador do VS Code;
// - mesa/: a Mesa (webview), o canvas com os agentes como cartões;
// - falar/: "Falar um pedido" (webview), que grava, transcreve pelo Core e
//   confirma o pedido por voz; leva o @fakl/voz embutido, como o chat e a Mesa;
// - cafe/: o cyber café (webview), a sala em canvas com os agentes, mais os
//   PNGs de packages/cafe/assets/ e assets.json com a lista do que existe;
// - cozinha/: a cozinha do CI (webview), as execuções do GitHub Actions em tela própria;
// - mermaid/: diagramas Mermaid no preview de Markdown;
// - graph/: o grafo de notas do vault (webview);
// - github/: o GitHub em tela cheia (webview), com README e Markdown renderizados;
// - setup/: a jornada de configuração (webview), aberta na primeira vez e por
//   "FaKL: Configurar";
// - core.mjs: o processo do Core, que o processo principal da IDE inicia com
//   utilityProcess.fork (patches/fakl-core-start.patch). É ESM porque o
//   main.ts do Core usa await no topo;
// - mcp.mjs: o servidor MCP `fakl` que os maestros iniciam por stdio;
// - fakl.mjs: a CLI `fakl`, que a extensão põe no PATH dos terminais.
// A IDE não leva agentes, skills nem modelos de MCP: eles vêm das fontes de
// recursos que o usuário cadastra (~/.fakl/sources.json).
import { copyFile, cp, mkdir, readdir, writeFile } from 'node:fs/promises';

import { build } from 'esbuild';

/** Copia os sprites do café que já existem e lista quais são, para a sala não pedir arquivo que falta. */
async function cafeAssets() {
  const source = '../../packages/cafe/assets';
  const files = (await readdir(source, { recursive: true }).catch(() => []))
    .map((file) => file.split('\\').join('/'))
    .filter((file) => file.endsWith('.png'));
  await cp(source, 'dist/cafe/assets', {
    recursive: true,
    filter: (path) => !path.endsWith('.md'),
  });
  await writeFile('dist/cafe/assets.json', JSON.stringify(files));
}

const ESM_REQUIRE_BANNER =
  "import { createRequire as __faklCreateRequire } from 'node:module'; const require = __faklCreateRequire(import.meta.url);";

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
};

await mkdir('dist/chat', { recursive: true });
await mkdir('dist/cafe', { recursive: true });
await mkdir('dist/cozinha', { recursive: true });
await mkdir('dist/mesa', { recursive: true });
await mkdir('dist/falar', { recursive: true });
await mkdir('dist/mermaid', { recursive: true });
await mkdir('dist/graph', { recursive: true });
await mkdir('dist/github', { recursive: true });
await mkdir('dist/setup', { recursive: true });
await Promise.all([
  copyFile('src/webview/chat.css', 'dist/chat/chat.css'),
  build({
    ...common,
    entryPoints: ['src/webview/chat.ts'],
    outfile: 'dist/chat/chat.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  }),
  copyFile('src/webview/mesa.css', 'dist/mesa/mesa.css'),
  build({
    ...common,
    entryPoints: ['src/webview/mesa.ts'],
    outfile: 'dist/mesa/mesa.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  }),
  copyFile('src/webview/falar.css', 'dist/falar/falar.css'),
  build({
    ...common,
    entryPoints: ['src/webview/falar.ts'],
    outfile: 'dist/falar/falar.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  }),
  copyFile('src/webview/cafe.css', 'dist/cafe/cafe.css'),
  cafeAssets(),
  build({
    ...common,
    entryPoints: ['src/webview/graph.ts'],
    outfile: 'dist/graph/graph.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  }),
  copyFile('src/webview/setup.css', 'dist/setup/setup.css'),
  build({
    ...common,
    entryPoints: ['src/webview/setup.ts'],
    outfile: 'dist/setup/setup.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  }),
  copyFile('src/webview/github.css', 'dist/github/github.css'),
  build({
    ...common,
    entryPoints: ['src/webview/github.ts'],
    outfile: 'dist/github/github.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  }),
  build({
    ...common,
    entryPoints: ['src/webview/mermaid-preview.ts'],
    outfile: 'dist/mermaid/mermaid-preview.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  }),
  copyFile('src/webview/cozinha.css', 'dist/cozinha/cozinha.css'),
  build({
    ...common,
    entryPoints: ['src/webview/cozinha.ts'],
    outfile: 'dist/cozinha/cozinha.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  }),
  build({
    ...common,
    entryPoints: ['src/webview/cafe.ts'],
    outfile: 'dist/cafe/cafe.js',
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
  }),
  build({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
    external: ['vscode'],
  }),
  // Dependências CommonJS (cross-spawn, @vscode/l10n) usam require() de módulos do
  // Node, que não existe em ESM sem o banner. Vale para os três executáveis ESM: sem
  // ele o servidor MCP e a CLI morrem ao iniciar com "Dynamic require of "fs"".
  build({
    ...common,
    entryPoints: ['../../packages/cli/src/main.ts'],
    outfile: 'dist/fakl.mjs',
    format: 'esm',
    banner: { js: ESM_REQUIRE_BANNER },
  }),
  build({
    ...common,
    entryPoints: ['../../packages/core/src/mcp/main.ts'],
    outfile: 'dist/mcp.mjs',
    format: 'esm',
    banner: { js: ESM_REQUIRE_BANNER },
  }),
  build({
    ...common,
    entryPoints: ['../../packages/core/src/main.ts'],
    outfile: 'dist/core.mjs',
    format: 'esm',
    banner: { js: ESM_REQUIRE_BANNER },
  }),
]);
