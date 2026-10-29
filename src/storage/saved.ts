/**
 * USER patches saved by older versions (localStorage), still offered by PRESET. Nothing
 * writes new ones (patches now live in each pattern).
 */
import type { SoundKind } from '../engine/project';
import { INSTRUMENTS, pageParams } from '../instruments/registry';
import { deriveTrims, hiddenSound, pruneTrims } from '../instruments/trims';
import { drumsV43, hatV44, kickV47, percV46, rollRateV56 } from '../engine/projectFile';

const PATCHES_KEY = 'groovebox.patches';

interface UserPatch {
  name: string;
  values: Record<string, number>;
  live: [string, string];
  /** LIVE 3 / 4 (FUNC); absent in patches saved before FUNC. */
  liveFunc?: [string, string];
  /** SOUND page trims on top of TIMBRE / INTENSITY (absent before v17: derived on load). */
  trims?: Record<string, number>;
  /** Format version (40 = upgraded in October 2026: values and trims as they load). */
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

/** A USER patch as it loads: the full sound, its trims and live knobs. */
interface LoadedPatch {
  sound: Record<string, number>;
  trims: Record<string, number>;
  live: [string, string];
  liveFunc?: [string, string];
}

/**
 * A patch as it loads: its values over the defaults, its trims (derived when it has none),
 * pruned to the page. Patches from before v40 that never went through the upgrade load
 * their values as stored.
 */
export function readUserPatch(kind: SoundKind, patch: UserPatch): LoadedPatch {
  const params = INSTRUMENTS[kind].params;
  const sound: Record<string, number> = {};
  for (const p of params) sound[p.id] = p.defaultValue;
  for (const p of params) if (typeof patch.values[p.id] === 'number') sound[p.id] = patch.values[p.id];
  if (typeof patch.values.rolldiv === 'number') rollRateV56(sound); // USER patches all predate v56
  // USER patches all predate v43 (and the v44 RIDE, the v45 TIMBALE, the v46 PERC order: a
  // HAT / PERC is rebuilt from the new sounds; a v47 KICK keeps its sound).
  const trims = patch.trims ? { ...patch.trims } : kind === 'hat' || kind === 'perc' ? {} : deriveTrims(kind, sound, params);
  if (patch.trims) drumsV43(kind, sound, trims);
  hatV44(kind, sound, trims);
  percV46(kind, sound, trims);
  kickV47(kind, sound, trims);
  pruneTrims(sound, trims, hiddenSound(kind, sound, params), pageParams(kind));
  const out: LoadedPatch = { sound, trims, live: [...patch.live] };
  if (patch.liveFunc) out.liveFunc = [...patch.liveFunc];
  return out;
}
