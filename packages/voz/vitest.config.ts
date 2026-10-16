import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'voz',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-pt-br.ts'],
  },
});
