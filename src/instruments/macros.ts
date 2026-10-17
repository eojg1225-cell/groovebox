/**
 * TIMBRE and INTENSITY: two macro knobs per track type that give the groovebox its own
 * sounds. TIMBRE travels through four designed sounds ("anchors"), blending every
 * parameter between neighbours (on the parameter's own curve, so frequencies and times
 * move musically): the coarse choice of sound. INTENSITY then sets the amount of
 * modulation / atmosphere around a neutral middle (0.5 = as designed): down, FM, filter
 * envelope, sweep, noise, click, drive and width converge on a dull floor (keeping a
 * trace (2 %) of the TIMBRE's own character); up, they are excited. Never loudness.
 * Layers: hidden (these) < design (SOUND page knobs, stored as trims on top, see trims.ts)
 * < live (relative knobs in the engine).
 *
 * Pure functions: the UI computes the sound and sends the resulting parameters.
 */
import type { SoundKind } from '../engine/project';
import { toNorm, toValue, type ParamSpec } from '../engine/params';

export interface Anchor {
  name: string;
  values: Record<string, number>;
}

/**
 * INTENSITY (the amount of modulation / atmosphere): below the middle a parameter moves
 * towards its dull FLOOR - CONVERGE of the way at 0, on its own curve - so every TIMBRE
 * lands in the same soft area but keeps 2 % of its own character (TIMBRE still
 * matters at 0). Above the middle it is scaled x high^(2i-1). No floor = unchanged below.
 */
export interface Excite {
  id: string;
  floor?: number;
  /** Above the middle: x high^(2i-1). */
  high?: number;
  /**
   * Above the middle instead (modulation, DX7-style taper): up to KNEE at 75 % (or stays if
   * the sound is already past it), then on to TOP at 100 % - the bite is in the top quarter.
   */
  knee?: number;
  top?: number;
}

/** How far INTENSITY 0 pulls the modulation towards its floor (the rest stays TIMBRE's). */
export const CONVERGE = 0.98;

export interface MacroDef {
  anchors: readonly Anchor[];
  excite: readonly Excite[];
}

