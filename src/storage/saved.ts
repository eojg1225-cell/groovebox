/**
 * USER patches saved by older versions (localStorage), still offered by PRESET. Nothing
 * writes new ones (patches now live in each pattern).
 */
import type { SoundKind } from '../engine/project';

const PATCHES_KEY = 'groovebox.patches';

interface UserPatch {
  name: string;
  values: Record<string, number>;
  live: [string, string];
  /** LIVE 3 / 4 (FUNC); absent in patches saved before FUNC. */
  liveFunc?: [string, string];
  /** SOUND page trims on top of TIMBRE / INTENSITY (absent before v17: derived on load). */
  trims?: Record<string, number>;
  /** Format: 19 = five TIMBRE sounds per type (absent: four; TIMBRE is remapped on load); 33 = OCTAVE -4 ... +4. */
  v?: number;
}

type PatchStore = Partial<Record<SoundKind, UserPatch[]>>;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}


export function userPatches(kind: SoundKind): UserPatch[] {
  return read<PatchStore>(PATCHES_KEY)?.[kind] ?? [];
}

/** Saves a patch as the next USER n for its track type; returns its name, or null on failure. */
