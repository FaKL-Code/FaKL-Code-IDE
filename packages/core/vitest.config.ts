import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'core',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-pt-br.ts'],
    // Vários testes sobem o Core, rodam git ou abrem processos; no runner
    // Windows, com cobertura e os outros projetos em paralelo, passam dos 5 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
