/**
 * Candidate sounds for the lab: what TIMBRE / INT produce under a candidate's rules. A = the
 * app now (macros.ts as it is); a candidate lists its own five TIMBRE sounds, each of which
 * may carry its own INT 0 (`soft`) and INT 100 (`hard`) versions, the plain values being
 * INT 50. A parameter a sound gives no soft / hard value for follows the candidate's
 * `excite` rules (macros.ts Excite) or stays as at INT 50.
 */
import { toNorm, toValue, type ParamSpec } from '../../src/engine/params';
import type { SoundKind } from '../../src/engine/project';
import { excited, macroIds, macroSound, MACROS, type Anchor, type Excite } from '../../src/instruments/macros';
import { INSTRUMENTS } from '../../src/instruments/registry';

export interface LabAnchor extends Anchor {
  /** Values at INT 0 (the soft end). */
  soft?: Record<string, number>;
  /** Values at INT 100 (the extreme end). */
  hard?: Record<string, number>;
}

export interface Candidate {
  /** Short name on the button. */
  name: string;
  /** One or two sentences: what is different. */
  note: string;
  anchors: readonly LabAnchor[];
  /** INT rules for parameters without soft / hard values (none = they stay as at INT 50). */
  excite?: readonly Excite[];
}

/** One TIMBRE sound at INT x: soft -> values -> hard, each on the parameter's own curve. */
function anchorAt(a: LabAnchor, x: number, excite: readonly Excite[], specs: readonly ParamSpec[], base: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  const ids = new Set([...Object.keys(a.values), ...Object.keys(a.soft ?? {}), ...Object.keys(a.hard ?? {})]);
  for (const id of ids) {
    const spec = specs.find((p) => p.id === id);
    if (!spec) continue;
    const mid = a.values[id] ?? base[id] ?? spec.defaultValue;
    const end = x < 0.5 ? a.soft?.[id] : a.hard?.[id];
    if (end !== undefined) {
      const f = x < 0.5 ? 1 - 2 * x : 2 * x - 1;
      out[id] = toValue(spec, toNorm(spec, mid) + (toNorm(spec, end) - toNorm(spec, mid)) * f);
      continue;
    }
    const e = excite.find((r) => r.id === id);
    out[id] = e ? excited(e, spec, mid, x) : mid;
  }
  return out;
}

/** The candidate's TIMBRE / INT sound (the parameters it sets only). */
function candidateValues(c: Candidate, kind: SoundKind, timbre: number, intensity: number, base: Record<string, number>): Record<string, number> {
  const specs = INSTRUMENTS[kind].params;
  const n = c.anchors.length - 1;
  const t = Math.min(1, Math.max(0, timbre)) * n;
  const i0 = Math.min(n - 1, Math.floor(t));
  const f = t - i0;
  const x = Math.min(1, Math.max(0, intensity));
  const a = anchorAt(c.anchors[i0], x, c.excite ?? [], specs, base);
  const b = anchorAt(c.anchors[i0 + 1], x, c.excite ?? [], specs, base);
  const out: Record<string, number> = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const spec = specs.find((p) => p.id === id)!;
    const va = a[id] ?? b[id];
    const vb = b[id] ?? a[id];
    out[id] = toValue(spec, toNorm(spec, va) + (toNorm(spec, vb) - toNorm(spec, va)) * f);
  }
  return out;
}

/** Every parameter a candidate (null = A, the app) sets through TIMBRE / INT. */
export function candidateIds(kind: SoundKind, c: Candidate | null): Set<string> {
  const specs = INSTRUMENTS[kind].params;
  if (!c) return macroIds(kind, specs);
  const ids = new Set<string>();
  for (const a of c.anchors) for (const v of [a.values, a.soft ?? {}, a.hard ?? {}]) for (const id in v) if (specs.some((p) => p.id === id)) ids.add(id);
  return ids;
}

/** The full sound: the track's own settings (`base`) under the TIMBRE / INT values. */
export function labSound(kind: SoundKind, c: Candidate | null, timbre: number, intensity: number, base: Record<string, number>): Record<string, number> {
  const values = c ? candidateValues(c, kind, timbre, intensity, base) : macroSound(kind, timbre, intensity, INSTRUMENTS[kind].params);
  return { ...base, ...values, timbre, intensity };
}

/** The TIMBRE sounds' names for a candidate (null = A). */
export function anchorNames(kind: SoundKind, c: Candidate | null): string[] {
  return (c ? c.anchors : MACROS[kind].anchors).map((a) => a.name);
}
