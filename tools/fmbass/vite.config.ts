import { defineConfig } from 'vite';

// FM bass ratio test (not part of the app): built from tools/fmbass into dist-fmbass, then
// packed into one Artifact page by pack.mjs.
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  base: './',
  build: { target: 'es2020', outDir: '../../dist-fmbass', emptyOutDir: true },
  worker: { format: 'iife' },
});
