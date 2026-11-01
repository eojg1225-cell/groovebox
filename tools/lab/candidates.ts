/**
 * The lab's candidates: B, C ... per track type (A is always the app as it is). Edit this file
 * to try a new idea (a candidate = five TIMBRE sounds + INT rules, as in macros.ts MACROS;
 * each sound may carry its own INT 0 `soft` / INT 100 `hard` values). `ogain` evens the
 * level: `npm run lab:level` prints the values to paste here. A winner moves into macros.ts.
 */
import type { SoundKind } from '../../src/engine/project';
import type { Candidate } from './sound';

export const CANDIDATES: Partial<Record<SoundKind, Candidate[]>> = {
  bass: [
    {
      name: 'B: STICK + ACID 3:2, OWN INT ENDS',
      note: 'SINE SUB, GROWL, STICK, SOLID, ACID, each with its own INT 0 / INT 100 (no type-wide INT rule; INT never moves FM LVL). STICK (new, 1:1 ... 1:3): a tapped Chapman Stick, even and steel-bright. ACID merges ACID and FM 2:3 on 3:2, its filter in line with the others (the squelch at INT 100). FM LVL pushes each sound into its ratio.',
      // The FM ratio ladder in thirds: SINE SUB, GROWL on 1 : 2; STICK on 1 : 3 (sidebands on
      // harmonics 2, 4, 5, 7 ...: an in-tune steel ring over the body); SOLID, ACID on 3 : 2.
      ladder: [[1, 2], [1, 3], [3, 2]],
      // At INT 50 every sound but SINE SUB filters between 420 and 800 Hz, RESO 0.45 at most,
      // FLT ENV 0.2 - 0.6, FLT DEC 0.2 - 0.5 s. Each sound's soft (INT 0) / hard (INT 100)
      // versions set its filter, envelope, drive and width; INT leaves FM LVL alone.
      anchors: [
        {
          // A pure sine; INT 0 rounder still, INT 100 a saturated sub with drive's harmonics.
          name: 'SINE SUB',
          values: { ogain: 0.713, shape: 0, fm: 0.12, sub: 0, cutoff: 3000, reso: 0, fenv: 0, fattack: 0.0005, fdecay: 0.3, fmattack: 0.0005, fmdecay: 0.3, drive: 1, glide: 0.03, decay: 0.7, sustain: 0.8, detune: 0 },
          soft: { ogain: 0.714, cutoff: 1200 },
          hard: { ogain: 0.63, cutoff: 3000, fenv: 0.15, drive: 4, sub: 0.3 },
        },
        {
          // A saw with a sub under a resonant filter; INT 0 muted and narrow, INT 100 an open,
          // driven, wide snarl.
          name: 'GROWL',
          values: { ogain: 0.936, shape: 2, fm: 0.15, sub: 0.5, cutoff: 650, reso: 0.3, fenv: 0.2, fattack: 0.0005, fdecay: 0.5, fmattack: 0.0005, fmdecay: 0.5, drive: 3, glide: 0.04, decay: 1, sustain: 0.9, detune: 0.75 },
          soft: { ogain: 1.007, cutoff: 260, reso: 0.1, fenv: 0.05, drive: 1.3, detune: 0.3 },
          hard: { ogain: 0.818, cutoff: 1400, reso: 0.4, fenv: 0.45, drive: 7, detune: 1.1 },
        },
        {
          // The Boss DR-3's STICK: a tapped Chapman Stick. No pick or finger thump (no woody
          // body, little sub), every note the same: a hammered start, a steady body, a long even
          // decay; the 1 : 3 pair rings steel overtones (in tune) over a triangle body, its FM
          // envelope a short metallic tap. INT 0: dull, rounder taps; INT 100: bright and
          // driven. FM LVL: more steel, towards a DX tine bass.
          name: 'STICK',
          values: { ogain: 0.975, shape: 1, fm: 0.25, sub: 0.05, cutoff: 800, reso: 0.2, fenv: 0.25, fattack: 0.0005, fdecay: 0.4, fmattack: 0.0005, fmdecay: 0.3, drive: 1.2, glide: 0.03, decay: 1.6, sustain: 0.6, detune: 0.03 },
          soft: { ogain: 1.18, cutoff: 500, reso: 0.1, fenv: 0.1, drive: 1, detune: 0 },
          hard: { ogain: 0.944, cutoff: 1600, reso: 0.3, fenv: 0.5, drive: 2.2, detune: 0.1 },
        },
        {
          // A saw-square with a sub and a snapping filter; INT 0 round, INT 100 punchy and driven.
          name: 'SOLID',
          values: { ogain: 2.171, shape: 2.3, fm: 0.15, sub: 0.4, cutoff: 420, reso: 0.45, fenv: 0.5, fattack: 0.0005, fdecay: 0.22, fmattack: 0.0005, fmdecay: 0.22, drive: 1.6, glide: 0.02, decay: 0.5, sustain: 0.45, detune: 0.15 },
          soft: { ogain: 2.389, cutoff: 220, reso: 0.2, fenv: 0.15, drive: 1.1, detune: 0.05 },
          hard: { ogain: 1.624, cutoff: 900, reso: 0.5, fenv: 0.9, fdecay: 0.16, drive: 4, detune: 0.25 },
        },
        {
          // 303: square, a resonant filter with a snappy envelope, now in step with SOLID
          // (cutoff 520, RESO 0.45, FLT ENV 0.6; was 350 / 0.75 / 0.9). INT 0 muted, INT 100 the
          // full squelch. On 3 : 2: FM LVL pushes the square into its odd, bright partials.
          name: 'ACID',
          values: { ogain: 0.596, shape: 3, fm: 0.18, sub: 0.1, cutoff: 520, reso: 0.45, fenv: 0.6, fattack: 0.0005, fdecay: 0.2, fmattack: 0.0005, fmdecay: 0.18, drive: 1.8, glide: 0.06, decay: 0.35, sustain: 0.6, detune: 0 },
          soft: { ogain: 0.643, cutoff: 260, reso: 0.2, fenv: 0.15, drive: 1.2 },
          hard: { ogain: 0.541, cutoff: 700, reso: 0.8, fenv: 1.2, drive: 3.5 },
        },
      ],
      excite: [],
    },
  ],
};
