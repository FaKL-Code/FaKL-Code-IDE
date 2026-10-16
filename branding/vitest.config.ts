import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'branding',
    include: ['test/**/*.test.ts'],
  },
});
