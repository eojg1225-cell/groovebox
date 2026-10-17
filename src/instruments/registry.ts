/**
 * Instrument registry: one table entry per track type. Adding a type means one entry
 * here (plus a class if it needs new DSP).
 */
import type { Instrument, Preset } from './Instrument';
import type { InstrumentKind, SoundKind } from '../engine/project';
import type { ParamSpec } from '../engine/params';
import { macroSound } from './macros';
import {
  Drum, HAT_ELEMENTS, HAT_PARAMS, HAT_PRESETS, KICK_ELEMENTS, KICK_PARAMS, KICK_PRESETS,
  PERC_ELEMENTS, PERC_PARAMS, PERC_PRESETS, SNARE_ELEMENTS, SNARE_PARAMS, SNARE_PRESETS,
} from './Drum';
import {
  BASS_FIXED, BASS_PARAMS, BASS_PRESETS, LEAD_FIXED, LEAD_PARAMS, LEAD_PRESETS, PLUCK_FIXED, PLUCK_PARAMS, PLUCK_PRESETS,
  PAD_FIXED, PAD_PARAMS, PAD_PRESETS, SYNTH_ELEMENTS, Synth,
} from './Synth';

/** Knob slots per page: 2 rows of 8 modules. */
export const PAGE_SLOTS = 16;
const ROW = PAGE_SLOTS / 2;

/**
 * The SOUND page (the only sound page), the same shape for every track type. One column per
 * module (top knob / bottom knob): 1 TIMBRE / INTENSITY, 2 element 1 ATTACK / DECAY,
 * 3 element 2 ATTACK / DECAY, 4 FILTER / RESO, 5 FILTER ATTACK / DECAY, 6 DRIVE / CRUSH,
 * 7 the type's key tuning pair (`tune`), 8 `last`: FILTER ENV amount / RING LEN (drums) or
 * FM (synths). PLUCK: column 7 CHORD / ARP OCT, column 8 ARP / ARP RATE.
 * Elements: KICK tone + click, SNARE tone + metal, HAT click + metal, PERC tone + click,
 * synths OSC 1 + OSC 2. Column 7: drums ROLL DIV + pitch (KICK / SNARE / PERC tone pitch,
 * HAT metal pitch; sweep and wire / metal tone follow TIMBRE / INTENSITY), BASS / LEAD
 * SLIDE + DETUNE, PAD UNISON + DETUNE.
 */
export function soundPage(elements: readonly string[], tune: readonly [string, string], last: readonly [string, string]): string[] {
  const [a1, d1, a2, d2] = elements;
  return [
    'timbre', a1, a2, 'cutoff', 'fattack', 'drive', tune[0], last[0],
    'intensity', d1, d2, 'reso', 'fdecay', 'crush', tune[1], last[1],
  ];
}

/** Column 7 for the synths: mono ones SLIDE (time) / DETUNE, the pad UNISON / DETUNE. */
const MONO_TUNE = ['glide', 'detune'] as const;
const PAD_TUNE = ['unison', 'detune'] as const;

/** A 2 x 6 layout on the 2 x 8 panel: modules 1-6, modules 7-8 empty. */
export function widen<T>(six: readonly (T | null)[]): (T | null)[] {
  if (six.length === PAGE_SLOTS) return [...six];
  const out: (T | null)[] = new Array(PAGE_SLOTS).fill(null);
  six.forEach((x, i) => { out[i < 6 ? i : i - 6 + ROW] = x; });
  return out;
}

/**
 * The FUNC layer of a SOUND page (FUNC held): top row, then bottom row, 8 each; null = no
 * FUNC parameter on that knob (it does nothing while FUNC is held).
 */
export function funcPage(top: readonly (string | null)[], bottom: readonly (string | null)[]): (string | null)[] {
  return [...top, ...bottom];
}
const _ = null;
/*
 * FUNC layers. Synths: column 1 SHAPE, element columns SUSTAIN / RELEASE (each
 * oscillator its own), column 7 OCTAVE + SUB / UNISON. Drums: column 1 the tone's wave /
 * sweep time (or the metal's mode / FM), element columns the layer's LEVEL / colour
 * (SWEEP, CLICK TONE, METAL TONE), column 4 the click's reso / noise or the metal's noise /
 * spread, column 7 a third voice (snare metal FM / pitch, hat head, perc metal).
 */
