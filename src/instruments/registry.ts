/**
 * Instrument registry: one table entry per track type. Adding a type means one entry
 * here (plus a class if it needs new DSP).
 */
import type { Instrument, Preset } from './Instrument';
import type { InstrumentKind, SoundKind } from '../engine/project';
import type { ParamSpec } from '../engine/params';
import {
  Drum, HAT_LAYOUT, HAT_PARAMS, HAT_PRESETS, KICK_LAYOUT, KICK_PARAMS, KICK_PRESETS,
  SNARE_LAYOUT, SNARE_PARAMS, SNARE_PRESETS,
} from './Drum';
import {
  BASS_FIXED, BASS_PARAMS, BASS_PRESETS, LEAD_FIXED, LEAD_PARAMS, LEAD_PRESETS,
  PAD_FIXED, PAD_PARAMS, PAD_PRESETS, Synth,
} from './Synth';

export interface InstrumentEntry {
  name: string;
  /** All of the type's parameters (stored, set by presets, lockable). */
  params: readonly ParamSpec[];
  /** Sound design page: 12 knob slots (2 rows of 6) by param id, null = empty. */
  layout: readonly (string | null)[];
  presets: readonly Preset[];
  /** Drum voices use the step strip when recording; pitched types get a keyboard. */
  drum: boolean;
  /** Lowest note on the keyboard (an A, so the strip starts on A). */
  baseNote: number;
  create: (sampleRate: number) => Instrument;
}

export const INSTRUMENTS: Record<SoundKind, InstrumentEntry> = {
  kick: { name: 'KICK', params: KICK_PARAMS, layout: KICK_LAYOUT, presets: KICK_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, KICK_PARAMS) },
  snare: { name: 'SNARE', params: SNARE_PARAMS, layout: SNARE_LAYOUT, presets: SNARE_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, SNARE_PARAMS) },
  hat: { name: 'HAT', params: HAT_PARAMS, layout: HAT_LAYOUT, presets: HAT_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, HAT_PARAMS) },
  bass: { name: 'BASS', params: BASS_PARAMS, layout: BASS_PARAMS.map((p) => p.id), presets: BASS_PRESETS, drum: false, baseNote: 33, create: (sr) => new Synth(sr, BASS_PARAMS, BASS_FIXED) },
  pad: { name: 'PAD', params: PAD_PARAMS, layout: PAD_PARAMS.map((p) => p.id), presets: PAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PAD_PARAMS, PAD_FIXED) },
  lead: { name: 'LEAD', params: LEAD_PARAMS, layout: LEAD_PARAMS.map((p) => p.id), presets: LEAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, LEAD_PARAMS, LEAD_FIXED) },
};

export const SOUND_KINDS = Object.keys(INSTRUMENTS) as SoundKind[];

export function instrumentParams(kind: InstrumentKind): readonly ParamSpec[] {
  return kind === 'none' ? [] : INSTRUMENTS[kind].params;
}

export function isDrum(kind: InstrumentKind): boolean {
  return kind === 'none' || INSTRUMENTS[kind].drum;
}

export function paramSpec(kind: InstrumentKind, id: string): ParamSpec | undefined {
  return instrumentParams(kind).find((p) => p.id === id);
}

/** Full sound for a preset: defaults overlaid with the preset's values. */
export function presetSound(kind: SoundKind, index: number): Record<string, number> {
  const sound: Record<string, number> = {};
  for (const p of INSTRUMENTS[kind].params) sound[p.id] = p.defaultValue;
  return { ...sound, ...INSTRUMENTS[kind].presets[index].values };
}
