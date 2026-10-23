/**
 * The lab's candidates: B, C ... per track type (A is always the app as it is). Edit this file
 * to try a new idea; sound.ts says how a candidate's sounds are read. `ogain` evens the
 * level (set with `npm run lab:level`, which prints the values to paste here).
 */
import type { SoundKind } from '../../src/engine/project';
import type { Candidate } from './sound';

const KICK_B: Candidate = {
  name: 'B: SOFT → EXTREME',
  note: 'Every TIMBRE sound has its own INT 0 (a soft, slow thump) and INT 100 (its extreme); INT 50 is the app’s sound. INT now moves sweep depth and time too, so SWEEP / SWP TIME could go to FUNC.',
  anchors: [
    {
      name: '808 BOOM',
      values: { ogain: 1.229, t_level: 1, t_pitch: 41, t_sweep: 12, t_stime: 0.06, c_level: 0, c_tone: 1500, c_reso: 0.1, c_len: 0.004, c_noise: 0.2, drive: 1.1, crush: 0 },
      soft: { ogain: 1.277, t_sweep: 4, t_stime: 0.09, drive: 1 },
      // A long, saturated sub drop.
      hard: { ogain: 0.984, t_sweep: 24, t_stime: 0.1, c_level: 0.12, c_tone: 1800, drive: 3 },
    },
    {
      name: 'VINTAGE',
      values: { ogain: 1.157, t_level: 0.95, t_pitch: 44, t_sweep: 14, t_stime: 0.07, c_level: 0.08, c_tone: 1800, c_reso: 0.2, c_len: 0.006, c_noise: 0.3, drive: 1.3, crush: 0 },
      soft: { ogain: 1.244, t_sweep: 6, t_stime: 0.08, c_level: 0.02, drive: 1 },
      // A pushed tape-machine kick: more drop, more knock.
      hard: { ogain: 0.995, t_sweep: 28, t_stime: 0.06, c_level: 0.3, c_tone: 2600, c_reso: 0.35, drive: 3.5 },
    },
    {
      name: 'PUNCH',
      values: { ogain: 0.991, t_level: 0.95, t_pitch: 52, t_sweep: 30, t_stime: 0.03, c_level: 0.35, c_tone: 3800, c_reso: 0.3, c_len: 0.004, c_noise: 0.5, drive: 2, crush: 0 },
      soft: { ogain: 1.096, t_sweep: 10, t_stime: 0.05, c_level: 0.08, c_tone: 2200, drive: 1.2 },
      hard: { ogain: 0.887, t_sweep: 44, t_stime: 0.03, c_level: 0.75, c_tone: 5500, c_reso: 0.5, c_noise: 0.6, drive: 6 },
    },
    {
      name: 'TECHNO',
      values: { ogain: 0.955, t_level: 0.95, t_pitch: 49, t_sweep: 36, t_stime: 0.022, c_level: 0.5, c_tone: 5000, c_reso: 0.4, c_len: 0.003, c_noise: 0.4, drive: 4.5, crush: 0 },
      soft: { ogain: 1.129, t_sweep: 12, t_stime: 0.04, c_level: 0.08, c_tone: 2500, c_reso: 0.15, drive: 1.3 },
      // European hardcore / gabber: higher, very short drop, clipped flat into a mid-heavy square.
      hard: { ogain: 0.738, t_pitch: 58, t_sweep: 30, t_stime: 0.016, c_level: 0.55, c_tone: 3200, c_reso: 0.6, c_len: 0.004, drive: 140 },
    },
    {
      name: 'PSY DOOF',
      values: { ogain: 0.743, t_level: 1, t_pitch: 58, t_sweep: 80, t_stime: 0.028, c_level: 1, c_tone: 9500, c_reso: 0.9, c_len: 0.0015, c_noise: 0.1, drive: 45, crush: 0 },
      soft: { ogain: 0.924, t_sweep: 10, t_stime: 0.06, c_level: 0.1, c_tone: 3000, c_reso: 0.3, drive: 2 },
      // Goa laser: the full 8-octave zap, slow enough to hear it fall.
      hard: { ogain: 0.671, t_sweep: 96, t_stime: 0.14, c_level: 1, c_tone: 12000, c_reso: 0.95, drive: 60 },
    },
  ],
};

export const CANDIDATES: Partial<Record<SoundKind, Candidate[]>> = {
  kick: [KICK_B],
};