const SYNTH_FUNC_TOP = ['shape', 'sustain', 'sustain2', _, _, _, 'octave', _];
const SYNTH_FUNC_BOTTOM = [_, 'release', 'release2', _, _, _];

export interface InstrumentEntry {
  name: string;
  /** All of the type's parameters (stored, set by presets, lockable). */
  params: readonly ParamSpec[];
  /** The SOUND page: 16 knob slots (2 rows of 8): the type's params ("track:chord" = the chord). */
  layout: readonly (string | null)[];
  /** The SOUND page's FUNC layer (16 slots, see funcPage). */
  funcLayout: readonly (string | null)[];
  /**
   * Default live knobs in RECORD / PLAY: two sound controls, and with FUNC held VOLUME +
   * one more (param ids or "mix:volume|pan|send").
   */
  live: readonly [string, string];
  liveFunc: readonly [string, string];
  presets: readonly Preset[];
  /** Drum voices use the step strip when recording; pitched types get a keyboard. */
  drum: boolean;
  /** A drum played from the keyboard in step entry (each step has its own pitch). */
  pitched?: boolean;
  /** Lowest note on the keyboard (an A, so the strip starts on A). */
  baseNote: number;
  create: (sampleRate: number) => Instrument;
}

export const INSTRUMENTS: Record<SoundKind, InstrumentEntry> = {
  kick: {
    name: 'KICK', live: ['t_decay', 't_pitch'], liveFunc: ['mix:volume', 'drive'], params: KICK_PARAMS, layout: soundPage(KICK_ELEMENTS, ['rolldiv', 't_pitch'], ['fenv', 'ring']),
    funcLayout: funcPage(['t_wave', 't_level', 'c_level', 'c_reso', _, _, _, _], ['t_stime', 't_sweep', 'c_tone', 'c_noise', _, _, _, _]),
    presets: KICK_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, KICK_PARAMS) },
  snare: {
    name: 'SNARE', live: ['m_decay', 't_pitch'], liveFunc: ['mix:volume', 'mix:send'], params: SNARE_PARAMS, layout: soundPage(SNARE_ELEMENTS, ['rolldiv', 't_pitch'], ['fenv', 'ring']),
    funcLayout: funcPage(['t_wave', 't_level', 'm_level', 'm_noise', _, _, 'm_fm', _], ['m_mode', 't_sweep', 'm_tone', 'm_spread', _, _, 'm_pitch', _]),
    presets: SNARE_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, SNARE_PARAMS) },
  hat: {
    name: 'HAT', live: ['m_decay', 'cutoff'], liveFunc: ['mix:volume', 'ring'], params: HAT_PARAMS, layout: soundPage(HAT_ELEMENTS, ['rolldiv', 'm_pitch'], ['fenv', 'ring']),
    funcLayout: funcPage(['m_mode', 'c_level', 'm_level', 'm_noise', _, _, 'h_time', 'h_tone'], ['m_fm', 'c_tone', 'm_tone', 'm_spread', _, _, 'h_pitch', 'h_noise']),
    presets: HAT_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, HAT_PARAMS) },
  perc: {
    name: 'PERC', live: ['t_decay', 'cutoff'], liveFunc: ['mix:volume', 'mix:send'], params: PERC_PARAMS, layout: soundPage(PERC_ELEMENTS, ['rolldiv', 't_pitch'], ['fenv', 'ring']),
    funcLayout: funcPage(['t_wave', 't_level', 'c_level', 'c_reso', _, _, 'm_level', _], ['t_stime', 't_sweep', 'c_tone', 'c_noise', _, _, 'm_pitch', _]),
    presets: PERC_PRESETS, drum: true, pitched: true, baseNote: 33, create: (sr) => new Drum(sr, PERC_PARAMS) },
  bass: {
    name: 'BASS', live: ['cutoff', 'reso'], liveFunc: ['mix:volume', 'fenv'], params: BASS_PARAMS, layout: soundPage(SYNTH_ELEMENTS, MONO_TUNE, ['fenv', 'fm']),
    funcLayout: funcPage(SYNTH_FUNC_TOP, [...SYNTH_FUNC_BOTTOM, 'sub', _]),
    presets: BASS_PRESETS, drum: false, baseNote: 33, create: (sr) => new Synth(sr, BASS_PARAMS, BASS_FIXED) },
  pad: {
    name: 'PAD', live: ['cutoff', 'release'], liveFunc: ['mix:volume', 'mix:send'], params: PAD_PARAMS, layout: soundPage(SYNTH_ELEMENTS, PAD_TUNE, ['fenv', 'fm']),
    funcLayout: funcPage(SYNTH_FUNC_TOP, [...SYNTH_FUNC_BOTTOM, _, _]),
    presets: PAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PAD_PARAMS, PAD_FIXED) },
  lead: {
    name: 'LEAD', live: ['cutoff', 'drive'], liveFunc: ['mix:volume', 'mix:send'], params: LEAD_PARAMS, layout: soundPage(SYNTH_ELEMENTS, MONO_TUNE, ['fenv', 'fm']),
    funcLayout: funcPage(SYNTH_FUNC_TOP, [...SYNTH_FUNC_BOTTOM, 'unison', _]),
    presets: LEAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, LEAD_PARAMS, LEAD_FIXED) },
  pluck: {
    name: 'PLUCK', live: ['decay', 'cutoff'], liveFunc: ['mix:volume', 'mix:send'], params: PLUCK_PARAMS, layout: soundPage(SYNTH_ELEMENTS, ['track:chord', 'arpoct'], ['arp', 'arprate']),
    funcLayout: funcPage([...SYNTH_FUNC_TOP.slice(0, 7), 'fenv'], [...SYNTH_FUNC_BOTTOM, 'unison', 'fm']),
    presets: PLUCK_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PLUCK_PARAMS, PLUCK_FIXED) },
};

