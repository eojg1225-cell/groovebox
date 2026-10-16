import type { ParamSpec } from '../engine/params';
import { DELAY_PARAMS } from './Delay';
import { DIST_PARAMS } from './Distortion';
import { MIDCUT_PARAMS } from './MidCut';
import { CHORUS_PARAMS } from './Chorus';
import { REVERB_PARAMS } from './Reverb';
import { FLANGER_PARAMS } from './Flanger';

/**
 * The six send effects, in send order: each track has one send level per effect.
 * `prefix` routes parameter ids to the effect.
 */
export const EFFECTS = [
  { name: 'DELAY', short: 'DLY', prefix: 'dly_', params: DELAY_PARAMS },
  { name: 'DISTORT', short: 'DST', prefix: 'dst_', params: DIST_PARAMS },
  { name: 'MID CUT', short: 'MID', prefix: 'mid_', params: MIDCUT_PARAMS },
  { name: 'CHORUS', short: 'CHO', prefix: 'cho_', params: CHORUS_PARAMS },
  { name: 'REVERB', short: 'REV', prefix: 'rev_', params: REVERB_PARAMS },
  { name: 'FLANGER', short: 'FLG', prefix: 'flg_', params: FLANGER_PARAMS },
] as const;

export const FX_PARAMS: readonly ParamSpec[] = EFFECTS.flatMap((e) => e.params);

export function defaultFx(): Record<string, number> {
  const fx: Record<string, number> = {};
  for (const p of FX_PARAMS) fx[p.id] = p.defaultValue;
  return fx;
}
