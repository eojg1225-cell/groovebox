/**
 * Generic parameter description. Instruments and effects expose a list of these so
 * the UI (and later, hardware) can map controls generically.
 *
 * Controls always speak in normalised 0..1; the engine works in real units.
 */
/**
 * linear; exp (frequencies, times; min > 0); square (from 0, fine at the low end: glide);
 * power (min + range x n^power: like exp, a chosen value at the knob's middle).
 */
export type ParamCurve = 'linear' | 'exp' | 'square' | 'power';

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
  /** The exponent of a 'power' curve. */
  readonly power?: number;
  /** Decimal places for display; automatic when omitted. */
  readonly decimals?: number;
  /**
   * Discrete choices: value is the index (min 0, max options.length - 1), shown by name.
   */
  readonly options?: readonly string[];
  /**
   * Coarse settings (waveforms, modes, types) are only editable in the sound design
   * mode; live knobs can only be assigned non-coarse parameters.
   */
  readonly coarse?: boolean;
}

/** Shorthand for a discrete, coarse parameter. */
export function choice(id: string, name: string, options: readonly string[], defaultValue = 0): ParamSpec {
  return { id, name, min: 0, max: options.length - 1, defaultValue, unit: '', curve: 'linear', options, coarse: true };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** FILTER DECAY's curve: 2 ms .. 10 s with 1 s at the middle of the knob. */
export const FDECAY_POWER = Math.log((1 - 0.002) / (10 - 0.002)) / Math.log(0.5);

/** Normalised 0..1 -> real value. */
export function toValue(spec: ParamSpec, norm: number): number {
  const n = clamp(norm, 0, 1);
  if (spec.options) return Math.round(n * (spec.options.length - 1));
  if (spec.curve === 'exp') return spec.min * Math.pow(spec.max / spec.min, n);
  if (spec.curve === 'square') return spec.min + (spec.max - spec.min) * n * n;
  if (spec.curve === 'power') return spec.min + (spec.max - spec.min) * Math.pow(n, spec.power ?? 2);
  return spec.min + (spec.max - spec.min) * n;
}

/** Real value -> normalised 0..1. */
export function toNorm(spec: ParamSpec, value: number): number {
  const v = clamp(value, spec.min, spec.max);
  if (spec.curve === 'exp') return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  if (spec.curve === 'square') return Math.sqrt((v - spec.min) / (spec.max - spec.min));
  if (spec.curve === 'power') return Math.pow((v - spec.min) / (spec.max - spec.min), 1 / (spec.power ?? 2));
  return (v - spec.min) / (spec.max - spec.min);
}

/** Compact value text for the pixel screen, e.g. "220HZ", "0.50", "12MS". */
export function formatValue(spec: ParamSpec, value: number): string {
  if (spec.options) return spec.options[Math.round(clamp(value, 0, spec.options.length - 1))];
  const abs = Math.abs(value);
  const digits = spec.decimals ?? (abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  return value.toFixed(digits) + spec.unit;
}
