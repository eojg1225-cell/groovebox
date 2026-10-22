import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProject } from '../src/engine/defaultProject';
import { PROJECT_VERSION } from '../src/engine/project';
import { toStored } from '../src/engine/projectFile';
import { PROJECT_SLOTS, type SlotEntry } from '../src/storage/projects';
import { planSync, type CloudSlot } from '../src/storage/slotSync';

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

  it('place: a cloud copy goes into a slot as it is (savedAt kept), replacing what was there', async () => {
    const { localProjects } = await import('../src/storage/projects');
    const p = createDefaultProject();
    p.bpm = 99;
    localProjects.save(0, 'HERE', createDefaultProject());
    expect(localProjects.place(0, { id: 'cloud-1', name: 'FROM CLOUD', savedAt: 1234 }, JSON.stringify(toStored(p)))).toBe(true);
    expect(localProjects.slots()[0]).toEqual({ id: 'cloud-1', name: 'FROM CLOUD', savedAt: 1234 });
    expect(localProjects.load('cloud-1')!.bpm).toBe(99);
    localProjects.clear(0);
    expect(localProjects.slots()[0]).toBeNull();
  });

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

  it('upgrade: older saved and working copies are rewritten in the current format, loading the same', async () => {
    const { localProjects } = await import('../src/storage/projects');
    const p = createDefaultProject();
    const e = localProjects.save(2, 'OLD', p)!;
    const before = localProjects.slots()[2];
    // An older saved copy (v14: the live knobs reset to the type defaults on load) and a v30 working copy.
    const old = { ...toStored(p), version: 14 } as Record<string, unknown>;
    const work = { ...toStored(p), version: 30 } as unknown as { channels: { patterns: { steps: unknown[] }[] }[] };
    work.channels[0].patterns[0].steps.push({ i: 4, n: 36, v: 0.8 });
    localStorage.setItem(`groovebox.proj.${e.id}`, JSON.stringify(old));
    localStorage.setItem(`groovebox.work.${e.id}`, JSON.stringify(work));
    const savedThen = localProjects.load(e.id);
    const workThen = localProjects.loadWork(e.id);
    expect(localProjects.upgrade()).toBe(2);
    const version = (key: string) => (JSON.parse(localStorage.getItem(key)!) as { version: number }).version;
    expect(version(`groovebox.proj.${e.id}`)).toBe(PROJECT_VERSION);
    expect(version(`groovebox.work.${e.id}`)).toBe(PROJECT_VERSION);
    expect(localProjects.load(e.id)).toEqual(savedThen);
    expect(localProjects.loadWork(e.id)).toEqual(workThen);
    expect(localProjects.slots()[2]).toEqual(before); // savedAt kept: no new save for the sync
    expect(localStorage.getItem('groovebox.upgraded')).toBe(String(PROJECT_VERSION));
    expect(localProjects.upgrade()).toBe(0); // nothing left
    // A later format runs it again (the marker names the format it reached).
    localStorage.setItem('groovebox.upgraded', '1');
    expect(localProjects.upgrade()).toBe(0);
  });

  it('place: an older cloud copy is stored in the current format', async () => {
    const { localProjects } = await import('../src/storage/projects');
    const old = JSON.stringify({ ...toStored(createDefaultProject()), version: 30 });
    localProjects.place(0, { id: 'c', name: 'C', savedAt: 1 }, old);
    expect((JSON.parse(localProjects.raw('c')!) as { version: number }).version).toBe(PROJECT_VERSION);
  });

  it('upgrade: USER patches are rewritten as they load now', async () => {
    const { readUserPatch, upgradeUserPatches, userPatches } = await import('../src/storage/saved');
    // A pre-v19 BASS patch (four TIMBRE sounds, old OCTAVE indices, filter envelope linked to the amp).
    const old = { name: 'USER 1', values: { timbre: 0.4, octave: 2, cutoff: 900, decay: 0.3, fratio: 0.5 }, live: ['cutoff', 'mix:pan'] as [string, string] };
    localStorage.setItem('groovebox.patches', JSON.stringify({ bass: [old] }));
    const then = readUserPatch('bass', old);
    expect(upgradeUserPatches()).toBe(1);
    const [now] = userPatches('bass');
    expect(now.v).toBe(PROJECT_VERSION);
    expect(readUserPatch('bass', now)).toEqual(then);
    expect(upgradeUserPatches()).toBe(0);
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

describe('cloud slot sync: planSync', () => {
  const N = PROJECT_SLOTS;
  const empty = <T>() => new Array<T | null>(N).fill(null);
  const entry = (id: string, savedAt: number, name = id): SlotEntry => ({ id, name, savedAt });
  const cloudOf = (id: string, savedAt: number, name = id): CloudSlot => ({ id, name, savedAt, project: { v: id } });

  it('first sync: every local slot is copied up, slots 1 and 2 keep their place', () => {
    const local = empty<SlotEntry>();
    local[0] = entry('a', 100);
    local[1] = entry('b', 200);
    expect(planSync(local, empty(), empty())).toEqual([{ kind: 'push', slot: 0 }, { kind: 'push', slot: 1 }]);
  });

  it('a new device takes the cloud slots', () => {
    const cloud = empty<CloudSlot>();
    cloud[0] = cloudOf('a', 100);
    const plan = planSync(empty(), cloud, empty());
    expect(plan).toEqual([{ kind: 'pull', slot: 0, from: cloud[0] }]);
  });

  it('two different projects saved independently: the older keeps the slot, the newer moves to a free one', () => {
    const local = empty<SlotEntry>();
    const cloud = empty<CloudSlot>();
    local[0] = entry('mine', 100); // saved first (the earlier version)
    cloud[0] = cloudOf('other', 500);
    cloud[1] = cloudOf('b', 200);
    const plan = planSync(local, cloud, empty());
    expect(plan).toContainEqual({ kind: 'push', slot: 0 });
    expect(plan).toContainEqual({ kind: 'move', to: 2, cloud: cloud[0] });
    // The other way round: this device's newer one moves, the cloud's older one stays.
    const plan2 = planSync([entry('new', 900), ...empty<SlotEntry>().slice(1)], [cloudOf('old', 100), ...empty<CloudSlot>().slice(1)], empty());
    expect(plan2).toContainEqual({ kind: 'pull', slot: 0, from: cloudOf('old', 100) });
    expect(plan2).toContainEqual({ kind: 'move', to: 1, local: entry('new', 900) });
  });

  it('the same project: the newer save wins', () => {
    const local = [entry('a', 100), ...empty<SlotEntry>().slice(1)];
    expect(planSync(local, [cloudOf('a', 300), ...empty<CloudSlot>().slice(1)], empty())[0]).toMatchObject({ kind: 'pull', slot: 0 });
    expect(planSync(local, [cloudOf('a', 50), ...empty<CloudSlot>().slice(1)], empty())[0]).toEqual({ kind: 'push', slot: 0 });
    expect(planSync(local, [cloudOf('a', 100), ...empty<CloudSlot>().slice(1)], empty())).toEqual([]);
  });

  it('a slot replaced on this device (it knew the cloud one) overwrites; replaced elsewhere comes down', () => {
    const local = [entry('new', 900), ...empty<SlotEntry>().slice(1)];
    const cloud = [cloudOf('old', 100), ...empty<CloudSlot>().slice(1)];
    expect(planSync(local, cloud, ['old', ...empty<string>().slice(1)])).toEqual([{ kind: 'push', slot: 0 }]);
    expect(planSync([entry('old', 100), ...empty<SlotEntry>().slice(1)], [cloudOf('new', 900), ...empty<CloudSlot>().slice(1)], ['old', ...empty<string>().slice(1)]))
      .toEqual([{ kind: 'pull', slot: 0, from: cloudOf('new', 900) }]);
  });

  it('deletes travel both ways', () => {
    const tomb: CloudSlot = { id: 'a', deleted: true, deletedAt: 500 };
    expect(planSync([entry('a', 100), ...empty<SlotEntry>().slice(1)], [tomb, ...empty<CloudSlot>().slice(1)], empty())).toEqual([{ kind: 'clear', slot: 0 }]);
    expect(planSync(empty(), [cloudOf('a', 100), ...empty<CloudSlot>().slice(1)], ['a', ...empty<string>().slice(1)])).toEqual([{ kind: 'tombstone', slot: 0, id: 'a' }]);
    // A different project in the slot is not deleted by another project's marker.
    expect(planSync([entry('b', 100), ...empty<SlotEntry>().slice(1)], [tomb, ...empty<CloudSlot>().slice(1)], empty())).toEqual([{ kind: 'push', slot: 0 }]);
  });
});
