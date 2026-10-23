/**
 * TIMBRE and INTENSITY: two macro knobs per track type that give the groovebox its own
 * sounds. TIMBRE travels through five designed sounds ("anchors"), blending every
 * parameter between neighbours (on the parameter's own curve, so frequencies and times
 * move musically): the coarse choice of sound. INTENSITY then sets the amount of
 * modulation / atmosphere around a neutral middle (0.5 = as designed): down, FM, filter
 * envelope, sweep, noise, click, drive and width converge on a dull floor (keeping a
 * trace (2 %) of the TIMBRE's own character); up, they are excited. Never loudness. A sound
 * can instead bring its own INTENSITY 0 / 1 versions (Anchor soft / hard: the KICK's do).
 * Layers: hidden (these) < design (SOUND page knobs, stored as trims on top, see trims.ts)
 * < live (relative knobs in the engine).
 *
 * Pure functions: the UI computes the sound and sends the resulting parameters.
 */
import type { SoundKind } from '../engine/project';
import { toNorm, toValue, type ParamSpec } from '../engine/params';

export interface Anchor {
  name: string;
  /** The sound at INTENSITY 0.5. */
  values: Record<string, number>;
  /**
   * The sound's own INTENSITY 0 (soft) and 1 (extreme) versions of some of its values: a
   * parameter given one moves values -> end on its own curve over that half of INTENSITY
   * (the type's Excite rules leave it alone there). Every id here is also in `values`.
   */
  soft?: Record<string, number>;
  hard?: Record<string, number>;
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
const CONVERGE = 0.98;

export interface MacroDef {
  anchors: readonly Anchor[];
  excite: readonly Excite[];
}

export const MACROS: Record<SoundKind, MacroDef> = {
  kick: {
    // Each sound runs from its own soft, slow thump (INT 0) to its own extreme (INT 1); INT
    // moves the sweep depth and time too (SWEEP / SWP TIME sit on FUNC as fine tuning).
    // BD DEC is TIMBRE's (0.5 s on every sound; the knob is a trim on top), so a sound's
    // extreme can be short.
    anchors: [
      {
        // Dub / jungle: a tuned 808 boom - pure sine, slow drop, no click (RING makes it sing).
        name: '808 BOOM',
        values: { ogain: 1.229, t_level: 1, t_pitch: 41, t_decay: 0.5, t_sweep: 12, t_stime: 0.06, c_level: 0, c_tone: 1500, c_reso: 0.1, c_len: 0.004, c_noise: 0.2, drive: 1.1, crush: 0 },
        soft: { ogain: 1.277, t_sweep: 4, t_stime: 0.09, drive: 1 },
        // A long, saturated sub drop.
        hard: { ogain: 0.984, t_sweep: 24, t_stime: 0.1, c_level: 0.12, c_tone: 1800, drive: 3 },
      },
      {
        name: 'VINTAGE',
        values: { ogain: 1.157, t_level: 0.95, t_pitch: 44, t_decay: 0.5, t_sweep: 14, t_stime: 0.07, c_level: 0.08, c_tone: 1800, c_reso: 0.2, c_len: 0.006, c_noise: 0.3, drive: 1.3, crush: 0 },
        soft: { ogain: 1.244, t_sweep: 6, t_stime: 0.08, c_level: 0.02, drive: 1 },
        // A pushed tape-machine kick: more drop, more knock.
        hard: { ogain: 0.995, t_sweep: 28, t_stime: 0.06, c_level: 0.3, c_tone: 2600, c_reso: 0.35, drive: 3.5 },
      },
      {
        name: 'PUNCH',
        values: { ogain: 0.991, t_level: 0.95, t_pitch: 52, t_decay: 0.5, t_sweep: 30, t_stime: 0.03, c_level: 0.35, c_tone: 3800, c_reso: 0.3, c_len: 0.004, c_noise: 0.5, drive: 2, crush: 0 },
        soft: { ogain: 1.096, t_sweep: 10, t_stime: 0.05, c_level: 0.08, c_tone: 2200, drive: 1.2 },
        hard: { ogain: 0.887, t_sweep: 44, t_stime: 0.03, c_level: 0.75, c_tone: 5500, c_reso: 0.5, c_noise: 0.6, drive: 6 },
      },
      {
        name: 'TECHNO',
        values: { ogain: 0.955, t_level: 0.95, t_pitch: 49, t_decay: 0.5, t_sweep: 36, t_stime: 0.022, c_level: 0.5, c_tone: 5000, c_reso: 0.4, c_len: 0.003, c_noise: 0.4, drive: 4.5, crush: 0 },
        soft: { ogain: 1.129, t_sweep: 12, t_stime: 0.04, c_level: 0.08, c_tone: 2500, c_reso: 0.15, drive: 1.3 },
        // Hardstyle / gabber: a tight drop through the mids, released just after it (so it
        // reads higher but keeps its low end), clipped into a square.
        hard: { ogain: 1.16, t_pitch: 58, t_decay: 0.2, t_sweep: 30, t_stime: 0.008, c_level: 0.55, c_tone: 3200, c_reso: 0.6, c_len: 0.004, drive: 140 },
      },
      {
        // Over the top on purpose: a 6-7 octave laser zap down into a square-driven doof.
        name: 'PSY DOOF',
        values: { ogain: 0.743, t_level: 1, t_pitch: 58, t_decay: 0.5, t_sweep: 80, t_stime: 0.028, c_level: 1, c_tone: 9500, c_reso: 0.9, c_len: 0.0015, c_noise: 0.1, drive: 45, crush: 0 },
        soft: { ogain: 0.924, t_sweep: 10, t_stime: 0.06, c_level: 0.1, c_tone: 3000, c_reso: 0.3, drive: 2 },
        // Goa laser: a 10-octave zap (held at the top of the hearing range), slow enough to
        // hear it fall.
        hard: { ogain: 0.668, t_sweep: 120, t_stime: 0.16, c_level: 1, c_tone: 12000, c_reso: 0.95, drive: 60 },
      },
    ],
    excite: [],
  },
  snare: {
    anchors: [
      // Jazz rimshot: a woody, high knock with a little wire and a light decay.
      { name: 'RIMSHOT', values: { ogain: 1.029, t_level: 0.85, t_pitch: 420, t_sweep: 5, m_level: 0.45, m_noise: 0.6, m_pitch: 900, m_tone: 3200, m_spread: 0.5, m_mode: 0, m_fm: 0.3, drive: 1.6, crush: 0 } },
      // Dub piccolo: high, tight and ringing.
      { name: 'PICCOLO', values: { ogain: 1.16, t_level: 0.7, t_pitch: 330, t_sweep: 4, m_level: 0.7, m_noise: 0.7, m_pitch: 600, m_tone: 4500, m_spread: 0.8, m_mode: 0, m_fm: 0.3, drive: 1.4, crush: 0 } },
      { name: 'TIGHT', values: { ogain: 1.135, t_level: 0.6, t_pitch: 240, t_sweep: 6, m_level: 0.8, m_noise: 0.85, m_pitch: 400, m_tone: 3500, m_spread: 1, m_mode: 0, m_fm: 0.3, drive: 1.5, crush: 0 } },
      { name: 'BREAK', values: { ogain: 0.981, t_level: 0.6, t_pitch: 195, t_sweep: 10, m_level: 0.9, m_noise: 0.9, m_pitch: 330, m_tone: 1800, m_spread: 1, m_mode: 0, m_fm: 0.3, drive: 2.2, crush: 0 } },
      { name: 'INDUSTRIAL', values: { ogain: 0.753, t_level: 0.7, t_pitch: 150, t_sweep: 18, m_level: 0.9, m_noise: 0.45, m_pitch: 180, m_tone: 600, m_spread: 1, m_mode: 2, m_fm: 0.8, drive: 7, crush: 0.35 } },
    ],
    excite: [
      { id: 'drive', floor: 1, high: 2 }, { id: 'm_tone', floor: 900, high: 1.5 },
      { id: 't_sweep', floor: 1, high: 1.3 }, { id: 'm_noise', floor: 0.2, high: 1.1 }, { id: 'm_fm', floor: 0, high: 1.3 },
    ],
  },
  hat: {
    // Every hit starts as its HEAD (a hat; at the far left the ride's) and morphs into the
    // tail, so short hits stay hats and the tail (and RING) decides the cymbal.
    anchors: [
      // Ride (v44): a high ride (about 1.47 kHz) of ring-mod wash, BELL (sine partials at a
      // cymbal bell's ratios) and a light RATTLE of jingles, the stick on top. INT leaves its pitch.
      {
        name: 'RIDE',
        values: {
          ogain: 0.775, m_level: 0.508, m_pitch: 1470, m_spread: 0.72, m_noise: 0.44, m_tone: 3850, m_mode: 0.82, m_fm: 0.396, m_bell: 0.288, h_rattle: 0.36,
          h_time: 0.0456, h_pitch: 1470, h_tone: 2940, h_noise: 0.212, h_mode: 0.82, h_spread: 0.72, c_level: 0.26, c_tone: 7000, c_reso: 0.5, c_len: 0.003, c_noise: 0.3, drive: 1.06, crush: 0,
        },
      },
      { name: 'HAT', values: { ogain: 1.574, m_level: 0.6, m_pitch: 420, m_spread: 1, m_noise: 0.3, m_tone: 8500, m_mode: 0, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.2, c_tone: 9000, c_reso: 0.3, c_len: 0.002, c_noise: 0.6, drive: 1, crush: 0, m_bell: 0, h_rattle: 0 } },
      // Splash: a small, bright cymbal - higher and hissier than the crash.
      { name: 'SPLASH', values: { ogain: 1.306, m_level: 0.7, m_pitch: 620, m_spread: 1, m_noise: 0.55, m_tone: 7000, m_mode: 0.3, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.25, c_tone: 7000, c_reso: 0.3, c_len: 0.003, c_noise: 0.7, drive: 1.2, crush: 0, m_bell: 0, h_rattle: 0 } },
      { name: 'CRASH', values: { ogain: 1.186, m_level: 0.7, m_pitch: 480, m_spread: 1, m_noise: 0.7, m_tone: 4500, m_mode: 0.5, m_fm: 0.5, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.3, c_tone: 5000, c_reso: 0.3, c_len: 0.004, c_noise: 0.8, drive: 1.5, crush: 0, m_bell: 0, h_rattle: 0 } },
      { name: 'CHINA', values: { ogain: 0.968, m_level: 0.75, m_pitch: 320, m_spread: 0.8, m_noise: 0.4, m_tone: 1500, m_mode: 1, m_fm: 0.6, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.4, c_tone: 3000, c_reso: 0.4, c_len: 0.003, c_noise: 0.5, drive: 4, crush: 0.05, m_bell: 0, h_rattle: 0 } },
    ],
    excite: [
      { id: 'm_tone', floor: 3500, high: 1.5 }, { id: 'drive', floor: 1, high: 2.5 },
      { id: 'm_noise', floor: 0.1, high: 1.3 }, { id: 'c_level', floor: 0.12, high: 1.5 }, { id: 'm_fm', floor: 0.1, high: 1.3 },
    ],
  },
  perc: {
    // Pitched from the sequencer: the step's note sets the pitch. Every sound sits in the
    // same octave (tone layer on the note, metal INTERVAL above it - an octave unless set
    // on the SOUND page), so switching TIMBRE never moves a line up or down.
    anchors: [
      { name: 'LOW TOM', values: { ogain: 0.747, t_level: 0.95, t_pitch: 130.81, t_sweep: 9, t_stime: 0.08, c_level: 0.3, c_tone: 2200, c_reso: 0.3, c_len: 0.004, c_noise: 0.5, m_level: 0, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.3 } },
      // Timbale: a shallow metal shell - a hard, bright stick, a short drop and the shell's
      // ring-mod clang an octave up (INTVL).
      { name: 'TIMBALE', values: { ogain: 0.821, t_level: 0.85, t_pitch: 130.81, t_sweep: 3, t_stime: 0.03, c_level: 0.6, c_tone: 4200, c_reso: 0.45, c_len: 0.003, c_noise: 0.35, m_level: 0.35, m_spread: 0.35, m_noise: 0.15, m_tone: 1200, m_mode: 0.8, m_fm: 0.3, drive: 1.4 } },
      { name: 'CONGA', values: { ogain: 0.797, t_level: 0.9, t_pitch: 130.81, t_sweep: 4, t_stime: 0.02, c_level: 0.55, c_tone: 3500, c_reso: 0.55, c_len: 0.003, c_noise: 0.25, m_level: 0, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.2 } },
      { name: 'COWBELL', values: { ogain: 2.824, t_level: 0, t_pitch: 130.81, t_sweep: 0, t_stime: 0.02, c_level: 0.15, c_tone: 3000, c_reso: 0.3, c_len: 0.002, c_noise: 0.3, m_level: 0.85, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.5 } },
      { name: 'CLAVE', values: { ogain: 0.822, t_level: 0.85, t_pitch: 130.81, t_sweep: 0, t_stime: 0.01, c_level: 0.6, c_tone: 2400, c_reso: 0.92, c_len: 0.015, c_noise: 0.05, m_level: 0, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.1 } },
    ],
    excite: [
      // The top quarter turns any of them into a warped clang: the metal layer comes in,
      // goes ring-mod -> FM and spreads, the sweep (up to 2 octaves) and the click resonance
      // run wild, drive (up to 6x).
      { id: 't_sweep', floor: 1, knee: 12, top: 24 }, { id: 'drive', floor: 1, knee: 2.5, top: 6 },
      { id: 'c_reso', floor: 0.1, knee: 0.6, top: 0.95 }, { id: 'c_level', floor: 0.03, high: 1.5 },
      { id: 'c_tone', floor: 700, high: 1.4 }, { id: 'c_noise', floor: 0.05, high: 1.2 },
      { id: 'm_level', floor: 0, knee: 0.15, top: 0.8 }, { id: 'm_mode', knee: 0.5, top: 1.7 },
      { id: 'm_fm', floor: 0, knee: 0.6, top: 3.5 }, { id: 'm_spread', knee: 0.5, top: 2.2 },
    ],
  },
  bass: {
    // v40: SINE SUB, GROWL, ACID, SOLID, FM 2:3, each with a little FM on its step of the ratio
    // ladder (RATIO_LADDER: 1 : 2, 2 : 3, 3 : 2); INTENSITY leaves FM LVL alone (the FM LVL knob
    // goes from none to full on every sound).
    anchors: [
      { name: 'SINE SUB', values: { ogain: 0.721, shape: 0, fm: 0.12, fmratio: 2, cratio: 1, sub: 0, cutoff: 3000, reso: 0, fenv: 0, fattack: 0.0005, fdecay: 0.3, drive: 1, glide: 0.03, decay: 0.7, sustain: 0.8, detune: 0 } },
      { name: 'GROWL', values: { ogain: 0.931, shape: 2, fm: 0.15, fmratio: 2, cratio: 1, sub: 0.5, cutoff: 650, reso: 0.3, fenv: 0.2, fattack: 0.0005, fdecay: 0.5, drive: 3, glide: 0.04, decay: 1, sustain: 0.9, detune: 0.75 } },
      // 303: square through a resonant filter with a short, snappy envelope (accents and slides).
      { name: 'ACID', values: { ogain: 0.586, shape: 3, fm: 0.15, fmratio: 3, cratio: 2, sub: 0, cutoff: 350, reso: 0.75, fenv: 0.9, fattack: 0.0005, fdecay: 0.18, drive: 1.8, glide: 0.06, decay: 0.35, sustain: 0.6, detune: 0 } },
      { name: 'SOLID', values: { ogain: 2.143, shape: 2.3, fm: 0.15, fmratio: 2, cratio: 3, sub: 0.4, cutoff: 420, reso: 0.45, fenv: 0.5, fattack: 0.0005, fdecay: 0.22, drive: 1.6, glide: 0.02, decay: 0.5, sustain: 0.45, detune: 0.15 } },
      // FM 2 : 3 (v39, was FM CLANG): carrier 3 x, modulator 2 x the note - the 2 : 3 partials
      // with the lowest on the note, so the pitch holds at every FM LEVEL / INTENSITY.
      { name: 'FM 2:3', values: { ogain: 1.187, shape: 0, fm: 0.6, fmratio: 2, cratio: 3, sub: 0.15, cutoff: 2600, reso: 0.1, fenv: 0.5, fattack: 0.0005, fdecay: 0.16, drive: 1.4, glide: 0.03, decay: 0.45, sustain: 0.4, detune: 0 } },
    ],
    excite: [
      { id: 'cutoff', floor: 150, high: 2 }, { id: 'fenv', floor: 0.05, high: 1.4 }, { id: 'drive', floor: 1, high: 2 },
      { id: 'reso', floor: 0.05, high: 1.2 }, { id: 'detune', floor: 0.05, high: 1.3 },
    ],
  },
  pad: {
    // PAD: 2 STACKS (Synth algo 2), two modulator -> carrier pairs, polyphonic with chords.
    // Stack 1 = carrier 1 (SHAPE's wave) under a modulator at FM RATIO with FEEDBACK; stack 2
    // = a carrier at RATIO 2 under a modulator at RATIO 3, mixed in by CARRIERS
    // (0.85 on every sound, no knob). Soft ->
    // bell-like (WARM, STRINGS, TINE, GLASS, ETHEREAL). The ratios switch as TIMBRE moves
    // (see RATIO_SNAP: the modulators in whole and half steps, stack 2's carrier through
    // musical intervals), so every stop on the way stays in tune with a chord.
    anchors: [
      // Warm: a soft wave with an octave-down modulator on stack 2 (a low growl under it).
      { name: 'WARM', values: { ogain: 1.315, cfeedback: 0, shape: 1.5, fm: 0.4, fmratio: 1, ratio2: 1, ratio3: 0.5, feedback: 0.35, carriers: 0.85, cutoff: 1000, reso: 0.15, fattack: 0.0005, fenv: 0.1, fdecay: 1, drive: 1.1 } },
      // Strings: saws, stack 2 a fifth up, the filter opening slowly.
      { name: 'STRINGS', values: { ogain: 1.017, cfeedback: 0, shape: 2, fm: 0.45, fmratio: 1, ratio2: 1.5, ratio3: 2, feedback: 0.45, carriers: 0.85, cutoff: 2600, reso: 0.1, fattack: 0.3, fenv: 0.15, fdecay: 1.5, drive: 1.1 } },
      // Tine: a DX7 electric-piano pad - 1 : 1 body with a 4x tine, struck by the envelope.
      { name: 'TINE', values: { ogain: 0.745, cfeedback: 0, shape: 0, fm: 0.62, fmratio: 1, ratio2: 1, ratio3: 4, feedback: 0.15, carriers: 0.85, cutoff: 6000, reso: 0.1, fattack: 0.0005, fenv: 0.7, fdecay: 0.5, drive: 1.1 } },
      { name: 'GLASS', values: { ogain: 0.962, cfeedback: 0, shape: 0, fm: 0.55, fmratio: 2, ratio2: 2, ratio3: 3, feedback: 0.1, carriers: 0.85, cutoff: 8000, reso: 0.1, fattack: 0.0005, fenv: 0.25, fdecay: 0.8, drive: 1 } },
      // Ethereal: a 7x modulator over the body, stack 2 a twelfth up under a 5x one - every
      // sideband lands on a harmonic: a bright, high shimmer.
      { name: 'ETHEREAL', values: { ogain: 1.551, cfeedback: 0, shape: 0.5, fm: 0.6, fmratio: 7, ratio2: 3, ratio3: 5, feedback: 0.2, carriers: 0.85, cutoff: 9000, reso: 0.1, fattack: 0.0005, fenv: 0.3, fdecay: 1.5, drive: 1 } },
    ],
    excite: [
      // INTENSITY = how much of the carriers: stack 2 fades out below the middle (INT 0 =
      // carrier 1 alone, clean) and comes up to full in the top quarter. It leaves the
      // modulation alone: FM LVL and FEEDBACK set it.
      { id: 'carriers', floor: 0, knee: 0.6, top: 1 },
      { id: 'fenv', floor: 0, high: 1.3 }, { id: 'reso', floor: 0.05, high: 1.2 },
      { id: 'cutoff', floor: 400, high: 1.4 }, { id: 'drive', floor: 1, high: 1.5 },
      // Carrier 1 feeds back into itself above the middle: sines turn saw-like at the top.
      { id: 'cfeedback', floor: 0, knee: 0.25, top: 1 },
    ],
  },
  lead: {
    // DX7-style: one feedback modulator into three carriers at related ratios (carrier 1 :
    // carrier 2 : carrier 3, modulator). ODD (the most chilled) first. With INTENSITY down
    // carrier 1 alone plays a simple wave - one clear note; carriers 2 / 3 come in as it
    // rises, in full in the top quarter. INTENSITY leaves the modulation alone: FM LVL,
    // FEEDBACK and the FM envelope set it (as on the BASS and PAD).
    anchors: [
      { name: 'ODD 2:3', values: { ogain: 1.136, shape: 0.7, fm: 0.56, fmratio: 1.5, ratio2: 1.5, ratio3: 2.5, feedback: 0.3, carriers: 0.3, glide: 0.06, cutoff: 5000, reso: 0.15, fenv: 0.45, fdecay: 0.5, drive: 1.2 } },
      // Organ: drawbar-style carriers 1 : 2 : 3 on soft waves, full sustain - a bass or a lead.
      { name: 'ORGAN', values: { ogain: 1.35, shape: 0.6, fm: 0.4, fmratio: 1, ratio2: 2, ratio3: 3, feedback: 0.15, carriers: 0.6, glide: 0.06, cutoff: 6000, reso: 0.05, fenv: 0.1, fdecay: 0.1, drive: 1.2 } },
      { name: 'SAW 1:1', values: { ogain: 0.809, shape: 2, fm: 0.52, fmratio: 1, ratio2: 1, ratio3: 1, feedback: 0.5, carriers: 0.35, glide: 0.06, cutoff: 3200, reso: 0.15, fenv: 0.3, fdecay: 0.4, drive: 1.3 } },
      { name: 'OCT 1:2', values: { ogain: 0.594, shape: 3, fm: 0.54, fmratio: 1, ratio2: 2, ratio3: 0.5, feedback: 0.4, carriers: 0.35, glide: 0.06, cutoff: 2600, reso: 0.25, fenv: 0.35, fdecay: 0.35, drive: 1.4 } },
      { name: 'FIFTH 3:2', values: { ogain: 1.358, shape: 1.5, fm: 0.55, fmratio: 1, ratio2: 1.5, ratio3: 2, feedback: 0.35, carriers: 0.35, glide: 0.06, cutoff: 3800, reso: 0.2, fenv: 0.4, fdecay: 0.4, drive: 1.3 } },
    ],
    excite: [
      { id: 'carriers', floor: 0, knee: 0.6, top: 1 },
      { id: 'cutoff', floor: 700, high: 1.4 }, { id: 'reso', floor: 0.05, high: 1.15 }, { id: 'drive', floor: 1, high: 1.5 },
      { id: 'fenv', floor: 0.05, high: 1.3 },
    ],
  },
  pluck: {
    // Glassy -> a bright saw pluck -> a hollow, buzzy square pluck -> a raging FM donk.
    anchors: [
      // Steel: an FM steel-drum pluck (inharmonic 1 : 2.5).
      { name: 'STEEL', values: { ogain: 1.176, shape: 0, fm: 0.7, fmratio: 2.5, cutoff: 5000, reso: 0.15, fenv: 0.7, fdecay: 0.2, fattack: 0.0005, drive: 1.2, attack: 0.001, decay: 0.35, sustain: 0, release: 0.08, detune: 0.1, unison: 0, dratio: 0.71 } },
      { name: 'GLASS PLUCK', values: { ogain: 1.431, shape: 1, fm: 0.25, fmratio: 3, cutoff: 3500, reso: 0.2, fenv: 0.5, fdecay: 0.15, fattack: 0.0005, drive: 1.2, attack: 0.001, decay: 0.4, sustain: 0, release: 0.1, detune: 0.2, unison: 0, dratio: 0.75 } },
      { name: 'SAW PLUCK', values: { ogain: 1.233, shape: 2, fm: 0.05, fmratio: 2, cutoff: 4500, reso: 0.3, fenv: 0.75, fdecay: 0.18, fattack: 0.0005, drive: 2, attack: 0.001, decay: 0.4, sustain: 0.05, release: 0.08, detune: 0.35, unison: 0.5, dratio: 0.88 } },
      { name: 'SQUARE PLUCK', values: { ogain: 0.63, shape: 3, fm: 0.1, fmratio: 2, cutoff: 4000, reso: 0.35, fenv: 0.7, fdecay: 0.16, fattack: 0.0005, drive: 2.5, attack: 0.001, decay: 0.35, sustain: 0.03, release: 0.07, detune: 0.25, unison: 0.2, dratio: 0.86 } },
      { name: 'RAGE DONK', values: { ogain: 0.766, shape: 0, fm: 1, fmratio: 2, cutoff: 8000, reso: 0.4, fenv: 1.2, fdecay: 0.12, fattack: 0.0005, drive: 12, attack: 0.0005, decay: 0.25, sustain: 0, release: 0.05, detune: 0.1, unison: 0, dratio: 0.72 } },
    ],
    excite: [
      { id: 'fm', floor: 0, knee: 0.6, top: 1 }, { id: 'fenv', floor: 0.1, high: 1.3 }, { id: 'reso', floor: 0.05, high: 1.2 },
      { id: 'cutoff', floor: 500, high: 1.4 }, { id: 'drive', floor: 1, high: 1.6 },
      { id: 'unison', floor: 0, high: 1.1 }, { id: 'detune', floor: 0.05, high: 1.1 },
    ],
  },
};

// Each synth sound's FM envelope (FM ATK / FM DEC) starts where its filter envelope is: the FM
// followed the filter envelope until it got its own (v41), so every sound plays as before.
for (const kind of ['bass', 'pad', 'lead', 'pluck'] as const) {
  for (const a of MACROS[kind].anchors) {
    if (a.values.fattack !== undefined) a.values.fmattack ??= a.values.fattack;
    if (a.values.fdecay !== undefined) a.values.fmdecay ??= a.values.fdecay;
  }
}

// BASS and PLUCK sounds each bring their whole character: amp envelope (one for both
// oscillators; PLUCK's OSC 2 decays by its own ratio) and width (DETUNE, UNISON) morph
// with TIMBRE, and SOUND page changes are trims on top.
// PAD and LEAD keep the type's own envelope and width, like the drums' tails.

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
const MIRRORED = [['sustain2', 'sustain'], ['release2', 'release'], ['fm2', 'fm']] as const;

/** FM ratio parameters: TIMBRE moves them through RATIO_STEPS. */
const RATIO_IDS = new Set(['fmratio', 'ratio2', 'ratio3']);
/**
 * FM ratio ladders (carrier : modulator) across the whole TIMBRE knob in even stretches, each
 * pair with its lowest partial on the note (and none at 0 Hz): BASS 1 : 2 (odd harmonics),
 * 2 : 3, 3 : 2 (odd harmonics, brighter). Carrier and modulator step together, never blended.
 */
const RATIO_LADDER: Partial<Record<SoundKind, readonly (readonly [number, number])[]>> = {
  bass: [[1, 2], [2, 3], [3, 2]],
};

/** The ladder's ratio pair at a TIMBRE position. */
function ladderAt(kind: SoundKind, timbre: number): readonly [number, number] | undefined {
  const ladder = RATIO_LADDER[kind];
  if (!ladder) return undefined;
  return ladder[Math.min(ladder.length - 1, Math.floor(Math.min(1, Math.max(0, timbre)) * ladder.length))];
}
export const RATIO_STEPS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 4 / 3, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8];
/**
 * Whole and half steps only: a modulator at a third or a quarter of the note puts its
 * sidebands between the harmonics (out of tune under a chord); halves only add the octave
 * below.
 */
