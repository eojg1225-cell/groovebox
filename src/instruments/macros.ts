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
   * TOP without KNEE: straight from the sound's value at the middle to TOP at 100 %.
   */
  knee?: number;
  top?: number;
}

/** How far INTENSITY 0 pulls the modulation towards its floor (the rest stays TIMBRE's). */
const CONVERGE = 0.98;

export interface MacroDef {
  anchors: readonly Anchor[];
  excite: readonly Excite[];
  /** Its own FM ratio ladder (carrier : modulator, as RATIO_LADDER) instead of the type's. */
  ladder?: readonly (readonly [number, number])[];
  /** Its own ratio steps and detours between sounds (as RATIO_SNAP / RATIO_ARC) instead of the type's. */
  snap?: Readonly<Record<string, readonly number[]>>;
  arc?: Readonly<Record<string, RatioArc>>;
}
/** A ratio's detour between two TIMBRE sounds (RATIO_ARC). */
interface RatioArc { octaves: number; cycles: number }

/** The BASS / LEAD waves (TIMBRE = SHAPE 0-4; SQUARE -> PULSE narrows the pulse width 50 % -> 12.5 %). */
const WAVES = ['SINE', 'TRIANGLE', 'SAW', 'SQUARE', 'PULSE'] as const;

/**
 * Five TIMBRE sounds that differ only in the wave (and their levels): `common` on every one, FM
 * LVL 0; `levels` per wave = OUT GAIN at INT 0 / 50 / 100 and FM COMP.
 */
