import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'settings-sync',
    include: ['test/**/*.test.ts'],
    // Os testes de sincronização rodam dezenas de comandos git reais; no runner
    // Windows do GitHub cada um leva perto de 5 s, o limite padrão.
    testTimeout: 30_000,
  },
});
