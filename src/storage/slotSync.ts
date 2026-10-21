/**
 * Project slots in the cloud (claude.ai artifact only): the 64 saved projects are copied to
 * the artifact's `db` (collection `slots`, one document per slot), so every device that
 * opens the artifact has the same slots. Elsewhere (GitHub Pages, dev server) there is no
 * `db` and the slots stay local.
 *
 * On start (and when SAVE / LOAD opens) the local slots and the cloud's are merged; after
 * that each save or delete is copied up at once. Nothing is ever lost in a merge:
 *  - the same project in a slot on both sides: the newer save wins;
 *  - a different project on each side: if this device replaced the cloud's (it knew it from
 *    its last sync), its own wins; if another device replaced this one's, the cloud's wins;
 *    otherwise (saved independently) the OLDER save keeps the slot and the newer one moves
 *    to a free slot, so slots saved earlier keep their place;
 *  - deleted on one side: a delete marker (with the project's id) removes it on the other.
 * `groovebox.sync` remembers, per slot, the project id at the last sync.
 */
import { PROJECT_SLOTS, localProjects, onSlotChange, type SlotEntry } from './projects';

const COLLECTION = 'slots';
const BASE = 'groovebox.sync';
const docId = (slot: number) => `slot-${String(slot + 1).padStart(2, '0')}`;

/** A slot as the cloud keeps it: a project, or the marker a delete leaves. */
export type CloudSlot =
  | { id: string; name: string; savedAt: number; project: Record<string, unknown>; deleted?: false }
  | { id: string; deleted: true; deletedAt: number };

/** What a sync does to one slot. */
export type SyncAction =
  | { kind: 'push'; slot: number }
  | { kind: 'pull'; slot: number; from: CloudSlot & { deleted?: false } }
  | { kind: 'clear'; slot: number }
  | { kind: 'tombstone'; slot: number; id: string }
  /** A project that lost its slot goes to a free one (taken from the cloud or kept from here). */
  | { kind: 'move'; to: number; local?: SlotEntry; cloud?: CloudSlot & { deleted?: false } };

const live = (c: CloudSlot | null): (CloudSlot & { deleted?: false }) | null => (c && !c.deleted ? c : null);

/** The merge (pure): local slots, the cloud's, and each slot's id at the last sync. */
export function planSync(local: (SlotEntry | null)[], cloud: (CloudSlot | null)[], base: (string | null)[]): SyncAction[] {
  const out: SyncAction[] = [];
  const homeless: { local?: SlotEntry; cloud?: CloudSlot & { deleted?: false } }[] = [];
  const taken = new Array<boolean>(PROJECT_SLOTS).fill(false);
  for (let i = 0; i < PROJECT_SLOTS; i++) {
    const l = local[i] ?? null;
    const c = cloud[i] ?? null;
    const cl = live(c);
    const b = base[i] ?? null;
    if (l && cl && l.id === cl.id) {
      if (cl.savedAt > l.savedAt) out.push({ kind: 'pull', slot: i, from: cl });
      else if (l.savedAt > cl.savedAt || cl.name !== l.name) out.push({ kind: 'push', slot: i });
      taken[i] = true;
    } else if (l && cl) {
      taken[i] = true;
      if (b === cl.id) out.push({ kind: 'push', slot: i }); // replaced here
      else if (b === l.id) out.push({ kind: 'pull', slot: i, from: cl }); // replaced elsewhere
      else if (l.savedAt <= cl.savedAt) {
        out.push({ kind: 'push', slot: i });
        homeless.push({ cloud: cl });
      } else {
        homeless.push({ local: l });
        out.push({ kind: 'pull', slot: i, from: cl });
      }
    } else if (l) {
      if (c?.deleted && c.id === l.id) out.push({ kind: 'clear', slot: i }); // deleted elsewhere
      else {
        out.push({ kind: 'push', slot: i });
        taken[i] = true;
      }
    } else if (cl) {
      if (b === cl.id) out.push({ kind: 'tombstone', slot: i, id: cl.id }); // deleted here
      else {
        out.push({ kind: 'pull', slot: i, from: cl });
        taken[i] = true;
      }
    }
  }
  for (const h of homeless) {
    const to = taken.indexOf(false);
    if (to < 0) break; // no room: left where it is here, not copied up
    taken[to] = true;
    out.push({ kind: 'move', to, ...h });
  }
  return out;
}

// ---------------------------------------------------------------- the artifact's db

interface DocSnap { id: string; exists: boolean; data(): Record<string, unknown> | undefined }
interface DocRef { set(data: Record<string, unknown>): Promise<void> }
interface Db {
  doc(path: string): DocRef;
  collection(path: string): { get(): Promise<{ docs: DocSnap[] }> };
}
type ClaudeRuntime = { use(name: string): Promise<unknown> };

let db: Db | null = null;
let syncing: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
/** Called when a sync changed the local slots (to redraw). */
let changed: (() => void) | null = null;