export const SOUND_KINDS = Object.keys(INSTRUMENTS) as SoundKind[];

export function instrumentParams(kind: InstrumentKind): readonly ParamSpec[] {
  return kind === 'none' ? [] : INSTRUMENTS[kind].params;
}

export function isDrum(kind: InstrumentKind): boolean {
  return kind === 'none' || INSTRUMENTS[kind].drum;
}

/** Steps are tapped on the strip in step entry (drums), not entered from the keyboard. */
export function stepsOnStrip(kind: InstrumentKind): boolean {
  return kind === 'none' || (INSTRUMENTS[kind].drum && !INSTRUMENTS[kind].pitched);
}

export function paramSpec(kind: InstrumentKind, id: string): ParamSpec | undefined {
  return instrumentParams(kind).find((p) => p.id === id);
}

/**
 * Full sound for a preset: defaults, then (when the preset names a TIMBRE position) the
 * sound TIMBRE / INTENSITY produce there, then the preset's own values.
 */
/**
 * Sounds saved before each synth oscillator had its own SUSTAIN / RELEASE: OSC 2 takes
 * OSC 1's (as it did then). In place.
 */
export function mirrorOsc2(values: Record<string, number>): void {
  if (values.sustain !== undefined && values.sustain2 === undefined) values.sustain2 = values.sustain;
  if (values.release !== undefined && values.release2 === undefined) values.release2 = values.release;
}

export function presetSound(kind: SoundKind, index: number): Record<string, number> {
  const sound: Record<string, number> = {};
  const params = INSTRUMENTS[kind].params;
  for (const p of params) sound[p.id] = p.defaultValue;
  const values = INSTRUMENTS[kind].presets[index].values;
  const macro = values.timbre !== undefined ? macroSound(kind, values.timbre, values.intensity ?? 0.5, params) : {};
  return { ...sound, ...macro, ...values };
}