export const MACROS: Record<SoundKind, MacroDef> = {
  kick: {
    anchors: [
      // Dub / jungle: a tuned 808 boom - pure sine, slow drop, no click (RING makes it sing).
      { name: '808 BOOM', values: { t_level: 1, t_pitch: 41, t_sweep: 12, t_stime: 0.06, c_level: 0, c_tone: 1500, c_reso: 0.1, c_len: 0.004, c_noise: 0.2, drive: 1.1, crush: 0 } },
      { name: 'VINTAGE', values: { t_level: 0.95, t_pitch: 44, t_sweep: 14, t_stime: 0.07, c_level: 0.08, c_tone: 1800, c_reso: 0.2, c_len: 0.006, c_noise: 0.3, drive: 1.3, crush: 0 } },
      { name: 'PUNCH', values: { t_level: 0.95, t_pitch: 52, t_sweep: 30, t_stime: 0.03, c_level: 0.35, c_tone: 3800, c_reso: 0.3, c_len: 0.004, c_noise: 0.5, drive: 2, crush: 0 } },
      { name: 'TECHNO', values: { t_level: 0.95, t_pitch: 49, t_sweep: 36, t_stime: 0.022, c_level: 0.5, c_tone: 5000, c_reso: 0.4, c_len: 0.003, c_noise: 0.4, drive: 4.5, crush: 0 } },
      // Over the top on purpose: a 6-7 octave laser zap down into a square-driven doof.
      { name: 'PSY DOOF', values: { t_level: 1, t_pitch: 58, t_sweep: 80, t_stime: 0.028, c_level: 1, c_tone: 9500, c_reso: 0.9, c_len: 0.0015, c_noise: 0.1, drive: 45, crush: 0 } },
    ],
    excite: [
      { id: 'drive', floor: 1, high: 2 }, { id: 'c_level', floor: 0.02, high: 1.5 }, { id: 't_sweep', floor: 2, high: 1.15 },
      { id: 'c_tone', floor: 700, high: 1.4 }, { id: 'c_noise', floor: 0.05, high: 1.2 }, { id: 'c_reso', floor: 0.05, high: 1.2 },
    ],
  },
  snare: {
    anchors: [
      // Jazz rimshot: a woody, high knock with a little wire and a light decay.
      { name: 'RIMSHOT', values: { t_level: 0.85, t_pitch: 420, t_sweep: 5, m_level: 0.45, m_noise: 0.6, m_pitch: 900, m_tone: 3200, m_spread: 0.5, m_mode: 0, m_fm: 0.3, drive: 1.6, crush: 0 } },
      // Dub piccolo: high, tight and ringing.
      { name: 'PICCOLO', values: { t_level: 0.7, t_pitch: 330, t_sweep: 4, m_level: 0.7, m_noise: 0.7, m_pitch: 600, m_tone: 4500, m_spread: 0.8, m_mode: 0, m_fm: 0.3, drive: 1.4, crush: 0 } },
      { name: 'TIGHT', values: { t_level: 0.6, t_pitch: 240, t_sweep: 6, m_level: 0.8, m_noise: 0.85, m_pitch: 400, m_tone: 3500, m_spread: 1, m_mode: 0, m_fm: 0.3, drive: 1.5, crush: 0 } },
      { name: 'BREAK', values: { t_level: 0.6, t_pitch: 195, t_sweep: 10, m_level: 0.9, m_noise: 0.9, m_pitch: 330, m_tone: 1800, m_spread: 1, m_mode: 0, m_fm: 0.3, drive: 2.2, crush: 0 } },
      { name: 'INDUSTRIAL', values: { t_level: 0.7, t_pitch: 150, t_sweep: 18, m_level: 0.9, m_noise: 0.45, m_pitch: 180, m_tone: 600, m_spread: 1, m_mode: 2, m_fm: 0.8, drive: 7, crush: 0.35 } },
    ],
    excite: [
      { id: 'drive', floor: 1, high: 2 }, { id: 'm_tone', floor: 900, high: 1.5 },
      { id: 't_sweep', floor: 1, high: 1.3 }, { id: 'm_noise', floor: 0.2, high: 1.1 }, { id: 'm_fm', floor: 0, high: 1.3 },
    ],
  },
  hat: {
    // Every hit starts as its HEAD (a hat; at the far left a ride bell) and morphs into the
    // tail, so short hits stay hats and the tail (and RING) decides the cymbal.
    anchors: [
      { name: 'RIDE', values: { m_level: 0.55, m_pitch: 1150, m_spread: 0.35, m_noise: 0.25, m_tone: 3000, m_mode: 2, m_fm: 0.45, h_time: 0.06, h_pitch: 1500, h_tone: 6000, h_noise: 0.02, h_mode: 2, h_spread: 0.25, c_level: 0.35, c_tone: 6000, c_reso: 0.5, c_len: 0.003, c_noise: 0.3, drive: 1.2, crush: 0 } },
      { name: 'HAT', values: { m_level: 0.6, m_pitch: 420, m_spread: 1, m_noise: 0.3, m_tone: 8500, m_mode: 0, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.2, c_tone: 9000, c_reso: 0.3, c_len: 0.002, c_noise: 0.6, drive: 1, crush: 0 } },
      // Splash: a small, bright cymbal - higher and hissier than the crash.
      { name: 'SPLASH', values: { m_level: 0.7, m_pitch: 620, m_spread: 1, m_noise: 0.55, m_tone: 7000, m_mode: 0.3, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.25, c_tone: 7000, c_reso: 0.3, c_len: 0.003, c_noise: 0.7, drive: 1.2, crush: 0 } },
      { name: 'CRASH', values: { m_level: 0.7, m_pitch: 480, m_spread: 1, m_noise: 0.7, m_tone: 4500, m_mode: 0.5, m_fm: 0.5, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.3, c_tone: 5000, c_reso: 0.3, c_len: 0.004, c_noise: 0.8, drive: 1.5, crush: 0 } },
      { name: 'CHINA', values: { m_level: 0.75, m_pitch: 320, m_spread: 0.8, m_noise: 0.4, m_tone: 1500, m_mode: 1, m_fm: 0.6, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.4, c_tone: 3000, c_reso: 0.4, c_len: 0.003, c_noise: 0.5, drive: 4, crush: 0.05 } },
    ],
    excite: [
      { id: 'm_tone', floor: 3500, high: 1.5 }, { id: 'drive', floor: 1, high: 2.5 },
      { id: 'm_noise', floor: 0.1, high: 1.3 }, { id: 'c_level', floor: 0.12, high: 1.5 }, { id: 'm_fm', floor: 0.1, high: 1.3 },
    ],
  },
  perc: {
    // Pitched from the sequencer: toms and congas follow the notes, the bells too. Every
    // sound sits on the same note (C: toms C3, conga C4, cowbell metal C5, clave C7), so
    // TIMBRE never changes the pitch of a line; positions between sounds snap to a C too.
    anchors: [
      { name: 'LOW TOM', values: { t_level: 0.95, t_pitch: 130.81, t_sweep: 9, t_stime: 0.08, c_level: 0.3, c_tone: 2200, c_reso: 0.3, c_len: 0.004, c_noise: 0.5, m_level: 0, m_pitch: 523.24, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.3 } },
      // Syn drum: the Simmons 'pew' - a deep pitch sweep.
      { name: 'SYN DRUM', values: { t_level: 0.95, t_pitch: 130.81, t_sweep: 24, t_stime: 0.12, c_level: 0.1, c_tone: 2500, c_reso: 0.2, c_len: 0.003, c_noise: 0.3, m_level: 0, m_pitch: 523.24, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.3 } },
      { name: 'CONGA', values: { t_level: 0.9, t_pitch: 261.62, t_sweep: 4, t_stime: 0.02, c_level: 0.55, c_tone: 3500, c_reso: 0.55, c_len: 0.003, c_noise: 0.25, m_level: 0, m_pitch: 523.24, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.2 } },
      { name: 'COWBELL', values: { t_level: 0, t_pitch: 261.62, t_sweep: 0, t_stime: 0.02, c_level: 0.15, c_tone: 3000, c_reso: 0.3, c_len: 0.002, c_noise: 0.3, m_level: 0.85, m_pitch: 523.24, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.5 } },
      { name: 'CLAVE', values: { t_level: 0.85, t_pitch: 2092.96, t_sweep: 0, t_stime: 0.01, c_level: 0.6, c_tone: 2092.96, c_reso: 0.92, c_len: 0.015, c_noise: 0.05, m_level: 0, m_pitch: 523.24, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.1 } },
    ],
    excite: [
      // The top quarter turns any of them into a warped clang: the metal layer comes in,
      // goes ring-mod -> FM and spreads, the sweep and the click resonance run wild, drive.
      { id: 't_sweep', floor: 1, knee: 12, top: 60 }, { id: 'drive', floor: 1, knee: 2.5, top: 20 },
      { id: 'c_reso', floor: 0.1, knee: 0.6, top: 0.95 }, { id: 'c_level', floor: 0.03, high: 1.5 },
      { id: 'c_tone', floor: 700, high: 1.4 }, { id: 'c_noise', floor: 0.05, high: 1.2 },
      { id: 'm_level', floor: 0, knee: 0.15, top: 0.8 }, { id: 'm_mode', knee: 0.5, top: 1.7 },
      { id: 'm_fm', floor: 0, knee: 0.6, top: 3.5 }, { id: 'm_spread', knee: 0.5, top: 2.2 },
    ],
  },
  bass: {
    anchors: [
      { name: 'SINE SUB', values: { shape: 0, fm: 0, fmratio: 2, detune: 0, sub: 0, cutoff: 3000, reso: 0, fenv: 0, fdecay: 0.3, drive: 1, glide: 0.03 } },
      { name: 'SOLID', values: { shape: 2.3, fm: 0, fmratio: 2, detune: 0.15, sub: 0.4, cutoff: 420, reso: 0.45, fenv: 0.5, fdecay: 0.22, drive: 1.6, glide: 0.02 } },
      // 303: square through a resonant filter with a short, snappy envelope (accents and slides).
      { name: '303', values: { shape: 3, fm: 0, fmratio: 2, detune: 0, sub: 0, cutoff: 350, reso: 0.75, fenv: 0.9, fdecay: 0.18, drive: 1.8, glide: 0.06 } },
      { name: 'GROWL', values: { shape: 2, fm: 0.05, fmratio: 2, detune: 0.75, sub: 0.5, cutoff: 650, reso: 0.3, fenv: 0.2, fdecay: 0.5, drive: 3, glide: 0.04 } },
      { name: 'FM CLANG', values: { shape: 0, fm: 1, fmratio: 3.5, detune: 0, sub: 0.2, cutoff: 4000, reso: 0.2, fenv: 0.35, fdecay: 0.18, drive: 2.2, glide: 0.02 } },
    ],
    excite: [
      { id: 'cutoff', floor: 150, high: 2 }, { id: 'fenv', floor: 0.05, high: 1.4 }, { id: 'drive', floor: 1, high: 2 },
      { id: 'fm', floor: 0, knee: 0.5, top: 1 }, { id: 'reso', floor: 0.05, high: 1.2 }, { id: 'detune', floor: 0.05, high: 1.3 },
    ],
  },
  pad: {
    // CHORD (kind "pad", geared for stabs): the 3 CARRIER engine, polyphonic, carriers at
    // related ratios on one feedback modulator (carrier 1 : 2 : 3, modulator). INTENSITY 0 = carrier 1 alone, a plain pad;
    // the stack and the DX7-style FM come in as it rises, biting in the top quarter.
    anchors: [
      { name: 'GLASS', values: { unison: 0, fattack: 0.0005, shape: 0, fm: 0.72, fmratio: 2, ratio2: 2, ratio3: 3, feedback: 0.1, carriers: 0.4, detune: 0.2, cutoff: 7000, reso: 0.1, fenv: 0.3, fdecay: 0.8, drive: 1 } },
      // Tine: a DX7 electric-piano pad - 1 : 1 body with a 4x tine, struck by the envelope.
      { name: 'TINE', values: { unison: 0, fattack: 0.0005, shape: 0, fm: 0.78, fmratio: 1, ratio2: 1, ratio3: 4, feedback: 0.2, carriers: 0.3, detune: 0.15, cutoff: 6000, reso: 0.1, fenv: 0.6, fdecay: 0.6, drive: 1.1 } },
      { name: 'WARM', values: { unison: 0, fattack: 0.0005, shape: 2, fm: 0.45, fmratio: 1, ratio2: 1, ratio3: 0.5, feedback: 0.3, carriers: 0.45, detune: 0.4, cutoff: 900, reso: 0.15, fenv: 0.1, fdecay: 1, drive: 1 } },
      { name: 'STRINGS', values: { unison: 0, fattack: 0.0005, shape: 2, fm: 0.5, fmratio: 1, ratio2: 1.5, ratio3: 2, feedback: 0.35, carriers: 0.35, detune: 0.75, cutoff: 2600, reso: 0.1, fenv: 0.15, fdecay: 1, drive: 1.2 } },
      // Euphoric and ethereal: unison saws with carriers on 3:2 and 3.
      { name: 'ETHEREAL', values: { shape: 2, unison: 1, fm: 0.6, fmratio: 1.5, ratio2: 1.5, ratio3: 3, feedback: 0.25, carriers: 0.5, detune: 1.6, cutoff: 7000, reso: 0.15, fattack: 0.0005, fenv: 0.45, fdecay: 0.8, drive: 1.1 } },
    ],
    excite: [
      { id: 'fm', floor: 0, knee: 0.6, top: 1 }, { id: 'feedback', floor: 0, knee: 0.6, top: 1 }, { id: 'carriers', floor: 0, knee: 0.6, top: 1 },
      { id: 'fenv', floor: 0, high: 1.3 }, { id: 'reso', floor: 0.05, high: 1.2 },
      { id: 'cutoff', floor: 400, high: 1.4 }, { id: 'detune', floor: 0.1, high: 1.1 }, { id: 'drive', floor: 1, high: 1.5 },
      { id: 'unison', floor: 0, high: 1.1 },
    ],
  },
  lead: {
    // DX7-style: one feedback modulator into three carriers at related ratios (carrier 1 :
    // carrier 2 : carrier 3, modulator). ODD (the most chilled) first. With INTENSITY down
    // carrier 1 alone plays a simple wave - one clear note; carriers 2 / 3 and the
    // modulation come in as it rises, the ratios biting in the top quarter.
    anchors: [
      { name: 'ODD 2:3', values: { shape: 0.7, unison: 0, fm: 0.56, fmratio: 1.5, ratio2: 1.5, ratio3: 2.5, feedback: 0.3, carriers: 0.3, detune: 0.05, glide: 0.06, cutoff: 5000, reso: 0.15, fenv: 0.45, fdecay: 0.5, drive: 1.2 } },
      // Organ: drawbar-style carriers 1 : 2 : 3 on soft waves, full sustain - a bass or a lead.
      { name: 'ORGAN', values: { shape: 0.6, unison: 0, fm: 0.4, fmratio: 1, ratio2: 2, ratio3: 3, feedback: 0.15, carriers: 0.6, detune: 0.05, glide: 0.06, cutoff: 6000, reso: 0.05, fenv: 0.1, fdecay: 0.1, drive: 1.2 } },
      { name: 'SAW 1:1', values: { shape: 2, unison: 0, fm: 0.52, fmratio: 1, ratio2: 1, ratio3: 1, feedback: 0.5, carriers: 0.35, detune: 0.25, glide: 0.06, cutoff: 3200, reso: 0.15, fenv: 0.3, fdecay: 0.4, drive: 1.3 } },
      { name: 'OCT 1:2', values: { shape: 3, unison: 0, fm: 0.54, fmratio: 1, ratio2: 2, ratio3: 0.5, feedback: 0.4, carriers: 0.35, detune: 0.15, glide: 0.06, cutoff: 2600, reso: 0.25, fenv: 0.35, fdecay: 0.35, drive: 1.4 } },
      { name: 'FIFTH 3:2', values: { shape: 1.5, unison: 0, fm: 0.55, fmratio: 1, ratio2: 1.5, ratio3: 2, feedback: 0.35, carriers: 0.35, detune: 0.1, glide: 0.06, cutoff: 3800, reso: 0.2, fenv: 0.4, fdecay: 0.4, drive: 1.3 } },
    ],
    excite: [
      { id: 'fm', floor: 0, knee: 0.6, top: 1 }, { id: 'feedback', floor: 0, knee: 0.6, top: 1 }, { id: 'carriers', floor: 0, knee: 0.6, top: 1 },
      { id: 'cutoff', floor: 700, high: 1.4 }, { id: 'reso', floor: 0.05, high: 1.15 }, { id: 'drive', floor: 1, high: 1.5 },
      { id: 'fenv', floor: 0.05, high: 1.3 }, { id: 'detune', floor: 0.05, high: 1.1 },
    ],
  },
  pluck: {
    // Glassy -> a bright saw pluck -> a hollow, buzzy square pluck -> a raging FM donk.
    anchors: [
      // Steel: an FM steel-drum pluck (inharmonic 1 : 2.5).
      { name: 'STEEL', values: { shape: 0, fm: 0.7, fmratio: 2.5, detune: 0.1, unison: 0, cutoff: 5000, reso: 0.15, fenv: 0.7, fdecay: 0.2, fattack: 0.0005, drive: 1.2 } },
      { name: 'GLASS PLUCK', values: { shape: 1, fm: 0.25, fmratio: 3, detune: 0.2, unison: 0, cutoff: 3500, reso: 0.2, fenv: 0.5, fdecay: 0.15, fattack: 0.0005, drive: 1.2 } },
      { name: 'SAW PLUCK', values: { shape: 2, fm: 0.05, fmratio: 2, detune: 0.35, unison: 0.5, cutoff: 4500, reso: 0.3, fenv: 0.75, fdecay: 0.18, fattack: 0.0005, drive: 2 } },
      { name: 'SQUARE PLUCK', values: { shape: 3, fm: 0.1, fmratio: 2, detune: 0.25, unison: 0.2, cutoff: 4000, reso: 0.35, fenv: 0.7, fdecay: 0.16, fattack: 0.0005, drive: 2.5 } },
      { name: 'RAGE DONK', values: { shape: 0, fm: 1, fmratio: 2, detune: 0.1, unison: 0, cutoff: 8000, reso: 0.4, fenv: 1.2, fdecay: 0.12, fattack: 0.0005, drive: 12 } },
    ],
    excite: [
      { id: 'fm', floor: 0, knee: 0.6, top: 1 }, { id: 'fenv', floor: 0.1, high: 1.3 }, { id: 'reso', floor: 0.05, high: 1.2 },
      { id: 'cutoff', floor: 500, high: 1.4 }, { id: 'drive', floor: 1, high: 1.6 }, { id: 'unison', floor: 0, high: 1.1 }, { id: 'detune', floor: 0.05, high: 1.1 },
    ],
  },
};