export const HALF_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8];

function nearest(steps: readonly number[], r: number): number {
  let best = steps[0];
  for (const s of steps) if (Math.abs(Math.log(s / r)) < Math.abs(Math.log(best / r))) best = s;
  return best;
}

/**
 * Per type, the steps a ratio moves through (default RATIO_STEPS). PAD: its modulators (FM
 * RATIO, RATIO 3) in whole and half steps; stack 2's carrier (RATIO 2) is a note heard, so it
 * keeps the musical intervals (a fourth, a fifth ...).
 */
const RATIO_SNAP: Partial<Record<SoundKind, Record<string, readonly number[]>>> = {
  pad: { fmratio: HALF_STEPS, ratio3: HALF_STEPS },
};

/**
 * The parameters TIMBRE / INTENSITY set for a type (the hidden layer under the SOUND page):
 * every anchor's values plus the mirrored OSC 2 SUSTAIN / RELEASE and FM LVL2.
 */
export function macroIds(kind: SoundKind, specs: readonly ParamSpec[]): Set<string> {
  const ids = new Set<string>();
  for (const a of MACROS[kind].anchors) for (const id in a.values) if (specs.some((p) => p.id === id)) ids.add(id);
  for (const [id, from] of MIRRORED) if (ids.has(from) && specs.some((p) => p.id === id)) ids.add(id);
  return ids;
}

