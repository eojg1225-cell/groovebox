/**
 * The Android app's project storage: the slots as files in the app's own storage (native
 * `ProjectFilesPlugin`), not the WebView's localStorage, which Android may clear. Read once
 * at start (`initProjectStorage`, before the app runs), kept in memory, every change
 * written through to its file.
 *
 * Installing a new build over the old one keeps these files (every build is signed with the
 * same key, android/app/debug.keystore). Projects in the WebView's localStorage (an APK from
 * before the files kept them there, or a start where the files could not be read) are
 * brought in on each start as a backup import would (newer wins, never over anything newer,
 * a taken slot = a free one) and left out of localStorage only once their files are written.
 *
 * Backups: `saveBackupFile` / `openBackupFile` use Android's own file picker (any folder,
 * Google Drive ...), so a backup outlives the app.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { importBackup, makeBackup } from './backup';
import { useStore, type KeyValue } from './kv';

interface ProjectFiles {
  /** Every file: name -> text. */
  readAll(): Promise<{ files: Record<string, string> }>;
  write(o: { name: string; text: string }): Promise<void>;
  remove(o: { name: string }): Promise<void>;
  /** Save text to a file the user picks (false: cancelled). */
  exportFile(o: { name: string; text: string }): Promise<{ saved: boolean }>;
  /** Read a file the user picks (null: cancelled). */
  importFile(): Promise<{ text: string | null }>;
}

const Files = registerPlugin<ProjectFiles>('ProjectFiles');

/** The localStorage keys of the slots (storage/projects.ts). */
const SLOT_KEY = /^groovebox\.(proj\.|work\.|projects$|open$)/;

const fileName = (key: string) => encodeURIComponent(key);

/** In memory, written through to the app's files in order. */
class NativeStore implements KeyValue {
  private writes: Promise<unknown> = Promise.resolve();
  /** A write or delete failed since the start. */
  failed = false;
  constructor(private readonly m: Map<string, string>) {}

  get(key: string): string | null {
    return this.m.get(key) ?? null;
  }

  set(key: string, value: string): boolean {
    if (this.m.get(key) === value) return true;
    this.m.set(key, value);
    this.queue(() => Files.write({ name: fileName(key), text: value }));
    return true;
  }

  remove(key: string): void {
    if (!this.m.delete(key)) return;
    this.queue(() => Files.remove({ name: fileName(key) }));
  }

  /** Every queued write done. */
  flush(): Promise<unknown> {
    return this.writes;
  }

  private queue(op: () => Promise<void>): void {
    this.writes = this.writes.then(op).catch(() => { this.failed = true; });
  }
}

/** True in the Android app. */
export const isApp = (): boolean => Capacitor.isNativePlatform();

/** In the Android app: the slots from the app's files (else nothing changes). */
export async function initProjectStorage(): Promise<void> {
  if (!isApp()) return;
  let files: Record<string, string>;
  try {
    files = (await Files.readAll()).files;
  } catch {
    return; // no plugin: the slots stay in localStorage
  }
  const m = new Map<string, string>();
  for (const [name, text] of Object.entries(files)) m.set(decodeURIComponent(name), text);
  const store = new NativeStore(m);
  // What the WebView's localStorage holds (read while it is still the store in use).
  const fromWebView = makeBackup();
  useStore(store);
  const r = importBackup(fromWebView);
  if (!r || r.skipped > 0 || r.added + r.updated + r.same === 0) return; // no room for some: all stay there too
  await store.flush();
  if (store.failed) return; // kept there too: brought in again next start
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && SLOT_KEY.test(key)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* left there: same or older next start, nothing changes */
  }
}

/** Save a backup with Android's file picker (false: cancelled). */
export async function saveBackupFile(name: string, text: string): Promise<boolean> {
  return (await Files.exportFile({ name, text })).saved;
}

/** A backup file picked with Android's file picker (null: cancelled). */
export async function openBackupFile(): Promise<string | null> {
  return (await Files.importFile()).text;
}