// The synths' amp envelopes (ATTACK / DECAY / SUSTAIN / RELEASE, both oscillators) are the
// type's own, like the drums' tails: TIMBRE never sets them, so an ADSR you set stays put.

/** Each type's four sounds before v19 (a fifth was added; older TIMBRE positions move). */
const ANCHORS_V18: Record<SoundKind, readonly string[]> = {
  kick: ['VINTAGE', 'PUNCH', 'TECHNO', 'PSY DOOF'],
  snare: ['RIMSHOT', 'TIGHT', 'BREAK', 'INDUSTRIAL'],
  hat: ['RIDE', 'HAT', 'CRASH', 'CHINA'],
  perc: ['LOW TOM', 'CONGA', 'COWBELL', 'CLAVE'],
  bass: ['SINE SUB', 'SOLID', 'GROWL', 'FM CLANG'],
  pad: ['GLASS', 'WARM', 'STRINGS', 'ETHEREAL'],
  lead: ['ODD 2:3', 'SAW 1:1', 'OCT 1:2', 'FIFTH 3:2'],
  pluck: ['GLASS PLUCK', 'SAW PLUCK', 'SQUARE PLUCK', 'RAGE DONK'],
};

/**
 * A TIMBRE position saved with four sounds, on today's list: each old sound lands on
 * itself, positions between two sounds keep their share of the way. (Where a new sound now
 * sits between them the blend differs; the loader re-derives the SOUND page trims, so a
 * loaded sound still plays exactly as saved.)
 */
