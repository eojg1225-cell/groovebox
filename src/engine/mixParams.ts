import type { ParamSpec } from './params';

/** Per-channel mixer parameters. */
export const MIX_PARAMS: readonly ParamSpec[] = [
  { id: 'volume', name: 'VOLUME', min: 0, max: 1, defaultValue: 0.8, unit: '', curve: 'linear' },
  { id: 'pan', name: 'PAN', min: -1, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'cutoff', name: 'CUTOFF', min: 40, max: 20000, defaultValue: 20000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'send', name: 'SEND LVL', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
];

export type MixId = 'volume' | 'pan' | 'cutoff' | 'send';

/** Project-wide parameters (GLOBAL page; TEMPO and LO-FI also have master knobs). */
export const GLOBAL_PARAMS: readonly ParamSpec[] = [
  { id: 'bpm', name: 'TEMPO', min: 60, max: 200, defaultValue: 128, unit: '', curve: 'linear', decimals: 1 },
  { id: 'swing', name: 'SWING', min: 50, max: 75, defaultValue: 50, unit: '%', curve: 'linear', decimals: 0 },
  { id: 'master', name: 'MASTER', min: 0, max: 1, defaultValue: 0.8, unit: '', curve: 'linear' },
  { id: 'lofi', name: 'LO-FI', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
];

/** The two controls of each effect inside a send. */
export const EFFECT_WET: ParamSpec = { id: 'wet', name: 'WET', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' };
export const EFFECT_INTENSITY: ParamSpec = { id: 'int', name: 'INTENSITY', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' };
