/**
 * The drum types' parameters (every knob's range and default, per type), their SOUND page
 * elements, ROLL RATE and the presets: the panel's tables. The sound itself is the Rust
 * engine's (native/src/instruments/drum.rs), which gets these values by the protocol.
 *
 * Each type uses two layers (its "elements"): KICK = TONE + CLICK, SNARE = TONE + METAL,
 * HAT = CLICK + METAL, PERC = TONE + CLICK (+ METAL for bells), pitched from the sequencer.
 */
import { choice, type ParamSpec } from '../engine/params';
import { INTENSITY, OCTAVE, TIMBRE, midFreq, type Preset } from './macroParams';
import { MACROS } from './macros';

const T_WAVES = ['SINE', 'TRI', 'SAW', 'SQR'];
const ATTACK = { min: 0.0005, max: 2, defaultValue: 0.0005, unit: 'S', curve: 'exp', decimals: 4 } as const;

/**
 * ROLL RATE as a note value at the tempo, whatever the pattern's speed (`hits` per 16th):
 * 1/4 ... 1/64 (id 'rolldiv'; saves before v57 load at 1/16: rollRateV57).
 */
export const ROLL_DIVS = [
  { name: '1/4', hits: 1 / 4 }, { name: '1/8.', hits: 1 / 3 }, { name: '1/8', hits: 1 / 2 },
  { name: '1/16', hits: 1 }, { name: '1/32', hits: 2 }, { name: '1/32T', hits: 3 }, { name: '1/64', hits: 4 },
] as const;
/** ROLL RATE 1/16. */
export const DEFAULT_ROLL_RATE = 3;

