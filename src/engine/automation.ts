/**
 * SONG automation: knob values locked at positions of the song, one lane per knob, played back
 * while the song plays (gliding from one locked value to the next; choice knobs jump).
 *
 * A position counts strip cells from the song's first bar: bar x 16 + step (0-15, the cell on
 * the strip; a time signature's dark cells are simply never reached). A lane's key names its
 * knob: s:<track>:<sound param>, m:<track>:<mix id>, o:<track>:<live id> (a relative live knob,
 * -1..1), b:<bus 0-2>:<bus param>, l:<lfo param>.
 */
import { toNorm, toValue, type ParamSpec } from './params';

export const CELLS_PER_BAR = 16;

export type AutoKind = 's' | 'm' | 'o' | 'b' | 'l';

interface AutoTarget {
  kind: AutoKind;
  /** Track (s, m, o) or bus (b); 0 for the LFO. */
  index: number;
  id: string;
}

export function parseAutoKey(key: string): AutoTarget | null {
  const m = /^([smob]):(\d+):(.+)$/.exec(key) ?? /^(l):()(.+)$/.exec(key);
  if (!m) return null;
  return { kind: m[1] as AutoKind, index: m[2] ? Number(m[2]) : 0, id: m[3] };
}

/**
 * A lane's value at position p: NaN before its first point (the knob plays as set), the last
 * value after its last; in between a glide (in the knob's own scale; with no spec, straight),
 * or for a choice knob the earlier value.
 */
export function valueAt(pos: ArrayLike<number>, val: ArrayLike<number>, n: number, p: number, spec: ParamSpec | null): number {
  if (n === 0 || p < pos[0]) return NaN;
  if (p >= pos[n - 1]) return val[n - 1];
  let i = 0;
  while (i < n - 2 && p >= pos[i + 1]) i++;
  const a = val[i];
  const b = val[i + 1];
  if (spec?.options || spec?.coarse) return a;
  const f = (p - pos[i]) / (pos[i + 1] - pos[i]);
  if (!spec) return a + (b - a) * f;
  const na = toNorm(spec, a);
  return toValue(spec, na + (toNorm(spec, b) - na) * f);
}