function waveAnchors(common: Record<string, number>, levels: readonly (readonly [number, number, number, number])[]): Anchor[] {
  return WAVES.map((name, i) => {
    const [soft, plain, hard, fmcomp] = levels[i];
    return { name, values: { ogain: plain, fmcomp, shape: i, fm: 0, ...common }, soft: { ogain: soft }, hard: { ogain: hard } };
  });
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
        values: { ogain: 1.141, t_level: 1, t_pitch: 41, t_decay: 0.5, t_sweep: 12, t_stime: 0.06, c_level: 0, c_tone: 1500, c_reso: 0.1, c_len: 0.004, c_noise: 0.2, drive: 1.1, crush: 0 },
        soft: { ogain: 1.196, t_sweep: 4, t_stime: 0.09, drive: 1 },
        // A long, saturated sub drop.
        hard: { ogain: 0.947, t_sweep: 24, t_stime: 0.1, c_level: 0.12, c_tone: 1800, drive: 3 },
      },
      {
        // Project 1 (MTHED)'s kick: a long noisy click (the beater and skin of a real kick).
        name: 'VINTAGE',
        values: { ogain: 0.963, t_level: 0.95, t_pitch: 46, t_decay: 0.5, t_sweep: 30, t_stime: 0.044, c_level: 0.08, c_tone: 1800, c_reso: 0.2, c_len: 0.146, c_noise: 0.72, drive: 1.3, crush: 0 },
        soft: { ogain: 0.96, t_sweep: 22, t_stime: 0.05, c_level: 0.02, drive: 1 },
        // A pushed tape-machine kick: more drop, more knock.
        hard: { ogain: 0.974, t_sweep: 44, t_stime: 0.038, c_level: 0.3, c_tone: 2600, c_reso: 0.35, drive: 3.5 },
      },
      {
        name: 'PUNCH',
        values: { ogain: 0.942, t_level: 0.95, t_pitch: 52, t_decay: 0.5, t_sweep: 30, t_stime: 0.03, c_level: 0.35, c_tone: 3800, c_reso: 0.3, c_len: 0.004, c_noise: 0.5, drive: 2, crush: 0 },
        soft: { ogain: 1.025, t_sweep: 10, t_stime: 0.05, c_level: 0.08, c_tone: 2200, drive: 1.2 },
        hard: { ogain: 0.963, t_sweep: 44, t_stime: 0.03, c_level: 0.75, c_tone: 5500, c_reso: 0.5, c_noise: 0.6, drive: 6 },
      },
      {
        name: 'TECHNO',
        values: { ogain: 0.996, t_level: 0.95, t_pitch: 49, t_decay: 0.5, t_sweep: 36, t_stime: 0.022, c_level: 0.5, c_tone: 5000, c_reso: 0.4, c_len: 0.003, c_noise: 0.4, drive: 4.5, crush: 0 },
        soft: { ogain: 1.076, t_sweep: 12, t_stime: 0.04, c_level: 0.08, c_tone: 2500, c_reso: 0.15, drive: 1.3 },
        // Hard house: a tall drop you hear fall (longer than PUNCH's, shorter than PSY DOOF's),
        // a punchy tail, only lightly clipped.
        hard: { ogain: 0.683, t_pitch: 55, t_decay: 0.35, t_sweep: 72, t_stime: 0.18, c_level: 0.4, c_tone: 3200, c_reso: 0.5, c_len: 0.004, drive: 7 },
      },
      {
        // A laser zap down into a doof; the click fades out as INT rises (psy kicks have none).
        name: 'PSY DOOF',
        values: { ogain: 0.932, t_level: 1, t_pitch: 58, t_decay: 0.5, t_sweep: 80, t_stime: 0.028, c_level: 0.12, c_tone: 9500, c_reso: 0.9, c_len: 0.0015, c_noise: 0.1, drive: 16, crush: 0 },
        soft: { ogain: 0.891, t_sweep: 10, t_stime: 0.06, c_level: 0.2, c_tone: 3000, c_reso: 0.3, drive: 2 },
        // Goa laser: a 7-octave zap from about 7 kHz, slow enough to hear it fall; no click,
        // little drive.
        hard: { ogain: 0.639, t_sweep: 84, t_stime: 0.4, c_level: 0, drive: 8 },
      },
    ],
    excite: [],
  },
  snare: {
    // v74: punch. Each hit = a STICK (the click layer: an 8-12 ms knock + crack at 1.2-3.2 kHz), a body with
    // a fast, small drop (SWP TIME 12 ms) and its shell's second resonance (SHELL), and wires as
    // a band (MTL TONE's high-pass + the low-pass above it, Drum WIRE_SPAN) swelling in over
    // 2-3 ms (MTL ATK), so stick and body lead. Bodies 170-240 Hz, RIMSHOT / PICCOLO higher.
    anchors: [
      // Jazz rimshot: a woody, high knock with a little wire and a light decay; the rim's crack.
      { name: 'RIMSHOT', values: { ogain: 0.927, t_level: 0.85, t_pitch: 420, t_sweep: 4, t_stime: 0.012, t_shell: 0.3, c_level: 0.8, c_tone: 2800, c_reso: 0.6, c_len: 0.008, c_noise: 0.3, m_level: 0.45, m_attack: 0.002, m_noise: 0.6, m_pitch: 900, m_tone: 3200, m_spread: 0.5, m_mode: 0, m_fm: 0.3, drive: 1.6, crush: 0 }, soft: { ogain: 0.956 } , hard: { ogain: 0.905 } },
      // Dub piccolo: high, tight and ringing.
      { name: 'PICCOLO', values: { ogain: 1.072, t_level: 0.7, t_pitch: 330, t_sweep: 4, t_stime: 0.012, t_shell: 0.35, c_level: 0.7, c_tone: 3200, c_reso: 0.4, c_len: 0.009, c_noise: 0.4, m_level: 0.7, m_attack: 0.002, m_noise: 0.7, m_pitch: 600, m_tone: 4500, m_spread: 0.8, m_mode: 0, m_fm: 0.3, drive: 1.4, crush: 0 }, soft: { ogain: 1.095 } , hard: { ogain: 1.017 } },
      { name: 'TIGHT', values: { ogain: 1.153, t_level: 0.6, t_pitch: 220, t_sweep: 5, t_stime: 0.012, t_shell: 0.45, c_level: 0.75, c_tone: 2200, c_reso: 0.45, c_len: 0.01, c_noise: 0.45, m_level: 0.8, m_attack: 0.003, m_noise: 0.85, m_pitch: 400, m_tone: 3500, m_spread: 1, m_mode: 0, m_fm: 0.3, drive: 1.5, crush: 0 }, soft: { ogain: 1.218 } , hard: { ogain: 1.067 } },
      { name: 'BREAK', values: { ogain: 1.127, t_level: 0.6, t_pitch: 190, t_sweep: 6, t_stime: 0.012, t_shell: 0.5, c_level: 0.7, c_tone: 1600, c_reso: 0.4, c_len: 0.012, c_noise: 0.5, m_level: 0.9, m_attack: 0.003, m_noise: 0.9, m_pitch: 330, m_tone: 1800, m_spread: 1, m_mode: 0, m_fm: 0.3, drive: 2.2, crush: 0 }, soft: { ogain: 1.25 } , hard: { ogain: 0.995 } },
      { name: 'INDUSTRIAL', values: { ogain: 0.906, t_level: 0.7, t_pitch: 170, t_sweep: 9, t_stime: 0.012, t_shell: 0.4, c_level: 0.8, c_tone: 1200, c_reso: 0.5, c_len: 0.01, c_noise: 0.6, m_level: 0.9, m_attack: 0.002, m_noise: 0.45, m_pitch: 180, m_tone: 600, m_spread: 1, m_mode: 2, m_fm: 0.8, drive: 7, crush: 0.35 }, hard: { ogain: 0.959 }, soft: { ogain: 1.245 } },
    ],
    excite: [
      { id: 'drive', floor: 1, high: 2 }, { id: 'm_tone', floor: 900, high: 1.5 },
      { id: 't_sweep', floor: 1, high: 1.3 }, { id: 'm_noise', floor: 0.2, high: 1.1 }, { id: 'm_fm', floor: 0, high: 1.3 },
      { id: 'c_level', floor: 0.15, high: 1.3 },
    ],
  },
  hat: {
    // Every hit starts as its HEAD (a hat; at the far left the ride's) and morphs into the
    // tail, so short hits stay hats and the tail (and RING) decides the cymbal.
    anchors: [
      // Ride (v44): a high ride (about 1.47 kHz) of ring-mod wash, BELL (sine partials at a
      // cymbal bell's ratios) and a light RATTLE of jingles, the stick on top. INT leaves its pitch.
      // FOCUS 0.3 (v73): a more defined pitch.
      {
        name: 'RIDE',
        values: { m_pref: 1470, h_focus: 0.3,
          ogain: 0.723, m_level: 0.508, m_pitch: 1470, m_spread: 0.72, m_noise: 0.44, m_tone: 3850, m_mode: 0.82, m_fm: 0.396, m_bell: 0.288, h_rattle: 0.36,
          h_time: 0.0456, h_pitch: 1470, h_tone: 2940, h_noise: 0.212, h_mode: 0.82, h_spread: 0.72, c_level: 0.26, c_tone: 7000, c_reso: 0.5, c_len: 0.003, c_noise: 0.3, drive: 1.06, crush: 0,
        }, soft: { ogain: 0.781 },
      },
      { name: 'HAT', values: { m_pref: 420, h_focus: 0, ogain: 1.515, m_level: 0.6, m_pitch: 420, m_spread: 1, m_noise: 0.3, m_tone: 8500, m_mode: 0, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.2, c_tone: 9000, c_reso: 0.3, c_len: 0.002, c_noise: 0.6, drive: 1, crush: 0, m_bell: 0, h_rattle: 0 }, hard: { ogain: 1.402 }, soft: { ogain: 1.679 } },
      // Splash: a small, bright cymbal - higher and hissier than the crash.
      { name: 'SPLASH', values: { m_pref: 620, h_focus: 0, ogain: 1.387, m_level: 0.7, m_pitch: 620, m_spread: 1, m_noise: 0.55, m_tone: 7000, m_mode: 0.3, m_fm: 0.5, h_time: 0.03, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.25, c_tone: 7000, c_reso: 0.3, c_len: 0.003, c_noise: 0.7, drive: 1.2, crush: 0, m_bell: 0, h_rattle: 0 }, hard: { ogain: 1.276 }, soft: { ogain: 1.54 } },
      { name: 'CRASH', values: { m_pref: 480, h_focus: 0, ogain: 1.306, m_level: 0.7, m_pitch: 480, m_spread: 1, m_noise: 0.7, m_tone: 4500, m_mode: 0.5, m_fm: 0.5, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.3, c_tone: 5000, c_reso: 0.3, c_len: 0.004, c_noise: 0.8, drive: 1.5, crush: 0, m_bell: 0, h_rattle: 0 }, hard: { ogain: 1.148 }, soft: { ogain: 1.494 } },
      { name: 'CHINA', values: { m_pref: 320, h_focus: 0, ogain: 1.119, m_level: 0.75, m_pitch: 320, m_spread: 0.8, m_noise: 0.4, m_tone: 1500, m_mode: 1, m_fm: 0.6, h_time: 0.04, h_pitch: 420, h_tone: 8500, h_noise: 0.3, h_mode: 0, h_spread: 1, c_level: 0.4, c_tone: 3000, c_reso: 0.4, c_len: 0.003, c_noise: 0.5, drive: 4, crush: 0.05, m_bell: 0, h_rattle: 0 }, hard: { ogain: 1.06 }, soft: { ogain: 1.395 } },
    ],
    excite: [
      { id: 'm_tone', floor: 3500, high: 1.5 }, { id: 'drive', floor: 1, high: 2.5 },
      { id: 'm_noise', floor: 0.1, high: 1.3 }, { id: 'c_level', floor: 0.12, high: 1.5 }, { id: 'm_fm', floor: 0.1, high: 1.3 },
    ],
  },
  perc: {
    // Pitched from the sequencer: the step's note sets the pitch. Every sound sits in the
    // same octave (tone layer on the note, metal INTERVAL above it - an octave unless set
    // on the SOUND page), so switching TIMBRE never moves a line up or down. Skins, then
    // metal, then wood: neighbours blend like with like.
    anchors: [
      { name: 'LOW TOM', values: { ogain: 0.802, t_level: 0.95, t_pitch: 130.81, t_sweep: 9, t_stime: 0.08, c_level: 0.3, c_tone: 2200, c_reso: 0.3, c_len: 0.004, c_noise: 0.5, m_level: 0, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.3 }, hard: { ogain: 0.895 } },
      { name: 'CONGA', values: { ogain: 0.855, t_level: 0.9, t_pitch: 130.81, t_sweep: 4, t_stime: 0.02, c_level: 0.55, c_tone: 3500, c_reso: 0.55, c_len: 0.003, c_noise: 0.25, m_level: 0, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.2 }, hard: { ogain: 0.921 }, soft: { ogain: 0.861 } },
      // All metal: its INT 0 keeps the metal (the PERC rule fades metal out), only softer.
      { name: 'COWBELL', values: { ogain: 2.16, t_level: 0, t_pitch: 130.81, t_sweep: 0, t_stime: 0.02, c_level: 0.15, c_tone: 3000, c_reso: 0.3, c_len: 0.002, c_noise: 0.3, m_level: 0.85, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.5 }, hard: { ogain: 1.137 }, soft: { ogain: 3.155, m_level: 0.6 } },
      // Timbale: a shallow metal shell - a hard, bright stick, a short drop and the shell's
      // ring-mod clang an octave up (INTVL).
      { name: 'TIMBALE', values: { ogain: 0.882, t_level: 0.85, t_pitch: 130.81, t_sweep: 3, t_stime: 0.03, c_level: 0.6, c_tone: 4200, c_reso: 0.45, c_len: 0.003, c_noise: 0.35, m_level: 0.35, m_spread: 0.35, m_noise: 0.15, m_tone: 1200, m_mode: 0.8, m_fm: 0.3, drive: 1.4 }, hard: { ogain: 0.935 }, soft: { ogain: 0.904 } },
      { name: 'CLAVE', values: { ogain: 0.868, t_level: 0.85, t_pitch: 130.81, t_sweep: 0, t_stime: 0.01, c_level: 0.6, c_tone: 2400, c_reso: 0.92, c_len: 0.015, c_noise: 0.05, m_level: 0, m_spread: 0.2, m_noise: 0, m_tone: 700, m_mode: 0, m_fm: 0.3, drive: 1.1 }, hard: { ogain: 0.931 }, soft: { ogain: 0.905 } },
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
    // v70: TIMBRE is the wave, nothing else (WAVES); filter, envelopes, drive, glide, SUB, DETUNE
    // and UNISON the same on every wave (a starting point with room both ways on every knob),
    // FM LVL 0 (FM is the player's: FM LVL, FM RATIO). v76: INT bends the wave itself (Synth CZ:
    // a rounded wave at 0, the plain wave at 100) and nothing else: the filter, DRIVE and CRUSH
    // are the player's. The finished sounds are PRESETS (Synth.ts BASS_PRESETS): knob settings
    // on top.
    anchors: waveAnchors(
      { sub: 0, cutoff: 700, reso: 0.3, fenv: 0.4, fattack: 0.0005, fdecay: 0.3, fmattack: 0.0005, fmdecay: 0.3, drive: 1.5, glide: 0.04, decay: 0.8, sustain: 0.6, detune: 0, unison: 0 },
      // OUT GAIN (INT 0 / 50 / 100) and FM COMP per wave.
      [[0.698, 0.698, 0.698, 4.2], [0.709, 0.768, 0.834, 5.1], [0.678, 0.639, 0.747, 4.1], [0.570, 0.477, 0.475, 1.6], [0.571, 0.522, 0.663, 2.6]],
    ),
    excite: [],
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
      { name: 'WARM', values: { ogain: 1.343, cfeedback: 0, shape: 1.5, fm: 0.0763, fmratio: 1, ratio2: 1, ratio3: 0.5, feedback: 0.35, carriers: 0.85, cutoff: 1000, reso: 0.15, fattack: 0.0005, fenv: 0.1, fdecay: 1, drive: 1.1 }, hard: { ogain: 1.550 }, soft: { ogain: 1.669 } },
      // Strings: saws, stack 2 a fifth up, the filter opening slowly.
      { name: 'STRINGS', values: { ogain: 1.041, cfeedback: 0, shape: 2, fm: 0.0945, fmratio: 1, ratio2: 1.5, ratio3: 2, feedback: 0.45, carriers: 0.85, cutoff: 2600, reso: 0.1, fattack: 0.3, fenv: 0.15, fdecay: 1.5, drive: 1.1 }, hard: { ogain: 1.218 }, soft: { ogain: 0.609 } },
      // Tine: a DX7 electric-piano pad - 1 : 1 body with a 4x tine, struck by the envelope.
      { name: 'TINE', values: { ogain: 0.76, cfeedback: 0, shape: 0, fm: 0.1515, fmratio: 1, ratio2: 1, ratio3: 4, feedback: 0.15, carriers: 0.85, cutoff: 6000, reso: 0.1, fattack: 0.0005, fenv: 0.7, fdecay: 0.5, drive: 1.1 }, hard: { ogain: 0.834 }, soft: { ogain: 0.603 } },
      { name: 'GLASS', values: { ogain: 0.915, cfeedback: 0, shape: 0, fm: 0.1452, fmratio: 2, ratio2: 2, ratio3: 3, feedback: 0.1, carriers: 0.85, cutoff: 8000, reso: 0.1, fattack: 0.0005, fenv: 0.25, fdecay: 0.8, drive: 1 }, hard: { ogain: 1.057 }, soft: { ogain: 0.646 } },
      // Ethereal: a 7x modulator over the body, stack 2 a twelfth up under a 5x one - every
      // sideband lands on a harmonic: a bright, high shimmer.
      { name: 'ETHEREAL', values: { ogain: 1.522, cfeedback: 0, shape: 0.5, fm: 0.1515, fmratio: 7, ratio2: 3, ratio3: 5, feedback: 0.2, carriers: 0.85, cutoff: 9000, reso: 0.1, fattack: 0.0005, fenv: 0.3, fdecay: 1.5, drive: 1 }, hard: { ogain: 1.522 }, soft: { ogain: 1.022 } },
    ],
    excite: [
      // v78: INTENSITY = the carriers only (FM LVL is a knob again, the filter and DRIVE the
      // player's): stack 2 fades out below the middle (INT 0 = carrier 1 alone, clean) and comes
      // up to full in the top quarter; carrier 1 feeds back into itself above the middle (sines
      // turn saw-like at the top).
      { id: 'carriers', floor: 0, knee: 0.6, top: 1 },
      { id: 'cfeedback', floor: 0, knee: 0.25, top: 1 },
    ],
  },
  lead: {
    // v71: the BASS's design an octave up (WAVES; the same engine, no SUB): TIMBRE is the wave,
    // everything else the same on every wave, brighter to start; VIBRATO and BEND (what makes
    // it a lead) start at none. INT = the BASS's: the wave's bend (CZ), nothing else. The
    // finished sounds are PRESETS (Synth.ts LEAD_PRESETS).
    anchors: waveAnchors(
      { cutoff: 2500, reso: 0.2, fenv: 0.3, fattack: 0.0005, fdecay: 0.4, fmattack: 0.0005, fmdecay: 0.4, drive: 1.2, glide: 0.06, decay: 1, sustain: 0.8, detune: 0, unison: 0, vibrato: 0, vibrate: 5.5, vibdelay: 0.4, bend: 0, bendtime: 0.08 },
      [[0.542, 0.542, 0.542, 4.3], [0.553, 0.601, 0.656, 5.2], [0.541, 0.537, 0.655, 4.8], [0.462, 0.395, 0.390, 2.3], [0.464, 0.448, 0.639, 3.7]],
    ),
    excite: [],
  },
  pluck: {
    // Glassy -> a bright saw pluck -> a hollow, buzzy square pluck -> a raging FM donk.
    anchors: [
      // Steel: an FM steel-drum pluck (inharmonic 1 : 2.5).
      { name: 'STEEL', values: { cfeedback: 0, ogain: 1.136, shape: 0, fm: 0.7, fmratio: 2.5, cutoff: 5000, reso: 0.15, fenv: 0.7, fdecay: 0.2, fattack: 0.0005, drive: 1.2, attack: 0.001, decay: 0.35, sustain: 0, release: 0.08, detune: 0.1, unison: 0, dratio: 0.71 }, hard: { ogain: 1.154 }, soft: { ogain: 1.136 } },
      { name: 'GLASS PLUCK', values: { cfeedback: 0, ogain: 1.128, shape: 1, fm: 0.25, fmratio: 3, cutoff: 3500, reso: 0.2, fenv: 0.5, fdecay: 0.15, fattack: 0.0005, drive: 1.2, attack: 0.001, decay: 0.4, sustain: 0, release: 0.1, detune: 0.2, unison: 0, dratio: 0.75 }, hard: { ogain: 1.150 }, soft: { ogain: 0.993 } },
      { name: 'SAW PLUCK', values: { cfeedback: 0, ogain: 1.243, shape: 2, fm: 0.05, fmratio: 2, cutoff: 4500, reso: 0.3, fenv: 0.75, fdecay: 0.18, fattack: 0.0005, drive: 2, attack: 0.001, decay: 0.4, sustain: 0.05, release: 0.08, detune: 0.35, unison: 0.5, dratio: 0.88 }, hard: { ogain: 1.248 }, soft: { ogain: 1.080 } },
      { name: 'SQUARE PLUCK', values: { cfeedback: 0, ogain: 0.662, shape: 3, fm: 0.1, fmratio: 2, cutoff: 4000, reso: 0.35, fenv: 0.7, fdecay: 0.16, fattack: 0.0005, drive: 2.5, attack: 0.001, decay: 0.35, sustain: 0.03, release: 0.07, detune: 0.25, unison: 0.2, dratio: 0.86 }, hard: { ogain: 0.669 }, soft: { ogain: 0.776 } },
      { name: 'RAGE DONK', values: { cfeedback: 0, ogain: 0.729, shape: 0, fm: 1, fmratio: 2, cutoff: 8000, reso: 0.4, fenv: 1.2, fdecay: 0.12, fattack: 0.0005, drive: 12, attack: 0.0005, decay: 0.25, sustain: 0, release: 0.05, detune: 0.1, unison: 0, dratio: 0.72 }, hard: { ogain: 0.778 }, soft: { ogain: 0.729 } },
    ],
    // v78: INTENSITY = the carrier only, as on the PAD (FM LVL, the filter, DRIVE, UNISON and
    // DETUNE are the sound's, the knobs on top): below the middle CZ bends the wave (Synth cz 2:
    // a rounded wave at INT 0, the plain wave from INT 50), above it the FM pair's carrier feeds
    // back into itself (the PAD's CAR FB rule). INT 50 = each sound as designed.
    excite: [{ id: 'cfeedback', floor: 0, knee: 0.25, top: 1 }],
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
 * pair with its lowest partial on the note; carrier and modulator step together, never
 * blended. None today (the BASS's went in v70: FM RATIO is its own knob); a lab candidate can
 * bring one (MacroDef.ladder).
 */
const RATIO_LADDER: Partial<Record<SoundKind, readonly (readonly [number, number])[]>> = {};

/** The ladder's ratio pair at a TIMBRE position (`own`: a sound set's own ladder). */
function ladderAt(kind: SoundKind, timbre: number, own?: MacroDef['ladder']): readonly [number, number] | undefined {
  const ladder = own ?? RATIO_LADDER[kind];
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
 * keeps the musical intervals (a fourth, a fifth ...). PLUCK (v78): its FM RATIO likewise, with
 * the PAD's octave detour (RATIO_ARC).
 */
const RATIO_SNAP: Partial<Record<SoundKind, Record<string, readonly number[]>>> = {
  pad: { fmratio: HALF_STEPS, ratio3: HALF_STEPS },
  pluck: { fmratio: HALF_STEPS },
};

/**
 * Per type, ratios that take a detour between two sounds instead of blending straight across
 * (then snapped as above), so the timbre keeps changing on the way, even between sounds on
 * the same ratio: up by `octaves` x sin(cycles x pi x f) (f = 0 .. 1 between the two; 0 at
 * both sounds). PAD: the FM RATIO climbs an octave and back, RATIO 3 up then down, twice as
 * fast, so their steps fall between each other's.
 */
const RATIO_ARC: Partial<Record<SoundKind, Record<string, RatioArc>>> = {
  pad: { fmratio: { octaves: 1, cycles: 1 }, ratio3: { octaves: 1, cycles: 2 } },
  pluck: { fmratio: { octaves: 1, cycles: 1 } },
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
  if (e.top !== undefined) return toValue(spec, toNorm(spec, value) + (toNorm(spec, e.top) - toNorm(spec, value)) * (2 * x - 1));
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
    // inharmonic ones (1 -> 4/3 -> 3/2 -> 2 ...), some by way of a detour (RATIO_ARC).
    if (RATIO_IDS.has(id)) {
      const arc = (def.arc ?? RATIO_ARC[kind])?.[id];
      if (arc) out[id] *= Math.pow(2, arc.octaves * Math.sin(arc.cycles * Math.PI * f));
      out[id] = nearest((def.snap ?? RATIO_SNAP[kind])?.[id] ?? RATIO_STEPS, out[id]);
    }
  }
  const pair = ladderAt(kind, timbre, def.ladder);
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
