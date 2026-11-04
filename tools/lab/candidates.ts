/**
 * The lab's candidates: B, C ... per track type (A is always the app as it is). Edit this file
 * to try a new idea (a candidate = five TIMBRE sounds + INT rules, as in macros.ts MACROS;
 * each sound may carry its own INT 0 `soft` / INT 100 `hard` values; `extra` adds values no
 * SOUND page knob has, such as the WAVE TEST's). `ogain` evens the level: `npm run lab:level`
 * prints the values to paste here. A winner moves into macros.ts.
 */
import type { SoundKind } from '../../src/engine/project';
import { MACROS } from '../../src/instruments/macros';
import type { Candidate } from './sound';

/**
 * WAVE TEST (BASS, LEAD): the app's five waves with the filter fully open and nothing else
 * on INT: no CUTOFF, RESO, FLT ENV, DRIVE or CRUSH. INT only shapes the wave (Synth
 * `wmode` / `wshape`): near a sine at 0, the plain wave at 100.
 */
function waveTest(kind: 'bass' | 'lead', mode: 1 | 2, name: string, note: string): Candidate {
  return {
    name,
    note,
    anchors: MACROS[kind].anchors.map((a) => ({
      name: a.name,
      values: { ...a.values, cutoff: 20000, reso: 0, fenv: 0, drive: 1, crush: 0 },
    })),
    excite: [],
    extra: (_timbre, intensity) => ({ wmode: mode, wshape: intensity }),
  };
}

const TONE_NOTE = 'INT rounds the wave itself: a gentle filter inside each oscillator that follows the note (so every note gets the same tone), its fundamental kept level. 0 = near a sine, 100 = the plain wave. Filter open, no DRIVE / CRUSH.';
const CZ_NOTE = 'INT bends a cosine into the wave, as the Casio CZ\'s DCW did (phase distortion): 0 = a rounded wave with a trace of its shape, 100 = the plain wave. TRIANGLE crossfades from the sine. Filter open, no DRIVE / CRUSH.';

export const CANDIDATES: Partial<Record<SoundKind, Candidate[]>> = {
  bass: [waveTest('bass', 1, 'B: TONE', TONE_NOTE), waveTest('bass', 2, 'C: CZ', CZ_NOTE)],
  lead: [waveTest('lead', 1, 'B: TONE', TONE_NOTE), waveTest('lead', 2, 'C: CZ', CZ_NOTE)],
};
