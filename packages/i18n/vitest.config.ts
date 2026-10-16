import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'i18n',
    include: ['test/**/*.test.ts'],
  },
});
