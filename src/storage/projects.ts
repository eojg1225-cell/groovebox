/**
 * Projects: 64 slots (4 banks of 16) of named, saved projects, each with its own working
 * copy (unsaved edits, so switching never loses work). Kept in localStorage behind the
 * ProjectStore interface, so a cloud store can take its place later: records are keyed by
 * a fixed random id, the slot is just where an id sits.
 */
import { NUM_PATTERNS, PROJECT_VERSION, cloneNotes, clonePatch, patchOf, type Project } from '../engine/project';
import { fromStored, toStored } from '../engine/projectFile';

export const SLOTS_PER_BANK = 16;
export const PROJECT_BANKS = 4;
export const PROJECT_SLOTS = SLOTS_PER_BANK * PROJECT_BANKS;
export const NAME_LENGTH = 16;

export interface SlotEntry {
  id: string;
  name: string;
  savedAt: number;
}

export interface ProjectStore {
  /** Every slot: its project, or null when empty. */
  slots(): (SlotEntry | null)[];
  /** Save into a slot (replacing whatever is there); keeps `id` when given. Null = failed (full). */
  save(slot: number, name: string, project: Project, id?: string): SlotEntry | null;
  /** The saved project. */
  load(id: string): Project | null;
  /** Its working copy (unsaved edits), if any. */
  loadWork(id: string): Project | null;
  saveWork(id: string, project: Project): void;
  /** Empty a slot (its saved project and working copy go). */
  remove(slot: number): void;
  /** The project open now (null = not saved anywhere yet). */
  openId(): string | null;
  setOpen(id: string | null): void;
}

/** Told after a save or delete changed a slot (oldId: the project that was there). */
type SlotListener = (slot: number, oldId: string | null) => void;
let slotListener: SlotListener | null = null;
export function onSlotChange(fn: SlotListener | null): void {
  slotListener = fn;
}

const INDEX = 'groovebox.projects';
const OPEN = 'groovebox.open';
const LEGACY = 'groovebox.project';
const data = (id: string) => `groovebox.proj.${id}`;
const work = (id: string) => `groovebox.work.${id}`;

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function put(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false; // full or blocked
  }
}

