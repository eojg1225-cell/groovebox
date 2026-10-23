/**
 * Level helper (`npm run lab:level`, not part of `npm test`): measures every candidate's
 * TIMBRE sounds at INT 0, 50 and 100 against the app's sound at the same TIMBRE and INT 50,
 * and prints the OUT GAIN (`ogain`) each soft / plain / hard version needs to play as loud.
 */
import { it } from 'vitest';
import type { SoundKind } from '../../src/engine/project';
import { presetSound } from '../../src/instruments/registry';
import { CANDIDATES } from './candidates';
import { loudness } from './loudness';
import { labSound } from './sound';

it('prints level-matched OUT GAIN values for the candidates', () => {
  for (const [kind, list] of Object.entries(CANDIDATES) as [SoundKind, NonNullable<(typeof CANDIDATES)[SoundKind]>][]) {
    const base = presetSound(kind, 0);
    for (const c of list) {
      const lines = [`${kind} ${c.name}`];
      c.anchors.forEach((a, i) => {
        const t = i / (c.anchors.length - 1);
        const ref = loudness(kind, labSound(kind, null, t, 0.5, base));
        const fix = (x: number, gain: number | undefined) => {
          const d = loudness(kind, labSound(kind, c, t, x, base)) - ref;
          return { d, ogain: (gain ?? a.values.ogain ?? 1) * Math.pow(10, -d / 20) };
        };
        const soft = fix(0, a.soft?.ogain), mid = fix(0.5, a.values.ogain), hard = fix(1, a.hard?.ogain);
        const q = fix(0.25, undefined), tq = fix(0.75, undefined);
        const f = (v: { d: number; ogain: number }) => `${v.ogain.toFixed(3)} (${v.d >= 0 ? '+' : ''}${v.d.toFixed(1)} dB)`;
        lines.push(`  ${a.name}: soft ${f(soft)}  plain ${f(mid)}  hard ${f(hard)}  | INT 25 ${q.d.toFixed(1)} dB, INT 75 ${tq.d.toFixed(1)} dB`);
      });
      console.log(lines.join('\n'));
    }
  }
}, 120_000);
