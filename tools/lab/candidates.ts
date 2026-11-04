/**
 * The lab's candidates: B, C ... per track type (A is always the app as it is). Edit this file
 * to try a new idea (a candidate = five TIMBRE sounds + INT rules, as in macros.ts MACROS;
 * each sound may carry its own INT 0 `soft` / INT 100 `hard` values; `extra` adds values no
 * SOUND page knob has; `snap` / `arc` its own ratio steps and detours). `ogain` evens the
 * level: `npm run lab:level` prints the values to paste here. A winner moves into macros.ts.
 */
import type { SoundKind } from '../../src/engine/project';
import { MACROS } from '../../src/instruments/macros';
import type { Candidate } from './sound';

/**
 * PAD with PLUCK's INT recipe: the app's five sounds and INT rules (CARRIERS: stack 2 fades out
 * below the middle; CAR FB above it), plus CZ bending the carriers' waves below INT 50 (Synth
 * cz 2, as on PLUCK: INT 0 rounded, the plain wave from INT 50).
 */
function pad(name: string, note: string, extra: Record<string, number>): Candidate {
  return {
    name,
    note,
    anchors: MACROS.pad.anchors.map((a) => ({ name: a.name, values: { ...a.values } })),
    excite: MACROS.pad.excite,
    extra: () => ({ cz: 2, ...extra }),
  };
}

export const CANDIDATES: Partial<Record<SoundKind, Candidate[]>> = {
  pad: [
    pad('B: CZ', 'PLUCK\'s recipe: below INT 50 CZ bends the carriers\' waves (and stack 2 fades, as now); above it the carrier feedback as now (a fifth of it on saw-like waves, so WARM / STRINGS change little up there). INT 50 = the sound as it is.', {}),
    pad('C: CZ + FULL FEEDBACK', 'B, with the carrier feedback above INT 50 at full strength on every wave: WARM and STRINGS get brighter and rougher up to INT 100 too. INT 50 = the sound as it is.', { cfbfull: 1 }),
  ],
};
