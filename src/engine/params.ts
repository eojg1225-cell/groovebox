/**
 * Generic parameter description. Instruments and effects expose a list of these so
 * the UI (and later, hardware) can map controls generically.
 *
 * Controls always speak in normalised 0..1; the engine works in real units.
 */
export type ParamCurve = 'linear' | 'exp';

export interface ParamSpec {
  /** Stable id, unique within its owner (e.g. "freq"). */
  readonly id: string;
  /** Short display name, upper-case friendly for the pixel screen. */
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  readonly unit: string;
  /** "exp" for frequencies and times (min must be > 0). */
  readonly curve: ParamCurve;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Normalised 0..1 -> real value. */
export function toValue(spec: ParamSpec, norm: number): number {
  const n = clamp(norm, 0, 1);
  if (spec.curve === 'exp') return spec.min * Math.pow(spec.max / spec.min, n);
  return spec.min + (spec.max - spec.min) * n;
}

/** Real value -> normalised 0..1. */
export function toNorm(spec: ParamSpec, value: number): number {
  const v = clamp(value, spec.min, spec.max);
  if (spec.curve === 'exp') return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  return (v - spec.min) / (spec.max - spec.min);
}

/** Compact value text for the pixel screen, e.g. "220HZ", "0.50", "12MS". */
export function formatValue(spec: ParamSpec, value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits) + spec.unit;
}
