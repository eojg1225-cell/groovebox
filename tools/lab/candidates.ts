/**
 * The lab's candidates: B, C ... per track type (A is always the app as it is). Edit this file
 * to try a new idea (a candidate = five TIMBRE sounds + INT rules, as in macros.ts MACROS;
 * each sound may carry its own INT 0 `soft` / INT 100 `hard` values). `ogain` evens the
 * level: `npm run lab:level` prints the values to paste here. A winner moves into macros.ts.
 */
import type { SoundKind } from '../../src/engine/project';
import { MACROS } from '../../src/instruments/macros';
import type { Candidate } from './sound';

/**
 * HAT B: RIDE redone with the new BELL (sine partials) and RATTLE (jingle re-hits): a high
 * ride (about 1.47 kHz) of wash, bell and a little rattle. INT works as on the other four
 * (noise, tone, click, drive; the pitch stays). The tail is the type's (closed; RING opens
 * it). HAT, SPLASH, CRASH, CHINA as in A.
 */
const HAT_B: Candidate = {
  name: 'B: BELL RIDE',
  note: 'RIDE only (the other four as A): a high ride made of wash, a sine-partial bell and a light jingle rattle; INT works as on the other sounds and leaves its pitch alone. Closed by default: RING opens it.',
  excite: MACROS.hat.excite,
  anchors: [
    {
      // The sound B had at INT 32 (the pitch the user picked: about 1.47 kHz), now the RIDE
      // itself: wash, a bell and a light jingle rattle. INT works as on the other four.
      name: 'RIDE',
      values: {
        ogain: 0.775, m_level: 0.508, m_pitch: 1470, m_spread: 0.72, m_noise: 0.44, m_tone: 3850, m_mode: 0.82, m_fm: 0.396, m_bell: 0.288, h_rattle: 0.36,
        h_time: 0.0456, h_pitch: 1470, h_tone: 2940, h_noise: 0.212, h_mode: 0.82, h_spread: 0.72, c_level: 0.26, c_tone: 7000, c_reso: 0.5, c_len: 0.003, c_noise: 0.3, drive: 1.06, crush: 0,
      },
    },
    { name: 'HAT', values: { ogain: 1.574, m_level: 0.6, m_pitch: 420, m_spread: 1, m_noise: 0.3, m_tone: 8500, m_mode: 0, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.2, c_tone: 9000, c_reso: 0.3, c_len: 0.002, c_noise: 0.6, drive: 1, crush: 0, m_bell: 0, h_rattle: 0 } },
    { name: 'SPLASH', values: { ogain: 1.306, m_level: 0.7, m_pitch: 620, m_spread: 1, m_noise: 0.55, m_tone: 7000, m_mode: 0.3, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.25, c_tone: 7000, c_reso: 0.3, c_len: 0.003, c_noise: 0.7, drive: 1.2, crush: 0, m_bell: 0, h_rattle: 0 } },
    { name: 'CRASH', values: { ogain: 1.186, m_level: 0.7, m_pitch: 480, m_spread: 1, m_noise: 0.7, m_tone: 4500, m_mode: 0.5, m_fm: 0.5, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.3, c_tone: 5000, c_reso: 0.3, c_len: 0.004, c_noise: 0.8, drive: 1.5, crush: 0, m_bell: 0, h_rattle: 0 } },
    { name: 'CHINA', values: { ogain: 0.968, m_level: 0.75, m_pitch: 320, m_spread: 0.8, m_noise: 0.4, m_tone: 1500, m_mode: 1, m_fm: 0.6, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.4, c_tone: 3000, c_reso: 0.4, c_len: 0.003, c_noise: 0.5, drive: 4, crush: 0.05, m_bell: 0, h_rattle: 0 } },
  ],
};

export const CANDIDATES: Partial<Record<SoundKind, Candidate[]>> = {
  hat: [HAT_B],
};
