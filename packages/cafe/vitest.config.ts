import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'cafe',
    include: ['test/**/*.test.ts'],
  },
});
