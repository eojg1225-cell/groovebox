/**
 * USER patches saved by older versions (localStorage), still offered by PRESET. Nothing
 * writes new ones (patches now live in each pattern).
 */
import { PROJECT_VERSION, type SoundKind } from '../engine/project';
import { bassFilterV38 } from '../engine/projectFile';
import { remapBassTimbreV39, remapTimbreV18 } from '../instruments/macros';
import { INSTRUMENTS, mirrorOsc2, pageParams } from '../instruments/registry';
import { OCTAVE_SHIFT_V33 } from '../instruments/Synth';
import { deriveTrims, hiddenSound, pruneTrims } from '../instruments/trims';

const PATCHES_KEY = 'groovebox.patches';

interface UserPatch {
  name: string;
  values: Record<string, number>;
  live: [string, string];
  /** LIVE 3 / 4 (FUNC); absent in patches saved before FUNC. */
  liveFunc?: [string, string];
  /** SOUND page trims on top of TIMBRE / INTENSITY (absent before v17: derived on load). */
  trims?: Record<string, number>;
  /**
   * Format: absent = four TIMBRE sounds per type, 19 = five, 33 = OCTAVE -4 ... +4,
   * PROJECT_VERSION = upgraded (upgradeUserPatches): values and trims as they load.
   */
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

/** A USER patch as it loads now: the full sound, its trims and live knobs. */
interface LoadedPatch {
  sound: Record<string, number>;
  trims: Record<string, number>;
  live: [string, string];
  liveFunc?: [string, string];
}

/** Brings a patch saved by any version up to now (the load migrations). */
export function readUserPatch(kind: SoundKind, patch: UserPatch): LoadedPatch {
  const params = INSTRUMENTS[kind].params;
  const defaults: Record<string, number> = {};
  for (const p of params) defaults[p.id] = p.defaultValue;
  const values = { ...patch.values };
  const v = patch.v ?? 0;
  let trims = patch.trims ? { ...patch.trims } : undefined;
  if (v < PROJECT_VERSION) {
    mirrorOsc2(values);
    // Patches saved with four TIMBRE sounds: move TIMBRE, re-derive the trims.
    const old = v < 19;
    if (old && values.timbre !== undefined) values.timbre = remapTimbreV18(kind, values.timbre);
    // BASS patches from before v40: its sounds were in another order (the same sound).
    const bassOrder = kind === 'bass' && !old && v < 40;
    if (bassOrder && values.timbre !== undefined) values.timbre = remapBassTimbreV39(values.timbre);
    // A BASS patch from v27 - v37: its filter envelope followed the amp (now its own).
    if (kind === 'bass' && values.fratio !== undefined) bassFilterV38(values);
    // Every USER patch predates v33's wider OCTAVE: the same octave, two indices up.
    if (v < 33 && values.octave !== undefined) values.octave += OCTAVE_SHIFT_V33;
    if (old || bassOrder) trims = undefined;
  }
  const sound = { ...defaults, ...values };
  trims ??= deriveTrims(kind, sound, params);
  pruneTrims(sound, trims, hiddenSound(kind, sound, params), pageParams(kind));
  const out: LoadedPatch = { sound, trims, live: [...patch.live] };
  if (patch.liveFunc) out.liveFunc = [...patch.liveFunc];
  return out;
}

/**
 * Rewrites every USER patch saved by an older version as it loads now (format
 * PROJECT_VERSION), so the load migrations for older patches can go. Returns how many.
 */
export function upgradeUserPatches(): number {
  const store = read<PatchStore>(PATCHES_KEY);
  if (!store) return 0;
  let n = 0;
  for (const kind of Object.keys(store) as SoundKind[]) {
    if (!INSTRUMENTS[kind] || !Array.isArray(store[kind])) continue;
    store[kind] = store[kind]!.map((p) => {
      if ((p.v ?? 0) >= PROJECT_VERSION) return p;
      n++;
      const now = readUserPatch(kind, p);
      return { name: p.name, values: now.sound, trims: now.trims, live: now.live, ...(now.liveFunc ? { liveFunc: now.liveFunc } : {}), v: PROJECT_VERSION };
    });
  }
  if (n > 0) {
    try {
      localStorage.setItem(PATCHES_KEY, JSON.stringify(store));
    } catch {
      return 0; // full or blocked: left as it was
    }
  }
  return n;
}
