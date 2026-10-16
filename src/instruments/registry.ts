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
  create: (sampleRate: number) => Instrument;
}

export const INSTRUMENTS: Record<Exclude<InstrumentKind, 'none'>, Entry> = {
  kick: { name: 'KICK', params: KICK_PARAMS, create: (sr) => new Kick(sr) },
  snare: { name: 'SNARE', params: SNARE_PARAMS, create: (sr) => new Snare(sr) },
  hat: { name: 'HAT', params: HAT_PARAMS, create: (sr) => new Hat(sr) },
  bass: { name: 'BASS', params: BASS_PARAMS, create: (sr) => new Bass(sr) },
};

export function instrumentParams(kind: InstrumentKind): readonly ParamSpec[] {
  return kind === 'none' ? [] : INSTRUMENTS[kind].params;
}

export function instrumentName(kind: InstrumentKind): string {
  return kind === 'none' ? '---' : INSTRUMENTS[kind].name;
}