function readBase(): (string | null)[] {
  try {
    const b = JSON.parse(localStorage.getItem(BASE) ?? 'null');
    if (Array.isArray(b)) return Array.from({ length: PROJECT_SLOTS }, (_, i) => (typeof b[i] === 'string' ? b[i] : null));
  } catch {
    /* none yet */
  }
  return new Array(PROJECT_SLOTS).fill(null);
}

function setBase(slot: number, id: string | null): void {
  const b = readBase();
  b[slot] = id;
  try {
    localStorage.setItem(BASE, JSON.stringify(b));
  } catch {
    /* full: the next sync compares again */
  }
}

function readCloud(d: DocSnap): CloudSlot | null {
  const x = d.exists ? d.data() : undefined;
  if (!x || typeof x.id !== 'string') return null;
  if (x.deleted === true) return { id: x.id, deleted: true, deletedAt: Number(x.deletedAt) || 0 };
  if (!x.project || typeof x.project !== 'object') return null;
  return { id: x.id, name: String(x.name ?? ''), savedAt: Number(x.savedAt) || 0, project: x.project as Record<string, unknown> };
}

/** Writes go one at a time (one per document at once, in order). */
function write(slot: number, body: Record<string, unknown>): void {
  const ref = db?.doc(`${COLLECTION}/${docId(slot)}`);
  if (!ref) return;
  writes = writes.then(() => ref.set(body)).catch(() => {
    /* offline or refused: the next sync copies it up */
  });
}

/** Copy a local slot up (its project, or a delete marker for `oldId`). */
function pushSlot(slot: number, oldId: string | null = null): void {
  const e = localProjects.slots()[slot];
  if (!e) {
    const id = oldId ?? readBase()[slot];
    if (id) write(slot, { id, deleted: true, deletedAt: Date.now() });
    setBase(slot, null);
    return;
  }
  const raw = localProjects.raw(e.id);
  if (!raw) return;
  try {
    write(slot, { id: e.id, name: e.name, savedAt: e.savedAt, project: JSON.parse(raw) as Record<string, unknown> });
    setBase(slot, e.id);
  } catch {
    /* unreadable: left local */
  }
}

async function runSync(): Promise<void> {
  if (!db) return;
  const snap = await db.collection(COLLECTION).get();
  const cloud: (CloudSlot | null)[] = new Array(PROJECT_SLOTS).fill(null);
  for (const d of snap.docs) {
    const m = /^slot-(\d\d)$/.exec(d.id);
    const slot = m ? Number(m[1]) - 1 : -1;
    if (slot >= 0 && slot < PROJECT_SLOTS) cloud[slot] = readCloud(d);
  }
  const local = localProjects.slots();
  const actions = planSync(local, cloud, readBase());
  // Projects moving to a free slot are read before anything replaces them.
  const kept = new Map<string, string>();
  for (const a of actions) if (a.kind === 'move' && a.local) kept.set(a.local.id, localProjects.raw(a.local.id) ?? '');
  let any = false;
  for (const a of actions) {
    if (a.kind === 'pull') {
      if (localProjects.place(a.slot, a.from, JSON.stringify(a.from.project))) setBase(a.slot, a.from.id);
      any = true;
    } else if (a.kind === 'clear') {
      localProjects.clear(a.slot);
      setBase(a.slot, null);
      any = true;
    } else if (a.kind === 'tombstone') {
      write(a.slot, { id: a.id, deleted: true, deletedAt: Date.now() });
      setBase(a.slot, null);
    }
  }
  for (const a of actions) {
    if (a.kind === 'push') pushSlot(a.slot);
    else if (a.kind === 'move') {
      const from = a.cloud;
      const raw = from ? JSON.stringify(from.project) : kept.get(a.local!.id);
      const entry = from ?? a.local!;
      if (raw && localProjects.place(a.to, { id: entry.id, name: entry.name, savedAt: entry.savedAt }, raw)) {
        pushSlot(a.to);
        any = true;
      }
    }
  }
  if (any) changed?.();
}

/** Merge the local slots with the cloud's (no-op outside claude.ai; one at a time). */
export function syncSlots(): Promise<void> {
  if (!db) return Promise.resolve();
  syncing ??= runSync().catch(() => {
    /* offline: local slots as they are */
  }).finally(() => { syncing = null; });
  return syncing;
}

/** Start syncing the slots (claude.ai artifact only): a merge now, then every save / delete. */
export function startSlotSync(onChanged?: () => void): void {
  changed = onChanged ?? null;
  const claude = (window as unknown as { claude?: ClaudeRuntime }).claude;
  if (!claude?.use) return;
  claude.use('db').then((ns) => {
    db = (ns as Db | null) ?? null;
    if (!db) return;
    onSlotChange((slot, oldId) => {
      // A save or delete while a merge runs is copied up after it.
      void (syncing ?? Promise.resolve()).then(() => pushSlot(slot, oldId));
    });
    void syncSlots();
  }, () => { db = null; });
}
