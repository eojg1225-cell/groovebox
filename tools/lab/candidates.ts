/**
 * The lab's candidates: B, C ... per track type (A is always the app as it is). Edit this file
 * to try a new idea (a candidate = five TIMBRE sounds + INT rules, as in macros.ts MACROS;
 * each sound may carry its own INT 0 `soft` / INT 100 `hard` values). `ogain` evens the
 * level: `npm run lab:level` prints the values to paste here. A winner moves into macros.ts.
 */
import type { SoundKind } from '../../src/engine/project';
import { MACROS } from '../../src/instruments/macros';
import type { Candidate } from './sound';

const [BOOM, VINTAGE, PUNCH, TECHNO, DOOF] = MACROS.kick.anchors;

const KICK_B: Candidate = {
  name: 'B: SWEEP, NOT DRIVE',
  note: 'VINTAGE: more noise in the click. TECHNO at INT 100: a hard house kick (a taller, longer sweep than PUNCH’s, far less DRIVE). PSY DOOF: the click fades out as INT rises, less DRIVE, and at INT 100 the full 10-octave laser held longer.',
  anchors: [
    BOOM,
    { ...VINTAGE, values: { ...VINTAGE.values, c_noise: 0.8 } },
    PUNCH,
    {
      ...TECHNO,
      // Hard house: a tall drop that you hear fall, a punchy tail, only lightly clipped.
      hard: { ogain: 0.882, t_pitch: 55, t_decay: 0.35, t_sweep: 72, t_stime: 0.07, c_level: 0.4, c_tone: 3200, c_reso: 0.5, c_len: 0.004, drive: 10 },
    },
    {
      ...DOOF,
      values: { ...DOOF.values, ogain: 0.768, c_level: 0.12, drive: 16 },
      soft: { ...DOOF.soft, c_level: 0.2 },
      // Goa laser: the full 10-octave zap (held at the top of the hearing range), slow
      // enough to hear it fall; no click, little drive.
      hard: { ogain: 0.613, t_sweep: 120, t_stime: 0.26, c_level: 0, drive: 8 },
    },
  ],
  excite: [],
};

export const CANDIDATES: Partial<Record<SoundKind, Candidate[]>> = {
  kick: [KICK_B],
};
