import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'remote-pwa',
    include: ['test/**/*.test.ts'],
  },
});
