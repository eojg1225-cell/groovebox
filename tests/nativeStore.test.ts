import { describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/engine/defaultProject';
import { toStored } from '../src/engine/projectFile';

// The Android app's plugin, faked: its files in a Map (they survive an app update).
const files = new Map<string, string>();
let failWrites = false;
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({
    readAll: async () => ({ files: Object.fromEntries(files) }),
    write: async ({ name, text }: { name: string; text: string }) => {
      if (failWrites) throw new Error('disk full');
      files.set(name, text);
    },
    remove: async ({ name }: { name: string }) => { files.delete(name); },
  }),
}));

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

const stored = (bpm: number) => { const p = createDefaultProject(); p.bpm = bpm; return JSON.stringify(toStored(p)); };
const settle = () => new Promise((r) => setTimeout(r, 10));

/** A fresh start of the app (new build installed over the last): modules reloaded, files kept. */
async function start() {
  vi.resetModules();
  await (await import('../src/storage/native')).initProjectStorage();
  await settle();
  return (await import('../src/storage/projects')).localProjects;
}

describe('Android app storage', () => {
  it('keeps every project across updates; the WebView\'s projects move into files', async () => {
    // An APK from before the files kept a project in the WebView's localStorage.
    const ls = new MemoryStorage();
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    vi.resetModules();
    (await import('../src/storage/projects')).localProjects.place(0, { id: 'phone', name: 'ON PHONE', savedAt: 5 }, stored(171));

    let store = await start();
    expect(store.slots()[0]!.name).toBe('ON PHONE');
    expect(files.has(encodeURIComponent('groovebox.proj.phone'))).toBe(true);
    expect(ls.length).toBe(0); // in files now: gone from localStorage

    // Projects saved and deleted in the app ...
    const e = store.save(20, 'NEW', createDefaultProject())!;
    store.save(3, 'GONE', createDefaultProject());
    store.remove(3);
    await settle();

    // ... are exactly as left after the next update.
    store = await start();
    expect(store.slots()[0]!.name).toBe('ON PHONE');
    expect(store.slots()[20]).toEqual(e);
    expect(store.slots()[3]).toBeNull();
    expect(store.load('phone')!.bpm).toBe(171);
    // Nothing bundled with the app: only these two.
    expect(store.slots().filter(Boolean).length).toBe(2);
  });

  it('a project left in localStorage is never lost: kept there until its files are written', async () => {
    files.clear();
    const ls = new MemoryStorage();
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    vi.resetModules();
    (await import('../src/storage/projects')).localProjects.place(2, { id: 'stuck', name: 'STUCK', savedAt: 9 }, stored(120));

    failWrites = true;
    await start();
    expect(ls.getItem('groovebox.proj.stuck')).toBeTruthy(); // the files failed: still here

    failWrites = false;
    const store = await start();
    expect(store.slots()[2]!.name).toBe('STUCK');
    expect(ls.getItem('groovebox.proj.stuck')).toBeNull();
  });
});
