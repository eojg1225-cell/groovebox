import type { SoundKind } from '../engine/project';
import { toNorm, toValue, type ParamSpec } from '../engine/params';
import { macroIds, macroSound } from './macros';

/**
 * The SOUND page sits on top of TIMBRE / INTENSITY: a page knob on a parameter that the
 * macros also set is stored as a TRIM - its distance from the macro value, normalised on
 * the parameter's own curve - so moving TIMBRE / INTENSITY later keeps the adjustment
 * (a darker CUTOFF stays darker on the next sound). Values clamp at the parameter's limits;
 * the trim itself is kept. Pure functions.
 */

/** The hidden layer: what TIMBRE / INTENSITY make of this sound. */
export function hiddenSound(kind: SoundKind, sound: Record<string, number>, specs: readonly ParamSpec[]): Record<string, number> {
  return macroSound(kind, sound.timbre ?? 0.33, sound.intensity ?? 0.5, specs);
}

export function applyTrim(spec: ParamSpec, hidden: number, trim: number | undefined): number {
  if (!trim) return hidden;
  const n = toNorm(spec, hidden) + trim;
  return toValue(spec, n < 0 ? 0 : n > 1 ? 1 : n);
}

/** The trim that makes `value` out of `hidden` (0 when they match). */
export function trimFor(spec: ParamSpec, value: number, hidden: number): number {
  const t = toNorm(spec, value) - toNorm(spec, hidden);
  return Math.abs(t) < 1e-6 ? 0 : t;
}

/** Trims that reproduce a sound's current values on top of its TIMBRE / INTENSITY. */
export function deriveTrims(kind: SoundKind, sound: Record<string, number>, specs: readonly ParamSpec[]): Record<string, number> {
  const hidden = hiddenSound(kind, sound, specs);
  const out: Record<string, number> = {};
  for (const id of macroIds(kind, specs)) {
    const spec = specs.find((p) => p.id === id);
    if (!spec || sound[id] === undefined || hidden[id] === undefined) continue;
    const t = trimFor(spec, sound[id], hidden[id]);
    if (t !== 0) out[id] = t;
  }
  return out;
}
