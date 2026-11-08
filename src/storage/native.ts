/**
 * The Android app's project storage: the slots as files in the app's own storage (native
 * `ProjectFilesPlugin`), not the WebView's localStorage, which Android may clear. Read once
 * at start (`initProjectStorage`, before the app runs), kept in memory, every change
 * written through to its file.
 *
 * First start with files: whatever the WebView's localStorage held (an earlier APK kept its
 * projects there) is copied in; then, once, the projects that came with the app (a backup
 * of the Artifact's slots, android/app/src/main/assets/seed/projects.json) are imported
 * alongside, never over anything here.
 *
 * Backups: `saveBackupFile` / `openBackupFile` use Android's own file picker (any folder,
 * Google Drive ...), so a backup outlives the app.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { importBackup } from './backup';
import { useStore, type KeyValue } from './kv';

interface ProjectFiles {
  /** Every file: name -> text. */
  readAll(): Promise<{ files: Record<string, string> }>;
  write(o: { name: string; text: string }): Promise<void>;
  remove(o: { name: string }): Promise<void>;
  /** The backup bundled with the app (null: none). */
  seed(): Promise<{ text: string | null }>;
  /** Save text to a file the user picks (false: cancelled). */
  exportFile(o: { name: string; text: string }): Promise<{ saved: boolean }>;
  /** Read a file the user picks (null: cancelled). */
  importFile(): Promise<{ text: string | null }>;
}

const Files = registerPlugin<ProjectFiles>('ProjectFiles');

/** Set once the WebView's localStorage has been copied in. */
const MIGRATED = 'groovebox.native.migrated';
/** Set once the bundled projects have been imported. */
const SEEDED = 'groovebox.native.seeded';
/** The localStorage keys of the slots (storage/projects.ts). */
const SLOT_KEY = /^groovebox\.(proj\.|work\.|projects$|open$)/;

const fileName = (key: string) => encodeURIComponent(key);

/** In memory, written through to the app's files in order. */
class NativeStore implements KeyValue {
  private writes: Promise<unknown> = Promise.resolve();
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

  private queue(op: () => Promise<void>): void {
    this.writes = this.writes.then(op).catch(() => undefined);
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
  if (!store.get(MIGRATED)) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && SLOT_KEY.test(key) && store.get(key) === null) store.set(key, localStorage.getItem(key) ?? '');
      }
    } catch {
      /* nothing to copy */
    }
    store.set(MIGRATED, '1');
  }
  useStore(store);
  if (!store.get(SEEDED)) {
    try {
      const { text } = await Files.seed();
      if (text) importBackup(text);
    } catch {
      /* no bundled projects */
    }
    store.set(SEEDED, '1');
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
