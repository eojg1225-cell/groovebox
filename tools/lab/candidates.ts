/**
 * The lab's candidates: B, C ... per track type (A is always the app as it is). Edit this file
 * to try a new idea (a candidate = five TIMBRE sounds + INT rules, as in macros.ts MACROS;
 * each sound may carry its own INT 0 `soft` / INT 100 `hard` values). `ogain` evens the
 * level: `npm run lab:level` prints the values to paste here. A winner moves into macros.ts.
 */
import type { SoundKind } from '../../src/engine/project';
import type { Candidate } from './sound';

/**
 * SNARE B: BRUSH replaces PICCOLO (first, the softest); every sound gets the stick's crack
 * (the click layer), SHELL (drumhead overtones on the body) and its own tail lengths, and runs
 * from its own soft (INT 0) to its own extreme (INT 100). TIGHT's extreme is the piccolo.
 * Every sound lists every value its soft / hard ends move.
 */
const SNARE_B: Candidate = {
  name: 'B: BRUSH, CRACK, SHELL',
  note: 'BRUSH first (PICCOLO gone). Every sound gets a stick crack, drumhead overtones (SHELL) and its own tail lengths; INT runs each from soft to its extreme. TIGHT at INT 100 = piccolo.',
  excite: [],
  anchors: [
    {
      // A soft swish: the click layer as slow band-passed noise, a little body, soft wires.
      name: 'BRUSH',
      values: {
        ogain: 1.158, t_level: 0.25, t_pitch: 200, t_sweep: 2, t_shell: 0, t_decay: 0.12, m_level: 0.35, m_noise: 1, m_pitch: 330, m_tone: 2500, m_attack: 0.012, m_decay: 0.18,
        m_spread: 1, m_mode: 0, m_fm: 0.3, c_level: 0.8, c_tone: 4500, c_attack: 0.025, c_len: 0.12, c_reso: 0.15, c_noise: 1, drive: 1, crush: 0,
      },
      soft: { ogain: 1.415, t_level: 0.15, m_level: 0.2, c_level: 0.6, c_tone: 3500, c_attack: 0.04, c_len: 0.15 },
      // A brush slap: the swish lands fast, with some body and wire.
      hard: { ogain: 0.916, t_level: 0.45, t_decay: 0.14, m_level: 0.5, m_attack: 0.003, c_level: 1, c_tone: 5500, c_attack: 0.004, c_reso: 0.3 },
    },
    {
      name: 'RIMSHOT',
      values: {
        ogain: 1.099, t_level: 0.85, t_pitch: 420, t_sweep: 5, t_shell: 0.5, t_decay: 0.12, m_level: 0.45, m_noise: 0.6, m_pitch: 900, m_tone: 3200, m_attack: 0.0005, m_decay: 0.15,
        m_spread: 0.5, m_mode: 0, m_fm: 0.3, c_level: 0.6, c_tone: 1800, c_attack: 0.0005, c_len: 0.004, c_reso: 0.6, c_noise: 0.2, drive: 1.6, crush: 0,
      },
      // A cross-stick knock.
      soft: { ogain: 1.446, t_shell: 0.3, t_decay: 0.08, m_level: 0.1, m_noise: 0.8, c_level: 0.4, c_tone: 1200, c_reso: 0.7, drive: 1.1 },
      // A full rimshot: hard crack, high ring.
      hard: { ogain: 0.849, t_pitch: 460, t_shell: 0.9, t_decay: 0.18, m_level: 0.55, c_level: 1, c_tone: 2500, c_reso: 0.75, drive: 2.5 },
    },
    {
      name: 'TIGHT',
      values: {
        ogain: 1.237, t_level: 0.6, t_pitch: 240, t_sweep: 6, t_shell: 0.35, t_decay: 0.12, m_level: 0.8, m_noise: 0.85, m_pitch: 400, m_tone: 3500, m_attack: 0.0005, m_decay: 0.16,
        m_spread: 1, m_mode: 0, m_fm: 0.3, c_level: 0.4, c_tone: 3500, c_attack: 0.0005, c_len: 0.003, c_reso: 0.35, c_noise: 0.5, drive: 1.5, crush: 0,
      },
      // Muted and dry.
      soft: { ogain: 1.733, t_shell: 0.1, t_decay: 0.08, m_level: 0.6, m_tone: 2500, m_decay: 0.09, c_level: 0.1, drive: 1.1 },
      // Piccolo: high, crisp crack, short tuned ring, short bright wires.
      hard: {
        ogain: 1.011, t_pitch: 380, t_sweep: 4, t_shell: 0.85, t_decay: 0.2, m_level: 0.85, m_noise: 0.97, m_tone: 5000, m_decay: 0.12,
        c_level: 0.9, c_tone: 5000, c_reso: 0.5, drive: 1.8,
      },
    },
    {
      name: 'BREAK',
      values: {
        ogain: 0.931, t_level: 0.6, t_pitch: 195, t_sweep: 10, t_shell: 0.25, t_decay: 0.16, m_level: 0.9, m_noise: 0.9, m_pitch: 330, m_tone: 1800, m_attack: 0.0005, m_decay: 0.22,
        m_spread: 1, m_mode: 0, m_fm: 0.3, c_level: 0.35, c_tone: 2500, c_attack: 0.0005, c_len: 0.004, c_reso: 0.3, c_noise: 0.6, drive: 2.2, crush: 0,
      },
      // A ghost-note snare.
      soft: { ogain: 1.162, t_sweep: 4, t_decay: 0.12, m_tone: 1500, m_decay: 0.15, c_level: 0.1, drive: 1.2 },
      // Fat and driven, longer wires.
      hard: { ogain: 0.696, t_sweep: 14, t_shell: 0.35, t_decay: 0.22, m_noise: 0.95, m_decay: 0.35, c_level: 0.6, drive: 6 },
    },
    {
      name: 'INDUSTRIAL',
      values: {
        ogain: 0.755, t_level: 0.7, t_pitch: 150, t_sweep: 18, t_shell: 0, t_decay: 0.14, m_level: 0.9, m_noise: 0.45, m_pitch: 180, m_tone: 600, m_attack: 0.0005, m_decay: 0.2,
        m_spread: 1, m_mode: 2, m_fm: 0.8, c_level: 0.3, c_tone: 1500, c_attack: 0.0005, c_len: 0.003, c_reso: 0.5, c_noise: 0.3, drive: 7, crush: 0.35,
      },
      // Clean metal.
      soft: { ogain: 0.998, t_sweep: 8, m_fm: 0.3, c_level: 0.1, drive: 2.5, crush: 0 },
      // More FM metal, more CRUSH.
      hard: { ogain: 0.738, t_sweep: 26, m_spread: 1.6, m_fm: 1.8, c_level: 0.6, drive: 14, crush: 0.6 },
    },
  ],
};

export const CANDIDATES: Partial<Record<SoundKind, Candidate[]>> = {
  snare: [SNARE_B],
};
