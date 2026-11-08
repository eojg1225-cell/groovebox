import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../src/engine/defaultProject';
import { toStored } from '../src/engine/projectFile';

// The Android app's plugin, faked: its files in a Map.
const files = new Map<string, string>();
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({
    readAll: async () => ({ files: Object.fromEntries(files) }),
    write: async ({ name, text }: { name: string; text: string }) => { files.set(name, text); },
    remove: async ({ name }: { name: string }) => { files.delete(name); },
    seed: async () => ({ text: readFileSync('android/app/src/main/assets/seed/projects.json', 'utf8') }),
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

describe('Android app storage', () => {
  it('first start: the WebView\'s projects and the bundled ones go into files, kept beside each other', async () => {
    // An earlier APK kept a project in the WebView's localStorage, in slot 1 (where a bundled one would go).
    const ls = new MemoryStorage();
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    const { localProjects } = await import('../src/storage/projects');
    const p = createDefaultProject();
    p.bpm = 171;
    localProjects.place(0, { id: 'phone', name: 'ON PHONE', savedAt: 5 }, JSON.stringify(toStored(p)));

    const { initProjectStorage } = await import('../src/storage/native');
    await initProjectStorage();
    await new Promise((r) => setTimeout(r, 10)); // the writes are queued
    const slots = localProjects.slots();
    expect(slots[0]!.name).toBe('ON PHONE');
    const names = slots.filter(Boolean).map((e) => e!.name);
    expect(names).toContain('MTHED');
    expect(names).toContain('LAST EDIT');
    // Everything is in files now, nothing new in localStorage.
    expect(files.get(encodeURIComponent('groovebox.proj.phone'))).toBeTruthy();
    expect(files.has('groovebox.projects')).toBe(true);
    expect(ls.length).toBe(2); // the old copy only (index + project)

    // A save lands in a file.
    const e = localProjects.save(20, 'NEW', p)!;
    await new Promise((r) => setTimeout(r, 10));
    expect(files.has(encodeURIComponent(`groovebox.proj.${e.id}`))).toBe(true);

    // Next start: the same slots from the files, the bundle not imported again.
    localProjects.remove(1);
    await new Promise((r) => setTimeout(r, 10));
    vi.resetModules();
    const again = await import('../src/storage/native');
    await again.initProjectStorage();
    const { localProjects: after } = await import('../src/storage/projects');
    expect(after.slots()[0]!.name).toBe('ON PHONE');
    expect(after.slots()[1]).toBeNull();
    expect(after.slots()[20]!.name).toBe('NEW');
  });
});
