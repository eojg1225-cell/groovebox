/**
 * Instrument registry: one table entry per instrument kind. Adding an instrument means
 * one class plus one entry here.
 */
import type { Instrument, Preset } from './Instrument';
import type { InstrumentKind, SoundKind } from '../engine/project';
import type { ParamSpec } from '../engine/params';
import { Drum, DRUM_PAGES, DRUM_PARAMS, DRUM_PRESETS } from './Drum';
import { Synth, SYNTH_PAGES, SYNTH_PARAMS, SYNTH_PRESETS } from './Synth';

export interface InstrumentEntry {
  name: string;
  params: readonly ParamSpec[];
  /** Sound design pages: up to 12 param ids each (2 rows of 6 knobs). */
  pages: readonly { name: string; ids: readonly string[] }[];
  presets: readonly Preset[];
  /** Drum voices use the step strip; pitched instruments get a keyboard. */
  drum: boolean;
  create: (sampleRate: number) => Instrument;
}

export const INSTRUMENTS: Record<SoundKind, InstrumentEntry> = {
  drum: { name: 'DRUM', params: DRUM_PARAMS, pages: DRUM_PAGES, presets: DRUM_PRESETS, drum: true, create: (sr) => new Drum(sr) },
  synth: { name: 'SYNTH', params: SYNTH_PARAMS, pages: SYNTH_PAGES, presets: SYNTH_PRESETS, drum: false, create: (sr) => new Synth(sr) },
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
