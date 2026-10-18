import { defineConfig } from 'vitest/config';

// Projeto "perf": medições de desempenho e carga do Core (RNF-03 e RNF-04).
// Fica fora do `vitest run` padrão (a raiz só enxerga vitest.config.ts) e roda
// com `pnpm test:perf`. Os testes dependem de timing, então rodam em série.
export default defineConfig({
  test: {
    name: 'perf',
    include: ['test-perf/**/*.perf.ts'],
    setupFiles: ['test/setup-pt-br.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    reporters: ['default'],
  },
});
