/**
 * Session persistence: the project is kept in sessionStorage, so patterns survive a reload
 * but not closing the tab. Real storage (localStorage/IndexedDB, export/import) comes later.
 */
import { normalizeProject, type Project } from '../engine/project';

const KEY = 'groovebox.session';
const SAVE_DELAY_MS = 300;

export function loadSession(): Project | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? normalizeProject(JSON.parse(raw)) : null;
  } catch {
    return null; // storage blocked or corrupt; start fresh
  }
}

let timer: number | undefined;

/** Debounced save. */
export function saveSession(project: Project): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(project));
    } catch {
      /* storage unavailable; the session simply won't persist */
    }
  }, SAVE_DELAY_MS);
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
