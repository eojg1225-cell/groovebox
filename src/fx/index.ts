import type { ParamSpec } from '../engine/params';
import { DELAY_PARAMS } from './Delay';
import { DIST_PARAMS } from './Distortion';
import { MIDCUT_PARAMS } from './MidCut';

/** The three send effects, in send order (send 1 = delay, 2 = distortion, 3 = mid-cut). */
export const SEND_NAMES = ['DLY', 'DIST', 'MID'] as const;

export const FX_PARAMS: readonly ParamSpec[] = [...DELAY_PARAMS, ...DIST_PARAMS, ...MIDCUT_PARAMS];

/** FX page: row 1 delay + distortion, row 2 mid-cut + the three returns. */
export const FX_PAGE_IDS = [
  'dly_time', 'dly_fdbk', 'dly_tone', 'dst_drive', 'dst_tone', 'dst_char',
  'mid_freq', 'mid_width', 'mid_depth', 'dly_return', 'dst_return', 'mid_return',
];

export function defaultFx(): Record<string, number> {
  const fx: Record<string, number> = {};
  for (const p of FX_PARAMS) fx[p.id] = p.defaultValue;
  return fx;
}
