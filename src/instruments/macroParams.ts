import type { ParamSpec } from '../engine/params';

/**
 * The two macro knobs every track type has (see macros.ts). They are stored with the
 * sound like any parameter; the instruments themselves ignore them.
 */
export const TIMBRE: ParamSpec = { id: 'timbre', name: 'TIMBRE', min: 0, max: 1, defaultValue: 0.33, unit: '', curve: 'linear' };
/** MID FREQ: the centre of the track's MID CUT (MIX, FUNC); the engine reads it, per type default. */
export function midFreq(defaultValue: number): ParamSpec {
  return { id: 'midfreq', name: 'MID FREQ', min: 150, max: 6000, defaultValue, unit: 'HZ', curve: 'exp', decimals: 0 };
}
export const INTENSITY: ParamSpec = { id: 'intensity', name: 'INT', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' };