function drop(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parse(raw: string | null): Project | null {
  if (!raw) return null;
  try {
    return fromStored(JSON.parse(raw));
  } catch {
    return null;
  }
}

function storedVersion(raw: string | null): number {
  try {
    const v = (JSON.parse(raw ?? 'null') as { version?: unknown } | null)?.version;
    return typeof v === 'number' ? v : 0;
  } catch {
    return PROJECT_VERSION;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sameValues(a: Record<string, number>, b: Record<string, number>): boolean {
  for (const k in a) if (Math.abs(a[k] - (b[k] ?? NaN)) > 1e-9 || !(k in b)) return false;
  for (const k in b) if (!(k in a)) return false;
  return true;
}

/** Each pattern's saved notes / patch taken from the project's saved copy (same track type). */
export function adoptSaved(work: Project, saved: Project): void {
  work.channels.forEach((c, ch) => {
    const s = saved.channels[ch];
    if (!s || s.instrument !== c.instrument) return;
    for (let p = 0; p < NUM_PATTERNS; p++) {
      const pat = c.patterns[p];
      pat.savedNotes = cloneNotes(s.patterns[p]);
      pat.notesDirty = !same(pat.savedNotes, cloneNotes(pat));
      pat.savedPatch = clonePatch(patchOf(s, p));
      const now = patchOf(c, p);
      pat.patchDirty = !sameValues(pat.savedPatch.sound, now.sound) || !sameValues(pat.savedPatch.trims, now.trims);
    }
  });
}

class LocalProjectStore implements ProjectStore {
  slots(): (SlotEntry | null)[] {
    let list: unknown = null;
    try {
      list = JSON.parse(get(INDEX) ?? 'null');
    } catch {
      list = null;
    }
    if (!Array.isArray(list)) return this.migrate();
    return Array.from({ length: PROJECT_SLOTS }, (_, i) => {
      const e = list[i] as SlotEntry | null;
      return e && typeof e.id === 'string' ? { id: e.id, name: String(e.name ?? ''), savedAt: Number(e.savedAt) || 0 } : null;
    });
  }

  /** First run: the single project saved before slots becomes slot 1. */
  private migrate(): (SlotEntry | null)[] {
    const slots: (SlotEntry | null)[] = new Array(PROJECT_SLOTS).fill(null);
    const legacy = get(LEGACY);
    if (legacy && parse(legacy)) {
      const id = newId();
      if (put(data(id), legacy)) {
        slots[0] = { id, name: 'PROJECT 1', savedAt: Date.now() };
        if (!this.openId()) this.setOpen(id);
      }
    }
    put(INDEX, JSON.stringify(slots));
    return slots;
  }

  save(slot: number, name: string, project: Project, id = newId()): SlotEntry | null {
    const slots = this.slots();
    const old = slots[slot];
    if (!put(data(id), JSON.stringify(toStored(project)))) return null;
    if (old && old.id !== id) {
      drop(data(old.id));
      drop(work(old.id));
    }
    const entry = { id, name, savedAt: Date.now() };
    // The same project kept in one slot only.
    const moved: number[] = [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]?.id === id && i !== slot) moved.push(i);
      if (slots[i]?.id === id) slots[i] = null;
    }
    slots[slot] = entry;
    if (!put(INDEX, JSON.stringify(slots))) return null;
    this.saveWork(id, project);
    for (const i of moved) slotListener?.(i, id);
    slotListener?.(slot, old?.id ?? null);
    return entry;
  }

  /** The saved project as stored (JSON text), for the cloud copy. */
  raw(id: string): string | null {
    return get(data(id));
  }

  /**
   * Put a project (stored JSON text) into a slot as it is, savedAt kept: a copy from the
   * cloud. Whatever was in the slot goes; the project's own working copy goes too (it is
   * older than this version) unless it is the project open now.
   */
  place(slot: number, entry: SlotEntry, raw: string): boolean {
    const slots = this.slots();
    const old = slots[slot];
    if (!put(data(entry.id), raw)) return false;
    if (old && old.id !== entry.id) {
      drop(data(old.id));
      drop(work(old.id));
      if (this.openId() === old.id) this.setOpen(null);
    }
    for (let i = 0; i < slots.length; i++) if (slots[i]?.id === entry.id) slots[i] = null;
    slots[slot] = { id: entry.id, name: entry.name, savedAt: entry.savedAt };
    if (this.openId() !== entry.id) drop(work(entry.id));
    return put(INDEX, JSON.stringify(slots));
  }

  /** Empty a slot without telling the listener (deleted on another device). */
  clear(slot: number): void {
    this.removeSlot(slot);
  }

  load(id: string): Project | null {
    return parse(get(data(id)));
  }

  loadWork(id: string): Project | null {
    const raw = get(work(id));
    const project = parse(raw);
    if (!project) return null;
    // Before v31 nothing kept saved versions per pattern: they come from the saved copy.
    const saved = storedVersion(raw) < 31 ? this.load(id) : null;
    if (saved) adoptSaved(project, saved);
    return project;
  }

  saveWork(id: string, project: Project): void {
    put(work(id), JSON.stringify(toStored(project)));
  }

  remove(slot: number): void {
    const old = this.removeSlot(slot);
    if (old) slotListener?.(slot, old);
  }

  private removeSlot(slot: number): string | null {
    const slots = this.slots();
    const old = slots[slot];
    if (!old) return null;
    drop(data(old.id));
    drop(work(old.id));
    slots[slot] = null;
    put(INDEX, JSON.stringify(slots));
    if (this.openId() === old.id) this.setOpen(null);
    return old.id;
  }

  openId(): string | null {
    return get(OPEN);
  }

  setOpen(id: string | null): void {
    if (id) put(OPEN, id);
    else drop(OPEN);
  }
}

export const localProjects = new LocalProjectStore();
export const projectStore: ProjectStore = localProjects;

let workTimer: ReturnType<typeof setTimeout> | undefined;
/** Debounced: the open project's working copy follows every edit. */
export function saveWorkSoon(project: Project): void {
  clearTimeout(workTimer);
  workTimer = setTimeout(() => {
    const id = projectStore.openId();
    if (id) projectStore.saveWork(id, project);
  }, 1000);
}
