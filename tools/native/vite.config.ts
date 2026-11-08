import { defineConfig } from 'vitest/config';

/** `npm run native:null`: the native engine's null tests against the TypeScript engine (needs cargo). */
export default defineConfig({
  test: {
    include: ['tools/native/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
  },
});
