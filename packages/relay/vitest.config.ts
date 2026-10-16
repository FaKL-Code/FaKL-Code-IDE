import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'relay',
    include: ['test/**/*.test.ts'],
  },
});
