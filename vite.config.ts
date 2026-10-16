import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works from any sub-path (e.g. GitHub Pages /groovebox/).
  base: './',
  build: {
    target: 'es2020',
  },
  worker: {
    // The AudioWorklet module is bundled as a classic self-contained script.
    format: 'iife',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
