// Empacota o relay num único arquivo para a imagem Docker (sem node_modules).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'bundle/relay.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
  // Dependências CommonJS usam require() de módulos do Node.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  // Acelerações nativas opcionais do ws.
  external: ['bufferutil', 'utf-8-validate'],
});