/** A parameter's value after INTENSITY x (0..1) by its Excite rule. */
function excited(e: Excite, spec: ParamSpec, value: number, x: number): number {
  if (x < 0.5) {
    if (e.floor === undefined) return value;
    const n = toNorm(spec, value);
    return toValue(spec, n + (toNorm(spec, e.floor) - n) * CONVERGE * (1 - 2 * x));
  }
  if (e.knee !== undefined && e.top !== undefined) {
    const t = 2 * x - 1;
    const a = toNorm(spec, value);
    const k = Math.max(a, toNorm(spec, e.knee));
    return toValue(spec, t <= 0.5 ? a + (k - a) * t * 2 : k + (Math.max(k, toNorm(spec, e.top)) - k) * (t - 0.5) * 2);
  }
  if (e.high !== undefined) return Math.min(spec.max, Math.max(spec.min, value * Math.pow(e.high, 2 * x - 1)));
  return value;
}

export function macroSound(kind: SoundKind, timbre: number, intensity: number, specs: readonly ParamSpec[]): Record<string, number> {
  return macroSoundOf(MACROS[kind], kind, timbre, intensity, specs);
}

/** A sound's own value at INTENSITY x towards its soft / hard end (undefined = none that side). */
function ownEnd(a: Anchor, id: string, spec: ParamSpec, x: number): number | undefined {
  const end = x < 0.5 ? a.soft?.[id] : a.hard?.[id];
  if (end === undefined) return undefined;
  const mid = a.values[id] ?? spec.defaultValue;
  const f = x < 0.5 ? 1 - 2 * x : 2 * x - 1;
  return toValue(spec, toNorm(spec, mid) + (toNorm(spec, end) - toNorm(spec, mid)) * f);
}

