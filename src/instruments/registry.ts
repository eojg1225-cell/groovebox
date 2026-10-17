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
 * SUSTAIN (synths); PLUCK: ARP / ARP RATE (tune SYNC / FM RATIO).
 * Elements: KICK tone + click, SNARE tone + metal, HAT click + metal, PERC tone + click,
 * synths OSC 1 + OSC 2. Tune: KICK / PERC pitch + sweep, SNARE pitch + wire tone, HAT metal
 * pitch + tone, synths FM RATIO + DETUNE.
 */
export function soundPage(elements: readonly string[], tune: readonly [string, string], last: readonly [string, string]): string[] {
  const [a1, d1, a2, d2] = elements;
  return [
    'timbre', a1, a2, 'cutoff', 'fattack', 'drive', tune[0], last[0],
    'intensity', d1, d2, 'reso', 'fdecay', 'crush', tune[1], last[1],
  ];
}

const SYNTH_TUNE = ['fmratio', 'detune'] as const;

/** A 2 x 6 layout on the 2 x 8 panel: modules 1-6, modules 7-8 empty. */
export function widen<T>(six: readonly (T | null)[]): (T | null)[] {
  if (six.length === PAGE_SLOTS) return [...six];
  const out: (T | null)[] = new Array(PAGE_SLOTS).fill(null);
  six.forEach((x, i) => { out[i < 6 ? i : i - 6 + ROW] = x; });
  return out;
}

export interface InstrumentEntry {
  name: string;
  /** All of the type's parameters (stored, set by presets, lockable). */
  params: readonly ParamSpec[];
  /** The SOUND page: 16 knob slots (2 rows of 8), the type's params; null = empty. */
  layout: readonly (string | null)[];
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
  kick: { name: 'KICK', params: KICK_PARAMS, layout: soundPage(KICK_ELEMENTS, ['t_pitch', 't_sweep'], ['fenv', 'ring']), presets: KICK_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, KICK_PARAMS) },
  snare: { name: 'SNARE', params: SNARE_PARAMS, layout: soundPage(SNARE_ELEMENTS, ['t_pitch', 'm_tone'], ['fenv', 'ring']), presets: SNARE_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, SNARE_PARAMS) },
  hat: { name: 'HAT', params: HAT_PARAMS, layout: soundPage(HAT_ELEMENTS, ['m_pitch', 'm_tone'], ['fenv', 'ring']), presets: HAT_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, HAT_PARAMS) },
  perc: { name: 'PERC', params: PERC_PARAMS, layout: soundPage(PERC_ELEMENTS, ['t_pitch', 't_sweep'], ['fenv', 'ring']), presets: PERC_PRESETS, drum: true, pitched: true, baseNote: 33, create: (sr) => new Drum(sr, PERC_PARAMS) },
  bass: { name: 'BASS', params: BASS_PARAMS, layout: soundPage(SYNTH_ELEMENTS, SYNTH_TUNE, ['fenv', 'sustain']), presets: BASS_PRESETS, drum: false, baseNote: 33, create: (sr) => new Synth(sr, BASS_PARAMS, BASS_FIXED) },
  pad: { name: 'PAD', params: PAD_PARAMS, layout: soundPage(SYNTH_ELEMENTS, SYNTH_TUNE, ['fenv', 'sustain']), presets: PAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PAD_PARAMS, PAD_FIXED) },
  lead: { name: 'LEAD', params: LEAD_PARAMS, layout: soundPage(SYNTH_ELEMENTS, SYNTH_TUNE, ['fenv', 'sustain']), presets: LEAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, LEAD_PARAMS, LEAD_FIXED) },
  pluck: { name: 'PLUCK', params: PLUCK_PARAMS, layout: soundPage(SYNTH_ELEMENTS, ['sync', 'fmratio'], ['arp', 'arprate']), presets: PLUCK_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PLUCK_PARAMS, PLUCK_FIXED) },
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
export function presetSound(kind: SoundKind, index: number): Record<string, number> {
  const sound: Record<string, number> = {};
  const params = INSTRUMENTS[kind].params;
  for (const p of params) sound[p.id] = p.defaultValue;
  const values = INSTRUMENTS[kind].presets[index].values;
  const macro = values.timbre !== undefined ? macroSound(kind, values.timbre, values.intensity ?? 0.5, params) : {};
  return { ...sound, ...macro, ...values };
}
