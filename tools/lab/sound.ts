/**
 * Candidate sounds for the lab: what TIMBRE / INT produce under a candidate's rules, by the
 * app's own code (macros.ts macroSoundOf). A = the app now (MACROS); a candidate brings its
 * own five TIMBRE sounds (each may carry its own INT 0 `soft` / INT 100 `hard` values) and
 * INT rules (`excite`, for parameters without soft / hard values).
 */
import type { SoundKind } from '../../src/engine/project';
import { macroIds, macroSound, macroSoundOf, MACROS, type MacroDef } from '../../src/instruments/macros';
import { INSTRUMENTS } from '../../src/instruments/registry';

export interface Candidate extends MacroDef {
  /** Short name on the button. */
  name: string;
  /** One or two sentences: what is different. */
  note: string;
}

/** Every parameter a candidate (null = A, the app) sets through TIMBRE / INT. */
export function candidateIds(kind: SoundKind, c: Candidate | null): Set<string> {
  const specs = INSTRUMENTS[kind].params;
  if (!c) return macroIds(kind, specs);
  const ids = new Set<string>();
  for (const a of c.anchors) for (const id in a.values) if (specs.some((p) => p.id === id)) ids.add(id);
  return ids;
}

/** The full sound: the track's own settings (`base`) under the TIMBRE / INT values. */
export function labSound(kind: SoundKind, c: Candidate | null, timbre: number, intensity: number, base: Record<string, number>): Record<string, number> {
  const specs = INSTRUMENTS[kind].params;
  const values = c ? macroSoundOf(c, kind, timbre, intensity, specs) : macroSound(kind, timbre, intensity, specs);
  return { ...base, ...values, timbre, intensity };
}

/** The TIMBRE sounds' names for a candidate (null = A). */
export function anchorNames(kind: SoundKind, c: Candidate | null): string[] {
  return (c ? c.anchors : MACROS[kind].anchors).map((a) => a.name);
}
