import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'fakl-settings',
    include: ['test/**/*.test.ts'],
  },
});
