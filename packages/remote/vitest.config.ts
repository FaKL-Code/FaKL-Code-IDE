import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'remote',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-pt-br.ts'],
  },
});
