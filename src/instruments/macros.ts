/**
 * TIMBRE and INTENSITY: two macro knobs per track type that give the groovebox its own
 * sounds. TIMBRE travels through four designed sounds ("anchors"), blending every
 * parameter between neighbours (on the parameter's own curve, so frequencies and times
 * move musically). INTENSITY then damps (0) or excites (1) the result around a neutral
 * middle (0.5) by scaling brightness, drive, decay and so on. INTENSITY changes
 * character, never loudness: turned down a sound softens but still cuts through.
 *
 * Pure functions: the UI computes the sound and sends the resulting parameters.
 */
import type { SoundKind } from '../engine/project';
import { toNorm, toValue, type ParamSpec } from '../engine/params';

export interface Anchor {
  name: string;
  values: Record<string, number>;
}

/** INTENSITY scaling: value x low^(1-2i) below the middle, x high^(2i-1) above. */
export interface Excite {
  id: string;
  low: number;
  high: number;
}

export interface MacroDef {
  anchors: readonly Anchor[];
  excite: readonly Excite[];
}

export const MACROS: Record<SoundKind, MacroDef> = {
  kick: {
    anchors: [
      { name: 'VINTAGE', values: { t_level: 0.95, t_pitch: 44, t_sweep: 14, t_stime: 0.07, t_decay: 1, c_level: 0.08, c_tone: 1800, c_reso: 0.2, c_len: 0.006, c_noise: 0.3, drive: 1.3, crush: 0 } },
      { name: 'PUNCH', values: { t_level: 0.95, t_pitch: 52, t_sweep: 30, t_stime: 0.03, t_decay: 0.45, c_level: 0.35, c_tone: 3800, c_reso: 0.3, c_len: 0.004, c_noise: 0.5, drive: 2, crush: 0 } },
      { name: 'TECHNO', values: { t_level: 0.95, t_pitch: 49, t_sweep: 36, t_stime: 0.022, t_decay: 0.38, c_level: 0.5, c_tone: 5000, c_reso: 0.4, c_len: 0.003, c_noise: 0.4, drive: 4.5, crush: 0 } },
      // Over the top on purpose: a 6-7 octave laser zap down into a square-driven doof.
      { name: 'PSY DOOF', values: { t_level: 1, t_pitch: 58, t_sweep: 80, t_stime: 0.028, t_decay: 0.32, c_level: 1, c_tone: 9500, c_reso: 0.9, c_len: 0.0015, c_noise: 0.1, drive: 45, crush: 0 } },
    ],
    excite: [
      { id: 'drive', low: 0.6, high: 2 }, { id: 'c_level', low: 0.6, high: 1.5 }, { id: 't_sweep', low: 0.8, high: 1.15 },
      { id: 'c_tone', low: 0.7, high: 1.4 }, { id: 't_decay', low: 0.85, high: 1.15 },
    ],
  },
  snare: {
    anchors: [
      // Jazz rimshot: a woody, high knock with a little wire and a light decay.
      { name: 'RIMSHOT', values: { t_level: 0.85, t_pitch: 420, t_sweep: 5, t_decay: 0.07, m_level: 0.45, m_noise: 0.6, m_pitch: 900, m_tone: 3200, m_decay: 0.09, m_spread: 0.5, m_mode: 0, m_fm: 0.3, drive: 1.6, crush: 0 } },
      { name: 'TIGHT', values: { t_level: 0.6, t_pitch: 240, t_sweep: 6, t_decay: 0.09, m_level: 0.8, m_noise: 0.85, m_pitch: 400, m_tone: 3500, m_decay: 0.12, m_spread: 1, m_mode: 0, m_fm: 0.3, drive: 1.5, crush: 0 } },
      { name: 'BREAK', values: { t_level: 0.6, t_pitch: 195, t_sweep: 10, t_decay: 0.16, m_level: 0.9, m_noise: 0.9, m_pitch: 330, m_tone: 1800, m_decay: 0.24, m_spread: 1, m_mode: 0, m_fm: 0.3, drive: 2.2, crush: 0 } },
      { name: 'INDUSTRIAL', values: { t_level: 0.7, t_pitch: 150, t_sweep: 18, t_decay: 0.2, m_level: 0.9, m_noise: 0.45, m_pitch: 180, m_tone: 600, m_decay: 0.3, m_spread: 1, m_mode: 2, m_fm: 0.8, drive: 7, crush: 0.35 } },
    ],
    excite: [
      { id: 'drive', low: 0.7, high: 2 }, { id: 'm_tone', low: 0.6, high: 1.5 }, { id: 'm_decay', low: 0.8, high: 1.3 },
      { id: 't_sweep', low: 0.7, high: 1.3 }, { id: 'm_noise', low: 0.85, high: 1.1 },
    ],
  },
  hat: {
    // Every hit starts as its HEAD (a hat; at the far left a ride bell) and morphs into the
    // tail, so short hits stay hats and the tail (and RING) decides the cymbal.
    anchors: [
      { name: 'RIDE', values: { m_level: 0.55, m_pitch: 1150, m_spread: 0.35, m_noise: 0.25, m_tone: 3000, m_decay: 0.45, m_mode: 2, m_fm: 0.45, h_time: 0.06, h_pitch: 1500, h_tone: 6000, h_noise: 0.02, h_mode: 2, h_spread: 0.25, ring: 2.5, c_level: 0.35, c_tone: 6000, c_reso: 0.5, c_len: 0.003, c_noise: 0.3, drive: 1.2, crush: 0 } },
      { name: 'HAT', values: { m_level: 0.6, m_pitch: 420, m_spread: 1, m_noise: 0.3, m_tone: 8500, m_decay: 0.07, m_mode: 0, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, ring: 0.45, c_level: 0.2, c_tone: 9000, c_reso: 0.3, c_len: 0.002, c_noise: 0.6, drive: 1, crush: 0 } },
      { name: 'CRASH', values: { m_level: 0.7, m_pitch: 480, m_spread: 1, m_noise: 0.7, m_tone: 4500, m_decay: 0.14, m_mode: 0.5, m_fm: 0.5, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, ring: 2.2, c_level: 0.3, c_tone: 5000, c_reso: 0.3, c_len: 0.004, c_noise: 0.8, drive: 1.5, crush: 0 } },
      { name: 'CHINA', values: { m_level: 0.75, m_pitch: 320, m_spread: 0.8, m_noise: 0.4, m_tone: 1500, m_decay: 0.14, m_mode: 1, m_fm: 0.6, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, ring: 1.6, c_level: 0.4, c_tone: 3000, c_reso: 0.4, c_len: 0.003, c_noise: 0.5, drive: 4, crush: 0.05 } },
    ],
    excite: [
      { id: 'm_tone', low: 0.6, high: 1.5 }, { id: 'm_decay', low: 0.7, high: 1.4 }, { id: 'drive', low: 0.8, high: 2.5 },
      { id: 'm_noise', low: 0.8, high: 1.3 }, { id: 'c_level', low: 0.6, high: 1.5 },
    ],
  },
  perc: {
    // Pitched from the sequencer: toms and congas follow the notes, the bells too.
    anchors: [
      { name: 'LOW TOM', values: { t_level: 0.95, t_pitch: 95, t_sweep: 9, t_stime: 0.08, t_decay: 0.5, c_level: 0.3, c_tone: 2200, c_reso: 0.3, c_len: 0.004, c_noise: 0.5, m_level: 0, m_pitch: 540, m_spread: 0.2, m_noise: 0, m_tone: 700, m_decay: 0.1, m_mode: 0, drive: 1.3 } },
      { name: 'CONGA', values: { t_level: 0.9, t_pitch: 210, t_sweep: 4, t_stime: 0.02, t_decay: 0.2, c_level: 0.55, c_tone: 3500, c_reso: 0.55, c_len: 0.003, c_noise: 0.25, m_level: 0, m_pitch: 540, m_spread: 0.2, m_noise: 0, m_tone: 700, m_decay: 0.1, m_mode: 0, drive: 1.2 } },
      { name: 'COWBELL', values: { t_level: 0, t_pitch: 210, t_sweep: 0, t_stime: 0.02, t_decay: 0.1, c_level: 0.15, c_tone: 3000, c_reso: 0.3, c_len: 0.002, c_noise: 0.3, m_level: 0.85, m_pitch: 540, m_spread: 0.2, m_noise: 0, m_tone: 700, m_decay: 0.22, m_mode: 0, drive: 1.5 } },
      { name: 'CLAVE', values: { t_level: 0.85, t_pitch: 2400, t_sweep: 0, t_stime: 0.01, t_decay: 0.045, c_level: 0.6, c_tone: 2400, c_reso: 0.92, c_len: 0.015, c_noise: 0.05, m_level: 0, m_pitch: 540, m_spread: 0.2, m_noise: 0, m_tone: 700, m_decay: 0.05, m_mode: 0, drive: 1.1 } },
    ],
    excite: [
      { id: 't_sweep', low: 0.7, high: 1.4 }, { id: 'c_level', low: 0.6, high: 1.5 }, { id: 'drive', low: 0.8, high: 2.2 },
      { id: 't_decay', low: 0.8, high: 1.25 },
    ],
  },
  bass: {
    anchors: [
      { name: 'SINE SUB', values: { shape: 0, fm: 0, fmratio: 2, detune: 0, sub: 0, cutoff: 3000, reso: 0, fenv: 0, fdecay: 0.3, decay: 0.7, sustain: 0.8, drive: 1, glide: 0.03 } },
      { name: 'SOLID', values: { shape: 2.3, fm: 0, fmratio: 2, detune: 0.15, sub: 0.4, cutoff: 420, reso: 0.45, fenv: 0.5, fdecay: 0.22, decay: 0.5, sustain: 0.45, drive: 1.6, glide: 0.02 } },
      { name: 'GROWL', values: { shape: 2, fm: 0.05, fmratio: 2, detune: 0.75, sub: 0.5, cutoff: 650, reso: 0.3, fenv: 0.2, fdecay: 0.5, decay: 1, sustain: 0.9, drive: 3, glide: 0.04 } },
      { name: 'FM CLANG', values: { shape: 0, fm: 1, fmratio: 3.5, detune: 0, sub: 0.2, cutoff: 4000, reso: 0.2, fenv: 0.35, fdecay: 0.18, decay: 0.5, sustain: 0.25, drive: 2.2, glide: 0.02 } },
    ],
    excite: [
      { id: 'cutoff', low: 0.5, high: 2 }, { id: 'fenv', low: 0.6, high: 1.4 }, { id: 'drive', low: 0.7, high: 2 },
      { id: 'fm', low: 0.7, high: 1.3 }, { id: 'reso', low: 0.8, high: 1.2 },
    ],
  },
  pad: {
    anchors: [
      { name: 'GLASS', values: { unison: 0, fattack: 0.0005, shape: 0, fm: 0.75, fmratio: 2, detune: 0.2, cutoff: 7000, reso: 0.1, fenv: 0.3, fdecay: 0.8, attack: 0.02, decay: 1.1, sustain: 0.35, release: 1.8, drive: 1 } },
      { name: 'WARM', values: { unison: 0, fattack: 0.0005, shape: 2, fm: 0, fmratio: 2, detune: 0.4, cutoff: 900, reso: 0.15, fenv: 0.1, fdecay: 1, attack: 0.5, decay: 1.2, sustain: 0.8, release: 1.4, drive: 1 } },
      { name: 'STRINGS', values: { unison: 0, fattack: 0.0005, shape: 2, fm: 0, fmratio: 2, detune: 0.75, cutoff: 2600, reso: 0.1, fenv: 0.15, fdecay: 1, attack: 0.35, decay: 1.5, sustain: 0.85, release: 1.6, drive: 1.2 } },
      // Euphoric and ethereal: an FM supersaw (unison saws, FM at 3:2) that swells open.
      { name: 'ETHEREAL', values: { shape: 2, unison: 1, fm: 0.35, fmratio: 1.5, detune: 1.6, cutoff: 7000, reso: 0.15, fattack: 1.5, fenv: 0.3, fdecay: 4, attack: 0.7, decay: 3, attack2: 1.8, decay2: 4, sustain: 0.95, release: 3.5, drive: 1.1 } },
    ],
    excite: [
      { id: 'cutoff', low: 0.55, high: 1.8 }, { id: 'detune', low: 0.7, high: 1.3 }, { id: 'drive', low: 0.8, high: 2 },
      { id: 'fm', low: 0.7, high: 1.3 }, { id: 'release', low: 0.8, high: 1.2 }, { id: 'unison', low: 0.6, high: 1.4 },
    ],
  },
  lead: {
    anchors: [
      { name: 'SINE', values: { shape: 0, fm: 0, fmratio: 2, detune: 0, glide: 0.08, cutoff: 6000, reso: 0.1, fenv: 0, fdecay: 0.3, attack: 0.01, decay: 0.5, sustain: 0.8, release: 0.2, drive: 1.2 } },
      { name: 'SQUARE', values: { shape: 3, fm: 0, fmratio: 2, detune: 0.15, glide: 0.05, cutoff: 2400, reso: 0.3, fenv: 0.3, fdecay: 0.3, attack: 0.005, decay: 0.5, sustain: 0.6, release: 0.15, drive: 1.5 } },
      { name: 'SCREAM', values: { shape: 2, fm: 0, fmratio: 2, detune: 0.5, glide: 0.06, cutoff: 900, reso: 0.8, fenv: 0.65, fdecay: 0.4, attack: 0.005, decay: 0.5, sustain: 0.7, release: 0.2, drive: 4 } },
      { name: 'BELL', values: { shape: 0, fm: 0.85, fmratio: 3, detune: 0, glide: 0.03, cutoff: 6000, reso: 0.1, fenv: 0.4, fdecay: 0.5, attack: 0.002, decay: 0.6, sustain: 0.2, release: 0.5, drive: 1.3 } },
    ],
    excite: [
      { id: 'cutoff', low: 0.55, high: 1.8 }, { id: 'reso', low: 0.8, high: 1.15 }, { id: 'drive', low: 0.7, high: 2.2 },
      { id: 'fm', low: 0.7, high: 1.3 }, { id: 'fenv', low: 0.7, high: 1.3 },
    ],
  },
  pluck: {
    // Soft, bowed-string pizzicato -> glassy -> sync zap -> a raging FM donk.
    anchors: [
      { name: 'PIZZICATO', values: { shape: 2.2, fm: 0, fmratio: 2, detune: 0.12, unison: 0, sync: 1, cutoff: 1600, reso: 0.15, fenv: 0.35, fdecay: 0.1, fattack: 0.0005, attack: 0.002, decay: 0.3, attack2: 0.004, decay2: 0.22, sustain: 0, release: 0.25, drive: 1.1 } },
      { name: 'GLASS PLUCK', values: { shape: 1, fm: 0.25, fmratio: 3, detune: 0.2, unison: 0, sync: 2, cutoff: 3500, reso: 0.2, fenv: 0.5, fdecay: 0.15, fattack: 0.0005, attack: 0.001, decay: 0.4, attack2: 0.001, decay2: 0.3, sustain: 0, release: 0.3, drive: 1.2 } },
      { name: 'SYNC ZAP', values: { shape: 2, fm: 0.1, fmratio: 2, detune: 0.3, unison: 0.3, sync: 4.5, cutoff: 5000, reso: 0.3, fenv: 0.7, fdecay: 0.2, fattack: 0.0005, attack: 0.001, decay: 0.35, attack2: 0.001, decay2: 0.35, sustain: 0.05, release: 0.2, drive: 2.5 } },
      { name: 'RAGE DONK', values: { shape: 0, fm: 1, fmratio: 2, detune: 0.1, unison: 0, sync: 6, cutoff: 8000, reso: 0.4, fenv: 0.9, fdecay: 0.12, fattack: 0.0005, attack: 0.0005, decay: 0.25, attack2: 0.0005, decay2: 0.18, sustain: 0, release: 0.12, drive: 12 } },
    ],
    excite: [
      { id: 'cutoff', low: 0.55, high: 1.8 }, { id: 'drive', low: 0.7, high: 2.2 }, { id: 'fm', low: 0.7, high: 1.3 },
      { id: 'sync', low: 0.8, high: 1.3 }, { id: 'fenv', low: 0.7, high: 1.3 },
    ],
  },
};

