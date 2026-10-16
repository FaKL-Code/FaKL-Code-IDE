// Gera dist/extension.js com todas as dependências embutidas, porque o build
// do VS Code empacota extensões embutidas sem instalar node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  // O jsonc-parser publica um UMD em "main" que o esbuild não consegue embutir.
  mainFields: ['module', 'main'],
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});
