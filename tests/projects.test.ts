import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/engine/defaultProject';
import { toStored } from '../src/engine/projectFile';

// A minimal localStorage for Node.
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

describe('project slots (localStorage)', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  const store = async () => (await import('../src/storage/projects')).projectStore;

  it('saves into a slot, loads it back, keeps a working copy, deletes', async () => {
    const s = await store();
    expect(s.slots().every((e) => e === null)).toBe(true);
    const p = createDefaultProject();
    p.bpm = 140;
    const e = s.save(4, 'Jungle 1', p)!;
    expect(s.slots()[4]).toMatchObject({ name: 'Jungle 1', id: e.id });
    expect(s.load(e.id)!.bpm).toBe(140);
    // Unsaved edits live in the working copy; the saved one stays.
    p.bpm = 150;
    s.saveWork(e.id, p);
    expect(s.loadWork(e.id)!.bpm).toBe(150);
    expect(s.load(e.id)!.bpm).toBe(140);
    // Saving over its own slot keeps the id; a project sits in one slot only.
    const again = s.save(7, 'Jungle 1', p, e.id)!;
    expect(again.id).toBe(e.id);
    expect(s.slots()[4]).toBeNull();
    s.setOpen(e.id);
    s.remove(7);
    expect(s.slots()[7]).toBeNull();
    expect(s.load(e.id)).toBeNull();
    expect(s.openId()).toBeNull();
  });

  it('an older working copy takes its saved versions from the slot\'s saved copy', async () => {
    const s = await store();
    const p = createDefaultProject();
    const e = s.save(0, 'OLD', p)!;
    // A v30 working copy with a new hit on track 1 and a brighter bass.
    const work = toStored(p) as unknown as { version: number; channels: { patterns: { steps: unknown[] }[]; sounds: Record<string, Record<string, number>> }[] };
    work.version = 30;
    work.channels[0].patterns[0].steps.push({ i: 4, n: 36, v: 0.8 });
    work.channels[4].sounds.bass.cutoff = 4321;
    localStorage.setItem(`groovebox.work.${e.id}`, JSON.stringify(work));
    const loaded = s.loadWork(e.id)!;
    const kick = loaded.channels[0].patterns[0];
    expect(kick.steps[4].active).toBe(true);
    expect(kick.notesDirty).toBe(true);
    expect(kick.savedNotes!.steps[4].active).toBe(false);
    const bass = loaded.channels[4].patterns[0];
    expect(bass.patchDirty).toBe(true);
    expect(bass.savedPatch!.sound.cutoff).not.toBe(4321);
    expect(loaded.channels[4].patterns[1].patchDirty).toBe(true); // one sound on all four before
    expect(loaded.channels[3].patterns[0].patchDirty).toBe(false);
    expect(loaded.channels[1].patterns[0].notesDirty).toBe(false);
  });

  it('first run: the project saved before slots becomes slot 1 and is open', async () => {
    const p = createDefaultProject();
    p.bpm = 99;
    localStorage.setItem('groovebox.project', JSON.stringify(toStored(p)));
    const s = await store();
    const slots = s.slots();
    expect(slots[0]!.name).toBe('PROJECT 1');
    expect(s.openId()).toBe(slots[0]!.id);
    expect(s.load(slots[0]!.id)!.bpm).toBe(99);
    expect(s.slots().length).toBe(64);
  });
});