// Synth anchors design one envelope; OSC 2 starts with the same ATTACK / DECAY as OSC 1.
for (const kind of ['bass', 'pad', 'lead'] as const) {
  for (const a of MACROS[kind].anchors) {
    if (a.values.attack !== undefined) a.values.attack2 ??= a.values.attack;
    if (a.values.decay !== undefined) a.values.decay2 ??= a.values.decay;
  }
}

/** Name of the anchor nearest a TIMBRE position (for the screen). */
export function timbreName(kind: SoundKind, timbre: number): string {
  const a = MACROS[kind].anchors;
  return a[Math.round(Math.min(1, Math.max(0, timbre)) * (a.length - 1))].name;
}

/** TIMBRE position of anchor `i` (anchors evenly spaced 0..1). */
export function anchorPosition(kind: SoundKind, i: number): number {
  return i / (MACROS[kind].anchors.length - 1);
}

/**
 * The parameters a TIMBRE / INTENSITY position produces for a track type.
 * `specs` = that type's parameter list (for ranges and curves).
 */
export function macroSound(kind: SoundKind, timbre: number, intensity: number, specs: readonly ParamSpec[]): Record<string, number> {
  const { anchors, excite } = MACROS[kind];
  const t = Math.min(1, Math.max(0, timbre)) * (anchors.length - 1);
  const i0 = Math.min(anchors.length - 2, Math.floor(t));
  const f = t - i0;
  const a = anchors[i0].values;
  const b = anchors[i0 + 1].values;
  const out: Record<string, number> = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const spec = specs.find((p) => p.id === id);
    if (!spec) continue;
    const va = a[id] ?? b[id];
    const vb = b[id] ?? a[id];
    // Blend on the parameter's own curve (log for frequencies and times).
    out[id] = toValue(spec, toNorm(spec, va) + (toNorm(spec, vb) - toNorm(spec, va)) * f);
  }
  const x = Math.min(1, Math.max(0, intensity));
  for (const e of excite) {
    const spec = specs.find((p) => p.id === e.id);
    if (!spec || out[e.id] === undefined) continue;
    const factor = x < 0.5 ? Math.pow(e.low, 1 - 2 * x) : Math.pow(e.high, 2 * x - 1);
    out[e.id] = Math.min(spec.max, Math.max(spec.min, out[e.id] * factor));
  }
  return out;
}