/** macroSound for any set of sounds and rules (the sound lab tries candidates with it). */
export function macroSoundOf(def: MacroDef, kind: SoundKind, timbre: number, intensity: number, specs: readonly ParamSpec[]): Record<string, number> {
  const { anchors, excite } = def;
  const t = Math.min(1, Math.max(0, timbre)) * (anchors.length - 1);
  const i0 = Math.min(anchors.length - 2, Math.floor(t));
  const f = t - i0;
  const a = anchors[i0].values;
  const b = anchors[i0 + 1].values;
  const x = Math.min(1, Math.max(0, intensity));
  const out: Record<string, number> = {};
  /** Parameters a sound's own soft / hard end sets here (no Excite rule on them). */
  const own = new Set<string>();
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const spec = specs.find((p) => p.id === id);
    if (!spec) continue;
    const ea = ownEnd(anchors[i0], id, spec, x);
    const eb = ownEnd(anchors[i0 + 1], id, spec, x);
    if (ea !== undefined || eb !== undefined) own.add(id);
    const va = ea ?? a[id] ?? b[id];
    const vb = eb ?? b[id] ?? a[id];
    // Blend on the parameter's own curve (log for frequencies and times).
    out[id] = toValue(spec, toNorm(spec, va) + (toNorm(spec, vb) - toNorm(spec, va)) * f);
    // FM ratios step through related ratios between sounds instead of smearing through
    // inharmonic ones (1 -> 4/3 -> 3/2 -> 2 ...).
    if (RATIO_IDS.has(id)) out[id] = nearest(RATIO_SNAP[kind]?.[id] ?? RATIO_STEPS, out[id]);
  }
  const pair = ladderAt(kind, timbre);
  if (pair) {
    out.cratio = pair[0];
    out.fmratio = pair[1];
  }
  for (const e of excite) {
    const spec = specs.find((p) => p.id === e.id);
    if (spec && out[e.id] !== undefined && !own.has(e.id)) out[e.id] = excited(e, spec, out[e.id], x);
  }
  // OSC 2's SUSTAIN / RELEASE and FM LVL2 follow OSC 1's / FM LVL unless the sounds set their own.
  for (const [id, from] of MIRRORED) {
    if (out[from] !== undefined && a[id] === undefined && b[id] === undefined && specs.some((p) => p.id === id)) out[id] = out[from];
  }
  return out;
}
