/**
 * Projects: 64 slots (4 banks of 16) of named, saved projects, each with its own working
 * copy (unsaved edits, so switching never loses work). Kept in localStorage behind the
 * ProjectStore interface, so a cloud store can take its place later: records are keyed by
 * a fixed random id, the slot is just where an id sits.
 */
import type { Project } from '../engine/project';
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
    for (let i = 0; i < slots.length; i++) if (slots[i]?.id === id) slots[i] = null;
    slots[slot] = entry;
    if (!put(INDEX, JSON.stringify(slots))) return null;
    this.saveWork(id, project);
    return entry;
  }

  load(id: string): Project | null {
    return parse(get(data(id)));
  }

  loadWork(id: string): Project | null {
    return parse(get(work(id)));
  }

  saveWork(id: string, project: Project): void {
    put(work(id), JSON.stringify(toStored(project)));
  }

  remove(slot: number): void {
    const slots = this.slots();
    const old = slots[slot];
    if (!old) return;
    drop(data(old.id));
    drop(work(old.id));
    slots[slot] = null;
    put(INDEX, JSON.stringify(slots));
    if (this.openId() === old.id) this.setOpen(null);
  }

  openId(): string | null {
    return get(OPEN);
  }

  setOpen(id: string | null): void {
    if (id) put(OPEN, id);
    else drop(OPEN);
  }
}

export const projectStore: ProjectStore = new LocalProjectStore();

let workTimer: ReturnType<typeof setTimeout> | undefined;
/** Debounced: the open project's working copy follows every edit. */
export function saveWorkSoon(project: Project): void {
  clearTimeout(workTimer);
  workTimer = setTimeout(() => {
    const id = projectStore.openId();
    if (id) projectStore.saveWork(id, project);
  }, 1000);
}
