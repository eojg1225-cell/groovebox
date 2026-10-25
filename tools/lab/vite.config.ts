import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

const here = (p: string) => new URL(p, import.meta.url).pathname;
const SRC = here('../../src/');
const MATH = here('../../src/instruments/math.ts');
const EXACT = here('../../src/instruments/mathExact.ts');
const SHIM = here('./exactEngine.ts');
const SUFFIX = '.exactmath.ts';

/**
 * The maths A / B: exactEngine.ts and everything it imports from src/ are built a second
 * time (ids with SUFFIX), with math.ts (the app's fast tables) swapped for mathExact.ts, so
 * the worklet runs the app's engine and the exact one side by side.
 */
function exactMath(): Plugin {
  return {
    name: 'lab-exact-math',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const fast = importer?.endsWith(SUFFIX) ?? false;
      const from = fast ? importer!.slice(0, -SUFFIX.length) : importer;
      const r = await this.resolve(source, from, { ...options, skipSelf: true });
      if (!r) return null;
      if (r.id === SHIM) return SHIM + SUFFIX;
      if (!fast) return null;
      if (r.id === MATH) return EXACT;
      return r.id.startsWith(SRC) && r.id.endsWith('.ts') ? r.id + SUFFIX : null;
    },
    load(id) {
      return id.endsWith(SUFFIX) ? readFileSync(id.slice(0, -SUFFIX.length), 'utf8') : null;
    },
  };
}

// The sound lab is a separate page (not part of the app): built from tools/lab into
// dist-lab, then packed into one Artifact page by pack.mjs. Its "test" is the level helper
// (`npm run lab:level`), never part of `npm test`.
export default defineConfig({
  root: here('.'),
  base: './',
  build: { target: 'es2020', outDir: '../../dist-lab', emptyOutDir: true },
  worker: { format: 'iife', plugins: () => [exactMath()] },
  test: { include: ['level.test.ts'], environment: 'node' },
});
