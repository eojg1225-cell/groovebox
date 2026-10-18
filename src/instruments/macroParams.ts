import type { ParamSpec } from '../engine/params';

/**
 * The two macro knobs every track type has (see macros.ts). They are stored with the
 * sound like any parameter; the instruments themselves ignore them.
 */
export const TIMBRE: ParamSpec = { id: 'timbre', name: 'TIMBRE', min: 0, max: 1, defaultValue: 0.33, unit: '', curve: 'linear' };
export const INTENSITY: ParamSpec = { id: 'intensity', name: 'INT', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' };
