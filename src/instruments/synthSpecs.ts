/**
 * The synth types' parameters (every knob's range and default, per type) and presets: the
 * panel's tables. The sound itself is the Rust engine's (native/src/instruments/synth.rs: up
 * to 6 voices, SHAPE's waves into an FM pair or stacks, filter, envelopes, DRIVE / CRUSH, the
 * onboard effects), which gets these values by the protocol.
 */
import { choice, FDECAY_POWER, type ParamSpec } from '../engine/params';
import { INTENSITY, OCTAVE, OCTAVE_ZERO, TIMBRE, midFreq, type Preset } from './macroParams';
import { MACROS } from './macros';

const VOICE_MODES = ['POLY', 'MONO'] as const;
/** SLIDE time of the sounds without a SLIDE knob (pad, pluck), and the default. */
const SLIDE_SECONDS = 0.06;
/** The FM RATIO knob's choices (BASS / LEAD: carrier : modulator, each with its lowest partial on the note). */
const FM_PAIR_NAMES = ['1:1', '1:2', '1:3', '3:2', '3:4', '1:4', '1:5', '1:7'];
/** PLUCK's DLY TIME: tempo-synced divisions. */
const DELAY_DIVISIONS = ['1/16', '1/8', '3/16', '1/4', '3/8', '1/2', '3/4', '1 BAR'];
/** PAD MOD TYPE (v82: FLANGER in ENSEMBLE's place). */
const PAD_MOD_TYPES = ['CHORUS', 'FLANGER', 'PHASER'];

/**
 * PAD (2 STACKS) modulation index from FM LVL (0..1), v79: a square law up to 13, so the
 * brightness rises evenly across the knob (the engine's own copy: synth.rs).
 */
export function stackIndex(fm: number): number {
  return fm <= 0 ? 0 : 13 * fm * fm;
}

