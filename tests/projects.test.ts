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
