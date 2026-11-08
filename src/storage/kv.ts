/**
 * Where the project slots are kept: a small key-value store of text. In a browser (and the
 * claude.ai Artifact) that is localStorage; in the Android app, files in the app's own
 * storage (storage/native.ts), loaded once at start and written through.
 */
export interface KeyValue {
  get(key: string): string | null;
  /** False when it could not be kept (storage full). */
  set(key: string, value: string): boolean;
  remove(key: string): void;
}

const browser: KeyValue = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false; // full or blocked
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

let backend: KeyValue = browser;

/** The store in use. */
export function kv(): KeyValue {
  return backend;
}

/** Keep the slots somewhere else from now on (the Android app's files). */
export function useStore(store: KeyValue): void {
  backend = store;
}
