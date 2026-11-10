import { defineConfig } from 'vitest/config';

const here = (p: string) => new URL(p, import.meta.url).pathname;
// The sound lab is a separate page (not part of the app): built from tools/lab into
// dist-lab, then packed into one Artifact page by pack.mjs. Its "test" is the level helper
// (`npm run lab:level`), never part of `npm test`.
export default defineConfig({
  root: here('.'),
  base: './',
  build: { target: 'es2020', outDir: '../../dist-lab', emptyOutDir: true },
  worker: { format: 'iife' },
  test: { include: ['level.test.ts'], environment: 'node' },
});
