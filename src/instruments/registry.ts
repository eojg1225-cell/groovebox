/**
 * Instrument registry: one table entry per track type. Adding a type means one entry
 * here (plus a class if it needs new DSP).
 */
import type { Instrument, Preset } from './Instrument';
import type { InstrumentKind, SoundKind } from '../engine/project';
import type { ParamSpec } from '../engine/params';
import { macroSound } from './macros';
import {
  Drum, HAT_DETAIL, HAT_ELEMENTS, HAT_PARAMS, HAT_PRESETS, KICK_DETAIL, KICK_ELEMENTS, KICK_PARAMS, KICK_PRESETS,
  SNARE_DETAIL, SNARE_ELEMENTS, SNARE_PARAMS, SNARE_PRESETS,
} from './Drum';
import {
  BASS_DETAIL, BASS_FIXED, BASS_PARAMS, BASS_PRESETS, LEAD_DETAIL, LEAD_FIXED, LEAD_PARAMS, LEAD_PRESETS,
  PAD_DETAIL, PAD_FIXED, PAD_PARAMS, PAD_PRESETS, SYNTH_ELEMENTS, Synth,
} from './Synth';

/**
 * The SOUND page, the same shape for every track type. One column per module (top knob /
 * bottom knob): 1 TIMBRE / INTENSITY, 2 element 1 ATTACK / DECAY, 3 element 2 ATTACK /
 * DECAY, 4 FILTER / RESO, 5 FILTER ATTACK / DECAY, 6 DRIVE / CRUSH.
 * Elements: KICK tone + click, SNARE tone + metal, HAT click + metal, synths OSC 1 + OSC 2.
 */
export function soundPage(elements: readonly string[]): string[] {
  const [a1, d1, a2, d2] = elements;
  return [
    'timbre', a1, a2, 'cutoff', 'fattack', 'drive',
    'intensity', d1, d2, 'reso', 'fdecay', 'crush',
  ];
}

export interface InstrumentEntry {
  name: string;
  /** All of the type's parameters (stored, set by presets, lockable). */
  params: readonly ParamSpec[];
  /**
   * Sound design pages: SOUND (soundPage) and DETAIL, 12 knob slots each (2 rows of 6).
   * Ids are the type's params, or "track:chord" for the chord setting; null = empty.
   */
  layout: readonly (string | null)[];
  detail: readonly (string | null)[];
  presets: readonly Preset[];
  /** Drum voices use the step strip when recording; pitched types get a keyboard. */
  drum: boolean;
  /** Lowest note on the keyboard (an A, so the strip starts on A). */
  baseNote: number;
  create: (sampleRate: number) => Instrument;
}

export const INSTRUMENTS: Record<SoundKind, InstrumentEntry> = {
  kick: { name: 'KICK', params: KICK_PARAMS, layout: soundPage(KICK_ELEMENTS), detail: KICK_DETAIL, presets: KICK_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, KICK_PARAMS) },
  snare: { name: 'SNARE', params: SNARE_PARAMS, layout: soundPage(SNARE_ELEMENTS), detail: SNARE_DETAIL, presets: SNARE_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, SNARE_PARAMS) },
  hat: { name: 'HAT', params: HAT_PARAMS, layout: soundPage(HAT_ELEMENTS), detail: HAT_DETAIL, presets: HAT_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, HAT_PARAMS) },
  bass: { name: 'BASS', params: BASS_PARAMS, layout: soundPage(SYNTH_ELEMENTS), detail: BASS_DETAIL, presets: BASS_PRESETS, drum: false, baseNote: 33, create: (sr) => new Synth(sr, BASS_PARAMS, BASS_FIXED) },
  pad: { name: 'PAD', params: PAD_PARAMS, layout: soundPage(SYNTH_ELEMENTS), detail: PAD_DETAIL, presets: PAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PAD_PARAMS, PAD_FIXED) },
  lead: { name: 'LEAD', params: LEAD_PARAMS, layout: soundPage(SYNTH_ELEMENTS), detail: LEAD_DETAIL, presets: LEAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, LEAD_PARAMS, LEAD_FIXED) },
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