export function remapTimbreV18(kind: SoundKind, timbre: number): number {
  const old = ANCHORS_V18[kind];
  const anchors = MACROS[kind].anchors;
  const pos = (name: string) => anchors.findIndex((a) => a.name === name);
  const u = Math.min(1, Math.max(0, timbre)) * (old.length - 1);
  const i = Math.min(old.length - 2, Math.floor(u));
  const f = u - i;
  const a = pos(old[i]);
  const b = pos(old[i + 1]);
  return (a + (b - a) * f) / (anchors.length - 1);
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
const MIRRORED = [['sustain2', 'sustain'], ['release2', 'release']] as const;

/** FM ratio parameters: TIMBRE moves them through RATIO_STEPS. */
const RATIO_IDS = new Set(['fmratio', 'ratio2', 'ratio3']);
export const RATIO_STEPS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 4 / 3, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8];

/** PERC's note: every sound is tuned to a C (this one, C3, or octaves of it). */
export const PERC_NOTE_HZ = 130.81;

/** The nearest octave of `base` to `hz`. */
export function snapOctave(hz: number, base: number): number {
  return base * Math.pow(2, Math.round(Math.log2(hz / base)));
}

/** The nearest related ratio (on a log scale). */
export function snapRatio(r: number): number {
  let best = RATIO_STEPS[0];
  for (const s of RATIO_STEPS) if (Math.abs(Math.log(s / r)) < Math.abs(Math.log(best / r))) best = s;
  return best;
}

