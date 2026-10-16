import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'fakl-core',
    include: ['test/**/*.test.ts'],
  },
});
