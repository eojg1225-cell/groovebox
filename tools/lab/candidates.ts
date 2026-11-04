/**
 * The lab's candidates: B, C ... per track type (A is always the app as it is). Edit this file
 * to try a new idea (a candidate = five TIMBRE sounds + INT rules, as in macros.ts MACROS;
 * each sound may carry its own INT 0 `soft` / INT 100 `hard` values; `extra` adds values no
 * SOUND page knob has; `snap` / `arc` its own ratio steps and detours). `ogain` evens the
 * level: `npm run lab:level` prints the values to paste here. A winner moves into macros.ts.
 */
import type { SoundKind } from '../../src/engine/project';
import { HALF_STEPS, MACROS } from '../../src/instruments/macros';
import type { Candidate } from './sound';

/**
 * PLUCK under the new model: TIMBRE = the five canned sounds (wave, FM ratio, filter, envelope,
 * width: all as designed, the SOUND page knobs on top), FM LVL = the modulation (the sound's own
 * until turned), INT only the carrier: no FM LVL, filter, DRIVE, UNISON or DETUNE. The FM ratio
 * steps as on the PAD: whole and half steps, an octave's detour between two sounds.
 */
function pluck(name: string, note: string, extra: Candidate['extra']): Candidate {
  return {
    name,
    note,
    anchors: MACROS.pluck.anchors.map((a) => ({ name: a.name, values: { ...a.values } })),
    excite: [],
    snap: { fmratio: HALF_STEPS },
    arc: { fmratio: { octaves: 1, cycles: 1 } },
    extra,
  };
}

/** PAD's CAR FB rule above the middle: none at INT 50, 0.25 at 75, full at 100. */
const carFb = (x: number) => (x <= 0.5 ? 0 : x <= 0.75 ? (x - 0.5) * 4 * 0.25 : 0.25 + (x - 0.75) * 4 * 0.75);

export const CANDIDATES: Partial<Record<SoundKind, Candidate[]>> = {
  pluck: [
    pluck('B: CZ', 'INT bends the wave as on BASS / LEAD: INT 0 rounded, INT 100 the plain wave (so INT 50 is half bent, a little softer than today). The higher FM LVL, the less INT is heard.', () => ({ cz: 1, cfeedback: 0 })),
    pluck('C: CZ + FEEDBACK', 'INT 0 to 50 bends the wave (INT 50 = the sound as it is today); 50 to 100 feeds the FM pair\'s carrier back into itself, as the PAD\'s CAR FB (the sine turns saw-like, only heard with FM LVL up).', (_t, x) => ({ cz: 1, intensity: Math.min(1, 2 * x), cfeedback: carFb(x) })),
  ],
};