const SYNTH_PARAMS: readonly ParamSpec[] = [
  TIMBRE,
  INTENSITY,
  // 0 sine, 1 triangle, 2 saw, 3 square; BASS also 3 -> 4 = the square narrowing to a PULSE.
  { id: 'shape', name: 'SHAPE', min: 0, max: 3, defaultValue: 2, unit: '', curve: 'linear' },
  { id: 'fm', name: 'FM LVL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // PAD / LEAD: the second stack's modulation level (PAD stack 2, LEAD carriers 2 / 3). FM LVL
  // sets it along with its own (registry.linkedParams); this knob sets it apart afterwards.
  { id: 'fm2', name: 'FM LVL2', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'fmratio', name: 'FM RATIO', min: 0.25, max: 16, defaultValue: 2, unit: '', curve: 'exp', decimals: 2 },
  { id: 'cratio', name: 'CAR RATIO', min: 0.25, max: 8, defaultValue: 1, unit: '', curve: 'exp', decimals: 2 },
  { id: 'detune', name: 'DETUNE', min: 0, max: 4, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'sub', name: 'SUB', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'unison', name: 'UNISON', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  // 3 CARRIER algorithm (LEAD): carriers 2 and 3's ratios to carrier 1, and the modulator's
  // self-feedback (FM RATIO is the modulator's ratio). Set by TIMBRE.
  { id: 'ratio2', name: 'RATIO 2', min: 0.25, max: 8, defaultValue: 1, unit: '', curve: 'exp', decimals: 2 },
  { id: 'ratio3', name: 'RATIO 3', min: 0.25, max: 8, defaultValue: 1, unit: '', curve: 'exp', decimals: 2 },
  { id: 'feedback', name: 'FEEDBACK', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // Carrier 1's own feedback (DX7-style: a sine turns saw-like as it rises). Set by INT.
  { id: 'cfeedback', name: 'CAR FB', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // Level of carriers 2 and 3 against carrier 1 (0 = one clear note, 1 = the full stack).
  { id: 'carriers', name: 'CARRIERS', min: 0, max: 1, defaultValue: 0.35, unit: '', curve: 'linear' },
  OCTAVE,
  choice('voice', 'VOICES', VOICE_MODES),
  // SLIDE (id "glide" for old projects): how long a SLIDE note takes to glide into the next;
  // fully left = an instant jump. Only slides glide; other notes start on pitch.
  { id: 'glide', name: 'SLIDE', min: 0, max: 3, defaultValue: SLIDE_SECONDS, unit: 'S', curve: 'square', decimals: 3 },
  { id: 'cutoff', name: 'CUTOFF', min: 20, max: 20000, defaultValue: 1200, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'reso', name: 'RESO', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'fenv', name: 'FLT ENV', min: 0, max: 2, defaultValue: 0.4, unit: '', curve: 'linear' },
  { id: 'fattack', name: 'FLT ATK', min: 0.0005, max: 10, defaultValue: 0.0005, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'fdecay', name: 'FLT DEC', min: 0.002, max: 10, defaultValue: 0.3, unit: 'S', curve: 'power', power: FDECAY_POWER },
  // FM envelope: how the FM amount rises (FM ATK) and falls back (FM DEC) on every note, on
  // the same curves as the filter's. Each FM algorithm's index swings with it.
  { id: 'fmattack', name: 'FM ATK', min: 0.0005, max: 10, defaultValue: 0.0005, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'fmdecay', name: 'FM DEC', min: 0.002, max: 10, defaultValue: 0.3, unit: 'S', curve: 'power', power: FDECAY_POWER },
  // LEAD: delayed vibrato (depth in semitones, rate, and how long it takes to swell in after
  // each note starts) and a pitch envelope (each note bends into its pitch from BEND
  // semitones away, over BEND TIME).
  { id: 'vibrato', name: 'VIBRATO', min: 0, max: 1, defaultValue: 0, unit: 'ST', curve: 'linear', decimals: 2 },
  { id: 'vibrate', name: 'VIB RATE', min: 1, max: 12, defaultValue: 5.5, unit: 'HZ', curve: 'exp', decimals: 1 },
  { id: 'vibdelay', name: 'VIB DELAY', min: 0, max: 2, defaultValue: 0.3, unit: 'S', curve: 'linear', decimals: 2 },
  { id: 'bend', name: 'BEND', min: -24, max: 24, defaultValue: 0, unit: 'ST', curve: 'linear', decimals: 1 },
  { id: 'bendtime', name: 'BEND TIME', min: 0.005, max: 2, defaultValue: 0.08, unit: 'S', curve: 'exp', decimals: 3 },
  { id: 'drive', name: 'DRIVE', min: 1, max: 100, defaultValue: 1, unit: 'X', curve: 'exp', decimals: 1 },
  { id: 'crush', name: 'CRUSH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'level', name: 'LEVEL', min: 0, max: 1.5, defaultValue: 0.7, unit: '', curve: 'linear' },
  // Output gain after DRIVE / CRUSH (set by TIMBRE, no knob): every sound equally loud by
  // default, without changing how hard it drives.
  { id: 'ogain', name: 'OUT GAIN', min: 0.05, max: 16, defaultValue: 1, unit: '', curve: 'exp', decimals: 2 },
  // BASS / LEAD (set by TIMBRE, no knob): how much FM LVL would raise the wave's level at its
  // most (dB, about FM 80), taken off along FM_RISE, so FM LVL changes its colour, not its level
  // (fmGainOf).
  { id: 'fmcomp', name: 'FM COMP', min: -24, max: 24, defaultValue: 0, unit: 'DB', curve: 'linear', decimals: 1 },
  // BASS: the FM pair's carrier : modulator (FM_PAIRS; a knob on FUNC module 4).
  { id: 'fmpair', name: 'FM RATIO', min: 0, max: 7, defaultValue: 0, unit: '', curve: 'linear', options: FM_PAIR_NAMES, coarse: true },
  { id: 'attack', name: 'OSC1 ATK', min: 0.0005, max: 10, defaultValue: 0.003, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'decay', name: 'OSC1 DEC', min: 0.005, max: 20, defaultValue: 0.4, unit: 'S', curve: 'exp' },
  { id: 'attack2', name: 'OSC2 ATK', min: 0.0005, max: 10, defaultValue: 0.003, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'decay2', name: 'OSC2 DEC', min: 0.005, max: 20, defaultValue: 0.4, unit: 'S', curve: 'exp' },
  // Each oscillator has its own SUSTAIN / RELEASE ("sustain" / "release" = OSC 1).
  { id: 'sustain', name: 'OSC1 SUS', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'release', name: 'OSC1 REL', min: 0.005, max: 20, defaultValue: 0.15, unit: 'S', curve: 'exp' },
  { id: 'sustain2', name: 'OSC2 SUS', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'release2', name: 'OSC2 REL', min: 0.005, max: 20, defaultValue: 0.15, unit: 'S', curve: 'exp' },
  // One envelope for both oscillators (BASS, PLUCK): OSC 2's DECAY is OSC 1's x this (set
  // by TIMBRE: each pluck's shorter OSC 2 tail is part of its character).
  { id: 'dratio', name: 'OSC2 DEC x', min: 0.25, max: 2, defaultValue: 1, unit: '', curve: 'linear', decimals: 2 },
  // SIDECHAIN (BASS): each KICK hit ducks the sound by DUCK, recovering over DUCK REL.
  { id: 'duck', name: 'DUCK', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'duckrel', name: 'DUCK REL', min: 0.02, max: 1, defaultValue: 0.2, unit: 'S', curve: 'exp', decimals: 3 },
  // Onboard FX (PLUCK): a tempo-synced delay, then a short room (both dry until turned up).
  midFreq(1000),
  choice('dtime', 'DLY TIME', DELAY_DIVISIONS, 2),
  { id: 'dfdbk', name: 'DLY FDBK', min: 0, max: 0.95, defaultValue: 0.35, unit: '', curve: 'linear' },
  { id: 'dmix', name: 'DLY MIX', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'verb', name: 'VERB', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // PAD's own effects (v81, ALT; all off by default): LOW CUT (a high-pass, off at 20 Hz), then
  // MOD (CHORUS / FLANGER / PHASER, FX 2's old units, at its old RATE / DEPTH), then VERB (a hall).
  { id: 'lowcut', name: 'LOW CUT', min: 20, max: 1000, defaultValue: 20, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'modmix', name: 'MOD', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  choice('modtype', 'MOD TYPE', PAD_MOD_TYPES),
];

const BY_ID: Record<string, ParamSpec> = Object.fromEntries(SYNTH_PARAMS.map((p) => [p.id, p]));

function synthParams(ids: string[], defaults: Record<string, number>, names: Record<string, string> = {}, max: Record<string, number> = {}): ParamSpec[] {
  return ids.map((id) => ({ ...BY_ID[id], defaultValue: defaults[id] ?? BY_ID[id].defaultValue, name: names[id] ?? BY_ID[id].name, max: max[id] ?? BY_ID[id].max }));
}
/** Plain envelope names (BASS / PLUCK: one envelope; PAD / LEAD: these move both oscillators). */
const SHARED_NAMES = { attack: 'ATTACK', decay: 'DECAY', sustain: 'SUSTAIN', release: 'RELEASE' };

/**
 * The synth tracks share the engine with different controls: BASS (mono, glide, envelope
 * filter, sidechain), PAD (kind "pad": polyphonic chords), LEAD (mono, glide) and PLUCK
 * (onboard delay + room). PAD and LEAD keep their amp envelopes (both oscillators) as the
 * type's own; BASS and PLUCK sounds bring theirs, one envelope for both oscillators.
 * Settings outside the list are fixed per type (the engine's, synth.rs).
 */
const MORPHED = ['timbre', 'intensity', 'shape', 'fm', 'fmratio', 'fmattack', 'fmdecay', 'detune', 'unison', 'cutoff', 'reso', 'fattack', 'fenv', 'fdecay', 'drive'];

const ENVELOPE = ['attack', 'decay', 'attack2', 'decay2', 'sustain', 'release', 'crush', 'level', 'sustain2', 'release2'];
/** One envelope for both oscillators (envlink). */
const SHARED_ENVELOPE = ['attack', 'decay', 'sustain', 'release', 'dratio', 'crush', 'level'];
export const BASS_PARAMS = synthParams([...MORPHED.filter((id) => id !== 'fmratio'), 'fmpair', 'ogain', 'fmcomp', 'sub', 'octave', 'glide', ...SHARED_ENVELOPE, 'duck', 'duckrel', 'midfreq'], { attack: 0.002, decay: 0.6, sustain: 0.6, release: 0.06, level: 0.75, midfreq: 350 }, SHARED_NAMES, { shape: 4 });
/** PAD: held chords that fade in and out quickly (PLUCK is the stab engine). */
const PAD_DEFAULT_ENVELOPE = { attack: 0.03, attack2: 0.03, decay: 0.6, decay2: 0.6, sustain: 0.85, sustain2: 0.85, release: 0.2, release2: 0.2 };
// PAD DETUNE: half the other synths' range (any more is unusable on chords).
export const PAD_PARAMS = synthParams([...MORPHED, 'fm2', 'ogain', 'octave', 'glide', ...ENVELOPE, 'ratio2', 'ratio3', 'feedback', 'carriers', 'cfeedback', 'midfreq', 'lowcut', 'verb', 'modmix', 'modtype'], { ...PAD_DEFAULT_ENVELOPE, level: 0.5, detune: 0.25, midfreq: 500 }, SHARED_NAMES, { detune: 2 });
/**
 * LEAD: the BASS / PLUCK engine (SHAPE's waves into an FM pair, OSC 2 detuned, one envelope),
 * mono with slides, plus what makes a lead: delayed VIBRATO and a pitch envelope (BEND).
 */
export const LEAD_PARAMS = synthParams([...MORPHED.filter((id) => id !== 'fmratio'), 'fmpair', 'ogain', 'fmcomp', 'octave', 'glide', ...SHARED_ENVELOPE, 'vibrato', 'vibrate', 'vibdelay', 'bend', 'bendtime', 'midfreq'], { midfreq: 1000, octave: OCTAVE_ZERO + 1, attack: 0.004, decay: 0.6, sustain: 0.75, release: 0.2, level: 0.55, detune: 0.08 }, SHARED_NAMES, { shape: 4 });
/** PLUCK: a polyphonic pluck (the ARP is a track setting now: engine/arp.ts). */
export const PLUCK_PARAMS = synthParams([...MORPHED, 'cfeedback', 'ogain', 'octave', 'glide', ...SHARED_ENVELOPE, 'dtime', 'dfdbk', 'dmix', 'verb', 'midfreq'], { midfreq: 800, attack: 0.001, decay: 0.35, sustain: 0, release: 0.08, level: 0.55, detune: 0.15 }, SHARED_NAMES);

/** Presets = the named TIMBRE points (intensity in the middle). */
function anchorPresets(kind: 'bass' | 'pad' | 'lead' | 'pluck'): Preset[] {
  const anchors = MACROS[kind].anchors;
  return anchors.map((a, i) => ({ name: a.name, values: { timbre: i / (anchors.length - 1), intensity: 0.5 } }));
}
/**
 * BASS presets (v70): finished sounds as knob settings on a TIMBRE wave (0 SINE, 0.25 TRIANGLE,
 * 0.5 SAW, 0.75 SQUARE, 1 PULSE). A preset loads as SOUND page edits (trims), so every knob
 * shows where it is and turning TIMBRE keeps them (ACID's filter on a saw ...). fmpair = FM
 * RATIO: 0 1:1, 1 1:2, 2 1:3, 3 3:2. In TIMBRE order (v72; saves renumbered, PRESET_ORDER_V72).
 * `level` (LEVEL, no knob) evens the presets (equally loud, as the TIMBRE waves). At INT 100 (v76):
 * the plain wave they were designed on (INT bends it: CZ); turn INT down to round them.
 */
export const BASS_PRESETS: readonly Preset[] = [
  { name: 'SUB', values: { timbre: 0, intensity: 1, level: 0.731, fm: 0.12, fmpair: 1, cutoff: 3000, reso: 0, fenv: 0, fdecay: 0.3, fmdecay: 0.3, drive: 1, glide: 0.03, decay: 0.7, sustain: 0.8 } },
  { name: 'STICK', values: { timbre: 0.25, intensity: 1, level: 0.619, fm: 0.25, fmpair: 2, sub: 0.05, cutoff: 800, reso: 0.2, fenv: 0.25, fdecay: 0.4, fmdecay: 0.4, drive: 1.2, glide: 0.03, decay: 1.6, sustain: 0.6, detune: 0.03 } },
  { name: 'GROWL', values: { timbre: 0.5, intensity: 1, level: 0.594, fm: 0.15, fmpair: 1, sub: 0.5, cutoff: 650, reso: 0.3, fenv: 0.2, fdecay: 0.5, fmdecay: 0.5, drive: 3, glide: 0.04, decay: 1, sustain: 0.9, detune: 0.75 } },
  { name: 'REESE', values: { timbre: 0.5, intensity: 1, level: 0.850, sub: 0.3, cutoff: 500, reso: 0.2, fenv: 0.1, fdecay: 0.5, fmdecay: 0.5, drive: 2, decay: 1.2, sustain: 0.9, detune: 0.6, unison: 1 } },
  { name: 'SOLID', values: { timbre: 0.625, intensity: 1, level: 1.398, fm: 0.45, fmpair: 3, sub: 0.4, cutoff: 420, reso: 0.45, fenv: 0.5, fdecay: 0.22, fmdecay: 0.22, drive: 1.6, glide: 0.02, decay: 0.5, sustain: 0.45, detune: 0.15 } },
  { name: 'ACID', values: { timbre: 0.75, intensity: 1, level: 0.722, cutoff: 380, reso: 0.75, fenv: 0.9, fdecay: 0.18, fmdecay: 0.18, drive: 1.8, glide: 0.08, decay: 0.35, sustain: 0.6 } },
];
export const PAD_PRESETS: readonly Preset[] = anchorPresets('pad');
/**
 * LEAD presets (v71), as the BASS's: knob settings on a TIMBRE wave (0 SINE, 0.25 TRIANGLE, 0.5
 * SAW, 0.75 SQUARE, 1 PULSE), loaded as trims. fmpair = FM RATIO (1 1:2, 5 1:4, 6 1:5, 0 1:1);
 * `level` evens them, as the BASS's. In TIMBRE order (v72).
 */
export const LEAD_PRESETS: readonly Preset[] = [
  // A sine with a slow, late vibrato and a long slide: theremin / dub siren.
  { name: 'WHISTLE', values: { timbre: 0, intensity: 1, level: 0.494, fm: 0.04, fmpair: 1, cutoff: 7000, reso: 0, fenv: 0.1, fdecay: 0.6, fmdecay: 0.6, drive: 1.1, glide: 0.15, decay: 1.2, sustain: 0.9, vibrato: 0.35, vibrate: 5.2, vibdelay: 0.35 } },
  // The FM pair at 1 : 2 with a fast FM envelope and a quick zap down from above: it bites.
  { name: 'FM BITE', values: { timbre: 0, intensity: 1, level: 0.592, fm: 0.55, fmpair: 1, cutoff: 4500, reso: 0.15, fenv: 0.4, fdecay: 0.15, fmdecay: 0.15, drive: 1.5, glide: 0.05, decay: 0.6, sustain: 0.7, detune: 0.05, vibrato: 0.1, vibrate: 6, vibdelay: 0.4, bend: 12, bendtime: 0.03 } },
  // Hard-sync style: a SAW under a deep 1 : 4 pair whose FM envelope sweeps down each note (the
  // tearing, formant-sweeping sync lead), in the squelch range.
  { name: 'SYNC', values: { timbre: 0.5, intensity: 1, level: 0.449, fm: 0.65, fmpair: 5, fmdecay: 0.3, cutoff: 4500, reso: 0.25, fenv: 0.4, fdecay: 0.3, drive: 2, glide: 0.05, decay: 0.8, sustain: 0.8, vibrato: 0.08, vibdelay: 0.5 } },
  // Detuned saws, wide, each note scooping up from an octave below: the rave hoover.
  { name: 'HOOVER', values: { timbre: 0.5, intensity: 1, level: 0.935, fm: 0.08, fmpair: 0, cutoff: 2200, reso: 0.3, fenv: 0.5, fdecay: 0.25, fmdecay: 0.25, drive: 2, glide: 0.08, decay: 0.9, sustain: 0.8, detune: 1, unison: 1.3, vibrato: 0.25, vibrate: 4, vibdelay: 0.6, bend: -12, bendtime: 0.1 } },
  // The engine at once: a narrowed PULSE, wide (UNISON, DETUNE), each note scooping up into
  // pitch, then blooming into glass as a slow FM ATTACK opens the 1 : 5 pair, a delayed
  // vibrato swelling in as it settles; resonant, with a long slide.
  { name: 'BLOOM', values: { timbre: 0.9, intensity: 1, level: 0.833, fm: 0.35, fmpair: 6, fmattack: 0.35, fmdecay: 1.5, cutoff: 3500, reso: 0.35, fenv: 0.3, fdecay: 0.8, drive: 1.4, glide: 0.1, decay: 1.5, sustain: 0.85, detune: 0.3, unison: 0.6, vibrato: 0.25, vibrate: 5, vibdelay: 0.7, bend: -1, bendtime: 0.12 } },
];
export const PLUCK_PRESETS: readonly Preset[] = anchorPresets('pluck');
