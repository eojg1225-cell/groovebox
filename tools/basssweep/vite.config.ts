import { defineConfig } from 'vite';

// Bass TIMBRE sweep test (not part of the app): built from tools/basssweep into dist-basssweep, then
// packed into one Artifact page by pack.mjs.
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  base: './',
  build: { target: 'es2020', outDir: '../../dist-basssweep', emptyOutDir: true },
  worker: { format: 'iife' },
});
