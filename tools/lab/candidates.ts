/**
 * The lab's candidates: B, C ... per track type (A is always the app as it is). Edit this file
 * to try a new idea (a candidate = five TIMBRE sounds + INT rules, as in macros.ts MACROS;
 * each sound may carry its own INT 0 `soft` / INT 100 `hard` values). `ogain` evens the
 * level: `npm run lab:level` prints the values to paste here. A winner moves into macros.ts.
 */
import type { SoundKind } from '../../src/engine/project';
import { MACROS } from '../../src/instruments/macros';
import type { Candidate } from './sound';

const bass = MACROS.bass.anchors;
const named = (n: string) => bass.find((a) => a.name === n)!;

export const CANDIDATES: Partial<Record<SoundKind, Candidate[]>> = {
  bass: [
    {
      name: 'B: BASS GTR + ACID 3:2',
      note: 'SINE SUB, GROWL, BASS GTR, SOLID, ACID. ACID and FM 2:3 merged into one ACID at the far end, in the 3:2 stretch (FM LVL pushes the square into odd 3:2 partials), its filter nearer the others (the old squelch comes back at INT 100). BASS GTR is new, in the middle on 1:1: a picked bass guitar, softly fingered at INT 0, a DX-style FM pluck bass at INT 100.',
      // The FM ratio ladder in thirds: SINE SUB, GROWL on 1 : 2; BASS GTR on 1 : 1 (every
      // harmonic, a string's); SOLID, ACID on 3 : 2. 2 : 3 is gone.
      ladder: [[1, 2], [1, 1], [3, 2]],
      anchors: [
        named('SINE SUB'),
        named('GROWL'),
        {
          // A picked electric bass: a soft saw-ish string through a low-pass that closes as the
          // string dies, a quick FM tick on the pick (1 : 1), long decay to a low sustain.
          // INT 0: fingered (FM almost gone, dark). INT 100: the DX-style FM pluck bass (the 1 : 1
          // pair to the fore with a fast FM envelope, bright, short).
          name: 'BASS GTR',
          values: { ogain: 1.833, shape: 1.7, fm: 0.18, sub: 0.15, cutoff: 800, reso: 0.1, fenv: 0.45, fattack: 0.0005, fdecay: 0.35, fmattack: 0.0005, fmdecay: 0.08, drive: 1.3, glide: 0.03, decay: 1.4, sustain: 0.3, detune: 0.05 },
          soft: { ogain: 1.746, fm: 0.06, fmdecay: 0.05 },
          hard: { ogain: 2.059, shape: 0.8, fm: 0.58, fmdecay: 0.18, cutoff: 3200, fenv: 0.8, fdecay: 0.15, decay: 0.6, sustain: 0.08, drive: 1.8 },
        },
        named('SOLID'),
        {
          // 303 square, resonant filter with a snappy envelope, but in step with GROWL / SOLID
          // (cutoff 520, RESO 0.5, ENV 0.6 instead of 350 / 0.75 / 0.9); INT 100 brings back the
          // full squelch. On 3 : 2: FM LVL pushes it into the odd, bright 3 : 2 partials.
          name: 'ACID',
          values: { ogain: 0.592, shape: 3, fm: 0.18, sub: 0.1, cutoff: 520, reso: 0.5, fenv: 0.6, fattack: 0.0005, fdecay: 0.2, fmattack: 0.0005, fmdecay: 0.18, drive: 1.8, glide: 0.06, decay: 0.35, sustain: 0.6, detune: 0 },
          soft: { ogain: 0.731 },
          hard: { ogain: 0.542, reso: 0.8, fenv: 1.1, drive: 3.2 },
        },
      ],
      excite: MACROS.bass.excite,
    },
  ],
};
