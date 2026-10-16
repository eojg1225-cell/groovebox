import type { ParamSpec } from './params';

/** Per-channel mixer parameters (MIX page). */
export const MIX_PARAMS: readonly ParamSpec[] = [
  { id: 'volume', name: 'VOLUME', min: 0, max: 1, defaultValue: 0.8, unit: '', curve: 'linear' },
  { id: 'pan', name: 'PAN', min: -1, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
];

/** Project-wide parameters (GLOBAL page). */
export const GLOBAL_PARAMS: readonly ParamSpec[] = [
  { id: 'bpm', name: 'BPM', min: 60, max: 200, defaultValue: 128, unit: '', curve: 'linear', decimals: 1 },
  { id: 'swing', name: 'SWING', min: 50, max: 75, defaultValue: 50, unit: '%', curve: 'linear', decimals: 0 },
  { id: 'master', name: 'MASTER', min: 0, max: 1, defaultValue: 0.8, unit: '', curve: 'linear' },
];
