/**
 * Saved patches and project, kept in localStorage so they survive closing the browser.
 * (The working session also lives in sessionStorage; see session.ts.)
 */
import type { Project, SoundKind } from '../engine/project';
import { fromStored, toStored } from '../engine/projectFile';

const PATCHES_KEY = 'groovebox.patches';
const PROJECT_KEY = 'groovebox.project';
export const MAX_USER_PATCHES = 16;

export interface UserPatch {
  name: string;
  values: Record<string, number>;
  live: [string, string];
  /** LIVE 3 / 4 (FUNC); absent in patches saved before FUNC. */
  liveFunc?: [string, string];
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

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // storage full or blocked
  }
}

export function userPatches(kind: SoundKind): UserPatch[] {
  return read<PatchStore>(PATCHES_KEY)?.[kind] ?? [];
}

/** Saves a patch as the next USER n for its track type; returns its name, or null on failure. */
export function savePatch(kind: SoundKind, values: Record<string, number>, live: [string, string], liveFunc: [string, string]): string | null {
  const store = read<PatchStore>(PATCHES_KEY) ?? {};
  const list = store[kind] ?? [];
  if (list.length >= MAX_USER_PATCHES) list.shift();
  const used = new Set(list.map((p) => p.name));
  let n = 1;
  while (used.has(`USER ${n}`)) n++;
  const name = `USER ${n}`;
  list.push({ name, values: { ...values }, live: [...live], liveFunc: [...liveFunc] });
  store[kind] = list;
  return write(PATCHES_KEY, store) ? name : null;
}

export function saveProject(project: Project): boolean {
  return write(PROJECT_KEY, toStored(project));
}

export function loadSavedProject(): Project | null {
  return fromStored(read<unknown>(PROJECT_KEY));
}