/**
 * The parameters TIMBRE / INTENSITY set for a type (the hidden layer under the SOUND page):
 * every anchor's values plus OSC 2's mirrored SUSTAIN / RELEASE.
 */
export function macroIds(kind: SoundKind, specs: readonly ParamSpec[]): Set<string> {
  const ids = new Set<string>();
  for (const a of MACROS[kind].anchors) for (const id in a.values) if (specs.some((p) => p.id === id)) ids.add(id);
  for (const [id, from] of MIRRORED) if (ids.has(from) && specs.some((p) => p.id === id)) ids.add(id);
  return ids;
}

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
    // FM ratios step through related ratios between sounds instead of smearing through
    // inharmonic ones (1 -> 4/3 -> 3/2 -> 2 ...).
    if (RATIO_IDS.has(id)) out[id] = snapRatio(out[id]);
    // PERC keeps one note whatever the TIMBRE: its pitches land on a C.
    if (kind === 'perc' && (id === 't_pitch' || id === 'm_pitch')) out[id] = snapOctave(out[id], PERC_NOTE_HZ);
  }
  const x = Math.min(1, Math.max(0, intensity));
  for (const e of excite) {
    const spec = specs.find((p) => p.id === e.id);
    if (!spec || out[e.id] === undefined) continue;
    if (x < 0.5) {
      if (e.floor === undefined) continue;
      const n = toNorm(spec, out[e.id]);
      out[e.id] = toValue(spec, n + (toNorm(spec, e.floor) - n) * CONVERGE * (1 - 2 * x));
    } else if (e.knee !== undefined && e.top !== undefined) {
      const t = 2 * x - 1;
      const a = toNorm(spec, out[e.id]);
      const k = Math.max(a, toNorm(spec, e.knee));
      const n = t <= 0.5 ? a + (k - a) * t * 2 : k + (Math.max(k, toNorm(spec, e.top)) - k) * (t - 0.5) * 2;
      out[e.id] = toValue(spec, n);
    } else if (e.high !== undefined) {
      out[e.id] = Math.min(spec.max, Math.max(spec.min, out[e.id] * Math.pow(e.high, 2 * x - 1)));
    }
  }
  // OSC 2's SUSTAIN / RELEASE follow OSC 1's unless the sounds set their own.
  for (const [id, from] of MIRRORED) {
    if (out[from] !== undefined && a[id] === undefined && b[id] === undefined && specs.some((p) => p.id === id)) out[id] = out[from];
  }
  return out;
}
