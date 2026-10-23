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
 * HAT B: RIDE redone with the new BELL (sine partials) and RATTLE (jingle re-hits): a
 * tambourine at INT 0, a ride's bow (wash + ping) at INT 50, a clean ride bell (Boss DR-3
 * style) at INT 100; it sets its own tail (M DEC). HAT, SPLASH, CRASH, CHINA as in A.
 */
const HAT_B: Candidate = {
  name: 'B: TAMBOURINE > RIDE > BELL',
  note: 'RIDE only (the other four as A): INT 0 a tambourine (jingle rattle), INT 50 a ride (wash + ping), INT 100 a clean ride bell from sine partials. RIDE sets its own tail length.',
  excite: MACROS.hat.excite,
  anchors: [
    {
      name: 'RIDE',
      values: {
        ogain: 0.351, m_level: 0.4, m_pitch: 640, m_spread: 0.45, m_noise: 0.35, m_tone: 3000, m_mode: 1, m_fm: 0.45, m_decay: 0.35, m_bell: 0.45, h_rattle: 0,
        h_time: 0.06, h_pitch: 900, h_tone: 1800, h_noise: 0.05, h_mode: 1, h_spread: 0.45, c_level: 0.35, c_tone: 6500, c_reso: 0.5, c_len: 0.003, c_noise: 0.3, drive: 1.1, crush: 0,
      },
      // Tambourine: small high jingles, a rattle of re-hits, a short shake.
      soft: {
        ogain: 1.258, m_level: 0.7, m_pitch: 3200, m_spread: 1.2, m_noise: 0.6, m_tone: 6000, m_mode: 0.5, m_fm: 0.3, m_decay: 0.14, m_bell: 0, h_rattle: 1,
        h_time: 0.02, h_pitch: 3500, h_tone: 7000, h_noise: 0.5, h_mode: 0.5, h_spread: 1.2, c_level: 0.1, c_tone: 8000, drive: 1,
      },
      // Ride bell: the bell's partials ringing out, a little wash and the stick.
      hard: {
        ogain: 0.298, m_level: 0.15, m_pitch: 820, m_noise: 0.2, m_tone: 3000, m_fm: 0.45, m_decay: 0.9, m_bell: 1,
        h_time: 0.01, h_pitch: 820, h_tone: 3000, h_noise: 0.1, c_level: 0.5, c_tone: 4000, c_reso: 0.6, drive: 1.2,
      },
    },
    { name: 'HAT', values: { ogain: 1.574, m_level: 0.6, m_pitch: 420, m_spread: 1, m_noise: 0.3, m_tone: 8500, m_mode: 0, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.2, c_tone: 9000, c_reso: 0.3, c_len: 0.002, c_noise: 0.6, drive: 1, crush: 0, m_decay: 0.1, m_bell: 0, h_rattle: 0 } },
    { name: 'SPLASH', values: { ogain: 1.306, m_level: 0.7, m_pitch: 620, m_spread: 1, m_noise: 0.55, m_tone: 7000, m_mode: 0.3, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.25, c_tone: 7000, c_reso: 0.3, c_len: 0.003, c_noise: 0.7, drive: 1.2, crush: 0, m_decay: 0.1, m_bell: 0, h_rattle: 0 } },
    { name: 'CRASH', values: { ogain: 1.186, m_level: 0.7, m_pitch: 480, m_spread: 1, m_noise: 0.7, m_tone: 4500, m_mode: 0.5, m_fm: 0.5, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.3, c_tone: 5000, c_reso: 0.3, c_len: 0.004, c_noise: 0.8, drive: 1.5, crush: 0, m_decay: 0.1, m_bell: 0, h_rattle: 0 } },
    { name: 'CHINA', values: { ogain: 0.968, m_level: 0.75, m_pitch: 320, m_spread: 0.8, m_noise: 0.4, m_tone: 1500, m_mode: 1, m_fm: 0.6, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.4, c_tone: 3000, c_reso: 0.4, c_len: 0.003, c_noise: 0.5, drive: 4, crush: 0.05, m_decay: 0.1, m_bell: 0, h_rattle: 0 } },
  ],
};

export const CANDIDATES: Partial<Record<SoundKind, Candidate[]>> = {
  hat: [HAT_B],
};
