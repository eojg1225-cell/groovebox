/**
 * Instrument registry: one table entry per instrument kind. Adding an instrument means
 * one class plus one entry here.
 */
import type { Instrument } from './Instrument';
import type { InstrumentKind } from '../engine/project';
import type { ParamSpec } from '../engine/params';
import { Kick, KICK_PARAMS } from './Kick';
import { Snare, SNARE_PARAMS } from './Snare';
import { Hat, HAT_PARAMS } from './Hat';
import { Bass, BASS_PARAMS } from './Bass';

interface Entry {
  name: string;
  params: readonly ParamSpec[];
  /** Drum voices use the step strip; pitched instruments get a keyboard. */
  drum: boolean;
  /** Bottom note of the keyboard for pitched instruments. */
  baseNote: number;
  create: (sampleRate: number) => Instrument;
}

export const INSTRUMENTS: Record<Exclude<InstrumentKind, 'none'>, Entry> = {
  kick: { name: 'KICK', params: KICK_PARAMS, drum: true, baseNote: 36, create: (sr) => new Kick(sr) },
  snare: { name: 'SNARE', params: SNARE_PARAMS, drum: true, baseNote: 36, create: (sr) => new Snare(sr) },
  hat: { name: 'HAT', params: HAT_PARAMS, drum: true, baseNote: 36, create: (sr) => new Hat(sr) },
  bass: { name: 'BASS', params: BASS_PARAMS, drum: false, baseNote: 36, create: (sr) => new Bass(sr) },
};

export function instrumentParams(kind: InstrumentKind): readonly ParamSpec[] {
  return kind === 'none' ? [] : INSTRUMENTS[kind].params;
}

export function instrumentName(kind: InstrumentKind): string {
  return kind === 'none' ? '---' : INSTRUMENTS[kind].name;
}

export function isDrum(kind: InstrumentKind): boolean {
  return kind === 'none' || INSTRUMENTS[kind].drum;
}
