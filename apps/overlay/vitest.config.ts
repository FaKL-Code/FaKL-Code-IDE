import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'overlay',
    include: ['test/**/*.test.ts'],
  },
});