/** Every drum parameter; each drum type exposes a subset with its own defaults. */
const ALL: Record<string, ParamSpec> = Object.fromEntries(([
  TIMBRE,
  INTENSITY,
  { id: 't_level', name: 'BD LEVEL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 't_pitch', name: 'BD PITCH', min: 10, max: 5000, defaultValue: 50, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 't_sweep', name: 'SWEEP', min: 0, max: 120, defaultValue: 24, unit: 'ST', curve: 'linear', decimals: 0 },
  { id: 't_stime', name: 'SWP TIME', min: 0.001, max: 2, defaultValue: 0.04, unit: 'S', curve: 'exp', decimals: 3 },
  { id: 't_attack', name: 'BD ATK', ...ATTACK },
  { id: 't_decay', name: 'BD DEC', min: 0.005, max: 20, defaultValue: 0.45, unit: 'S', curve: 'exp' },
  choice('t_wave', 'BD WAVE', T_WAVES),
  { id: 'c_level', name: 'CLK LEVEL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'c_tone', name: 'CLK PITCH', min: 100, max: 20000, defaultValue: 4000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'c_attack', name: 'CLK ATK', ...ATTACK },
  { id: 'c_len', name: 'CLK DEC', min: 0.0002, max: 0.5, defaultValue: 0.004, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'c_reso', name: 'CLK RESO', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'c_noise', name: 'CLK NOISE', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
  { id: 'm_level', name: 'MTL LEVEL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'm_pitch', name: 'MTL PITCH', min: 20, max: 12000, defaultValue: 400, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'm_spread', name: 'SPREAD', min: 0, max: 3, defaultValue: 1, unit: '', curve: 'linear' },
  { id: 'm_noise', name: 'MTL NOISE', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'm_tone', name: 'MTL TONE', min: 30, max: 20000, defaultValue: 6000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'm_attack', name: 'MTL ATK', ...ATTACK },
  { id: 'm_decay', name: 'MTL DEC', min: 0.005, max: 20, defaultValue: 0.2, unit: 'S', curve: 'exp' },
  // Continuous: 0 = square bank, 1 = ring-mod pairs, 2 = FM (blends in between).
  { id: 'm_mode', name: 'M MODE', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'm_fm', name: 'M FM', min: 0, max: 4, defaultValue: 0.5, unit: '', curve: 'linear' },
  // HAT head: what the metal sounds like at the start of the hit, before it becomes the tail.
  // HAT: a bell's sine partials over the metal, and the jingles' rattle at the start of a hit.
  { id: 'm_bell', name: 'BELL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'h_rattle', name: 'RATTLE', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'h_time', name: 'HEAD', min: 0, max: 0.5, defaultValue: 0, unit: 'S', curve: 'linear', decimals: 3 },
  { id: 'h_pitch', name: 'H PITCH', min: 20, max: 12000, defaultValue: 420, unit: 'HZ', curve: 'exp', decimals: 0 },
  // HAT (TIMBRE's, no knob): the MTL PITCH the sound was designed at. Moving MTL PITCH (or the
  // note) away from it moves the head's pitch and both TONEs by the same ratio, so the hit
  // keeps its shape (no glide from a head left behind, no partials under a high-pass left behind).
  // SNARE (TIMBRE's, no knob): the shell's second resonance, a sine at SHELL_RATIO x the body,
  // dying twice as fast (the body's envelope squared): a body with weight, not a tom's boing.
  { id: 't_shell', name: 'SHELL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'm_pref', name: 'MTL REF', min: 20, max: 12000, defaultValue: 420, unit: 'HZ', curve: 'exp', decimals: 0 },
  // HAT FOCUS: from the 808 clang (inharmonic squares, noise) towards a clearly pitched cymbal:
  // less SPREAD, less noise, more BELL.
  { id: 'h_focus', name: 'FOCUS', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'h_tone', name: 'H TONE', min: 30, max: 20000, defaultValue: 8500, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'h_noise', name: 'H NOISE', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'h_mode', name: 'H MODE', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'h_spread', name: 'H SPREAD', min: 0, max: 3, defaultValue: 1, unit: '', curve: 'linear' },
  // PERC: the metal's interval above the tone (whole semitones) and DETUNE of metal + click.
  { id: 'm_interval', name: 'INTVL', min: -12, max: 36, defaultValue: 12, unit: 'ST', curve: 'linear', decimals: 0 },
  { id: 'detune', name: 'DETUNE', min: -1, max: 1, defaultValue: 0, unit: 'ST', curve: 'linear', decimals: 2 },
  // Whole drum: these sit on top of TIMBRE / INTENSITY (the macros never move BALANCE).
  { id: 'balance', name: 'BALANCE', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'drive', name: 'DRIVE', min: 1, max: 200, defaultValue: 1, unit: 'X', curve: 'exp', decimals: 1 },
  { id: 'crush', name: 'CRUSH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // Output gain after DRIVE / CRUSH (set by TIMBRE, no knob): every sound equally loud by default.
  { id: 'ogain', name: 'OUT GAIN', min: 0.05, max: 16, defaultValue: 1, unit: '', curve: 'exp', decimals: 2 },
  // ROLL DIV: how fast a ROLL step repeats (read by the engine; the voice ignores it).
  choice('rolldiv', 'ROLL RATE', ROLL_DIVS.map((r) => r.name), DEFAULT_ROLL_RATE),
  // AIR (KICK, SNARE): a small room on the drum's own output, its tail through the type's fixed EQ.
  { id: 'air', name: 'AIR LVL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // AIR TAIL (id airsize, was AIR SIZE): the shape of the room's fixed-length envelope (airRoom.ts).
  { id: 'airsize', name: 'AIR TAIL', min: 0, max: 1, defaultValue: 0.4, unit: '', curve: 'linear' },
  // HAT's AIR SIZE (v81): its natural room's RT60 (airRoom.ts NATURAL).
  { id: 'hairsize', name: 'AIR SIZE', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
  midFreq(1000),
  // OCTAVE (FUNC + OCT): the pitched layers an octave at a time, on top of the note.
  OCTAVE,
] as ParamSpec[]).map((p) => [p.id, p]));

/**
 * The note KICK / SNARE / HAT play as designed: A1, the keyboard's A in the default A minor.
 * PERC is tuned by name (its tone is C3 on C2), so its A key already plays an A.
 */
export const DRUM_ROOT = 33;

/** Build a drum type's parameter list (in knob order) with per-type defaults. */
function drumParams(ids: string[], defaults: Record<string, number>): ParamSpec[] {
  return ids.map((id) => ({ ...ALL[id], defaultValue: defaults[id] ?? ALL[id].defaultValue }));
}

/** Controls every drum has (after its layer parameters). */
const WHOLE = ['balance', 'drive', 'crush', 'ogain', 'rolldiv', 'midfreq', 'octave'];
/** AIR: KICK and SNARE (DrumVoice.air sets each one's EQ); HAT its natural room (AIR SIZE). */
const AIR = ['air', 'airsize'];
const HAT_AIR = ['air', 'hairsize'];

/*
 * Each drum type: its parameters (set by TIMBRE / INTENSITY and presets, except the tail
 * lengths - layer decays and the ring extension - which are the type's own, the same for every
 * TIMBRE, so sounds can be swapped without changing how long they ring; the KICK's BD DEC is
 * the exception: TIMBRE's, 0.5 s on every sound, shortened by TECHNO's INT extreme),
 * and its two elements' ATTACK / DECAY ids (on the SOUND page, see registry). Parameters
 * without a knob are set by TIMBRE / INTENSITY.
 */
export const KICK_PARAMS = drumParams(
  ['timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_stime', 't_attack', 't_decay', 't_wave', 'c_level', 'c_tone', 'c_attack', 'c_len', 'c_reso', 'c_noise', ...WHOLE, ...AIR],
  { t_level: 0.95, t_pitch: 48, t_sweep: 30, t_stime: 0.035, t_decay: 0.5, c_level: 0.25, c_tone: 3500, c_len: 0.003, midfreq: 350 },
);
export const KICK_ELEMENTS = ['t_attack', 't_decay', 'c_attack', 'c_len'];

export const SNARE_PARAMS = drumParams(
  ['timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_stime', 't_attack', 't_decay', 't_wave', 't_shell', 'c_level', 'c_tone', 'c_attack', 'c_len', 'c_reso', 'c_noise', 'm_level', 'm_pitch', 'm_noise', 'm_tone', 'm_attack', 'm_decay', 'm_spread', 'm_mode', 'm_fm', ...WHOLE, ...AIR],
  { t_level: 0.55, t_pitch: 190, t_sweep: 7, t_decay: 0.14, m_level: 0.8, m_noise: 0.85, m_pitch: 330, m_tone: 1800, m_decay: 0.2, midfreq: 500 },
);
export const SNARE_ELEMENTS = ['t_attack', 't_decay', 'm_attack', 'm_decay'];

export const HAT_PARAMS = drumParams(
  [
    'timbre', 'intensity', 'c_level', 'c_tone', 'c_attack', 'c_len', 'c_reso', 'c_noise', 'm_level', 'm_pitch', 'm_spread', 'm_noise', 'm_tone', 'm_attack', 'm_decay', 'm_mode', 'm_fm',
    'h_time', 'h_pitch', 'h_tone', 'h_noise', 'h_mode', 'h_spread', 'm_bell', 'h_rattle', 'm_pref', 'h_focus', ...WHOLE, ...HAT_AIR,
  ],
  { c_level: 0.2, c_tone: 9000, c_len: 0.002, m_level: 0.6, m_pitch: 420, m_spread: 1, m_noise: 0.3, m_tone: 8500, m_decay: 0.1, h_time: 0.03, midfreq: 2000 },
);
export const HAT_ELEMENTS = ['c_attack', 'c_len', 'm_attack', 'm_decay'];

export const PERC_PARAMS = drumParams(
  [
    'timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_stime', 't_attack', 't_decay', 't_wave',
    'c_level', 'c_tone', 'c_attack', 'c_len', 'c_reso', 'c_noise',
    'm_level', 'm_interval', 'detune', 'm_spread', 'm_noise', 'm_tone', 'm_mode', 'm_fm', ...WHOLE,
  ],
  { t_level: 0.95, t_pitch: 95, t_sweep: 9, t_stime: 0.08, t_decay: 0.3, c_level: 0.3, c_tone: 2200, c_len: 0.004, midfreq: 450 },
);
export const PERC_ELEMENTS = ['t_attack', 't_decay', 'c_attack', 'c_len'];

/** Presets = the named TIMBRE points (intensity in the middle). */
function anchorPresets(kind: 'kick' | 'snare' | 'hat' | 'perc'): Preset[] {
  const anchors = MACROS[kind].anchors;
  return anchors.map((a, i) => ({ name: a.name, values: { timbre: i / (anchors.length - 1), intensity: 0.5 } }));
}
export const KICK_PRESETS: readonly Preset[] = anchorPresets('kick');
export const SNARE_PRESETS: readonly Preset[] = anchorPresets('snare');
export const HAT_PRESETS: readonly Preset[] = anchorPresets('hat');
export const PERC_PRESETS: readonly Preset[] = anchorPresets('perc');
