import { defineConfig } from 'vitest/config';

/** `npm run engine:golden`: the engine golden test (needs cargo). */
export default defineConfig({
  test: {
    include: ['tools/native/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
  },
});
