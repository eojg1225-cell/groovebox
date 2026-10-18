import { defineConfig } from 'vite';

// The sound test is a separate page (not part of the app): built from tools/soundtest into
// dist-soundtest, then packed into one Artifact page by pack.mjs.
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  base: './',
  build: { target: 'es2020', outDir: '../../dist-soundtest', emptyOutDir: true },
  worker: { format: 'iife' },
});
