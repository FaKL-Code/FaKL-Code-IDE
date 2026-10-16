import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'agents',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-pt-br.ts'],
    // Worktrees e diffs usam git real; no runner Windows, com cobertura e os
    // outros projetos em paralelo, um teste passa dos 5 s do limite padrão.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
