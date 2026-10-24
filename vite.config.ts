import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works from any sub-path (e.g. GitHub Pages /groovebox/).
  base: './',
  build: {
    target: 'es2020',
    // The panel font goes inline (the Artifact build is one page, no asset files).
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? true : undefined),
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
