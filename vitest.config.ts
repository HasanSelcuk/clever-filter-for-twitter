import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environmentMatchGlobs: [['test/dom.test.ts', 'happy-dom']],
  },
});
