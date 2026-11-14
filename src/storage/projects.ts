/**
 * Projects: 64 slots (4 banks of 16) of named, saved projects, each with its own working
 * copy (unsaved edits, so switching never loses work). Kept in a key-value store
 * (storage/kv.ts: localStorage in a browser, files in the Android app) behind the
 * ProjectStore interface: records are keyed by a fixed random id, the slot is just where an
 * id sits.
 */
import type { Project } from '../engine/project';
import { fromStored, isOldFormat, toStored } from '../engine/projectFile';
import { kv } from './kv';
import { createDefaultProject } from '../engine/defaultProject';

export const SLOTS_PER_BANK = 16;
export const PROJECT_BANKS = 4;
export const PROJECT_SLOTS = SLOTS_PER_BANK * PROJECT_BANKS;
export const NAME_LENGTH = 16;

export interface SlotEntry {
  id: string;
  name: string;
  savedAt: number;
}

/** @public The storage seam for the Capacitor app (native ProjectStore later). */
export interface ProjectStore {
  /** Every slot: its project, or null when empty. */
  slots(): (SlotEntry | null)[];
  /** Save into a slot (replacing whatever is there); keeps `id` when given. Null = failed (full). */
  save(slot: number, name: string, project: Project, id?: string): SlotEntry | null;
  /** The saved project. */
  load(id: string): Project | null;
  /** Saved in a format older than the reader reads exactly: its sounds may differ. */
  isOld(id: string): boolean;
  /** Its working copy (unsaved edits), if any. */
  loadWork(id: string): Project | null;
  /** False when it could not be kept (storage full). */
  saveWork(id: string, project: Project): boolean;
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
/** Tell the listener a slot changed outside save / remove (a backup was brought in). */
export function slotChanged(slot: number, oldId: string | null): void {
  slotListener?.(slot, oldId);
}

const INDEX = 'groovebox.projects';
const OPEN = 'groovebox.open';
const data = (id: string) => `groovebox.proj.${id}`;
const work = (id: string) => `groovebox.work.${id}`;

const get = (key: string): string | null => kv().get(key);
const put = (key: string, value: string): boolean => kv().set(key, value);
const drop = (key: string): void => kv().remove(key);

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
    if (!Array.isArray(list)) return new Array(PROJECT_SLOTS).fill(null);
    return Array.from({ length: PROJECT_SLOTS }, (_, i) => {
      const e = list[i] as SlotEntry | null;
      return e && typeof e.id === 'string' ? { id: e.id, name: String(e.name ?? ''), savedAt: Number(e.savedAt) || 0 } : null;
    });
  }

  save(slot: number, name: string, project: Project, id = newId()): SlotEntry | null {
    const slots = this.slots();
    const old = slots[slot];
    if (!put(data(id), JSON.stringify(toStored(project)))) return null;
    const entry = { id, name, savedAt: Date.now() };
    // The same project kept in one slot only.
    const moved: number[] = [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]?.id === id && i !== slot) moved.push(i);
      if (slots[i]?.id === id) slots[i] = null;
    }
    slots[slot] = entry;
    // The index first: the project it replaces goes only once the new one is in the index
    // (storage full = the old one still there, not neither).
    if (!put(INDEX, JSON.stringify(slots))) return null;
    if (old && old.id !== id) {
      drop(data(old.id));
      drop(work(old.id));
    }
    this.saveWork(id, project);
    for (const i of moved) slotListener?.(i, id);
    slotListener?.(slot, old?.id ?? null);
    return entry;
  }

  /** The saved project as stored (JSON text), for the cloud copy and backups. */
  raw(id: string): string | null {
    return get(data(id));
  }

  /** Its working copy as stored (JSON text), if any. */
  rawWork(id: string): string | null {
    return get(work(id));
  }

  /** Keep a working copy as stored (JSON text): from a backup. */
  putWork(id: string, raw: string): boolean {
    return put(work(id), raw);
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

  isOld(id: string): boolean {
    const raw = get(work(id)) ?? get(data(id));
    try {
      return isOldFormat(JSON.parse(raw ?? 'null'));
    } catch {
      return false;
    }
  }

  loadWork(id: string): Project | null {
    return parse(get(work(id)));
  }

  saveWork(id: string, project: Project): boolean {
    return put(work(id), JSON.stringify(toStored(project)));
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

/**
 * A project not in any slot (every start is one: the blank slate) is kept too, so a reload,
 * a crash or an app update never loses it: under SESSION while it is worked on; at the next
 * start it moves to LAST (`keepLastSession`), which MENU > PROJECT BACKUP > LAST UNSAVED
 * WORK brings back. The untouched default project is never written, so a start that
 * changes nothing leaves LAST as it was.
 */
const SESSION = 'groovebox.session';
const LAST = 'groovebox.session.last';
let defaultText: string | null = null;

/** Keep the project being worked on (its slot's working copy, or SESSION). False = not kept. */
function writeWork(project: Project): boolean {
  const id = projectStore.openId();
  if (id) return projectStore.saveWork(id, project);
  const text = JSON.stringify(toStored(project));
  defaultText ??= JSON.stringify(toStored(createDefaultProject()));
  if (text === defaultText) return true;
  return put(SESSION, text);
}

let workTimer: ReturnType<typeof setTimeout> | undefined;
let workPending: { project: Project; failed?: () => void } | null = null;

/** Debounced: the working copy follows every edit; `failed` is told when it could not be kept. */
export function saveWorkSoon(project: Project, failed?: () => void): void {
  clearTimeout(workTimer);
  workPending = { project, failed };
  workTimer = setTimeout(flushWork, 1000);
}

/** Write a waiting working copy now (the page is being hidden or closed). */
export function flushWork(): void {
  clearTimeout(workTimer);
  const w = workPending;
  workPending = null;
  if (w && !writeWork(w.project)) w.failed?.();
}

/** At start: the last session's unsaved project (if it left one) becomes LAST. True = it did. */
export function keepLastSession(): boolean {
  const text = get(SESSION);
  if (!text) return false;
  if (!put(LAST, text)) return false;
  drop(SESSION);
  return true;
}

/** The unsaved project an earlier session left (null: none). */
export function lastSession(): Project | null {
  return parse(get(LAST));
}

/** The unsaved project was saved into a slot: no copy of it is kept as unsaved any more. */
export function forgetSession(): void {
  drop(SESSION);
}
