/**
 * Session persistence: the working project is kept in sessionStorage, so it survives a
 * reload but not closing the tab. Written in the forgiving stored format (projectFile.ts).
 */
import type { Project } from '../engine/project';
import { fromStored, toStored } from '../engine/projectFile';
import { mirrorToCloud } from './cloud';

const KEY = 'groovebox.session';
const SAVE_DELAY_MS = 300;

export function loadSession(): Project | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? fromStored(JSON.parse(raw)) : null;
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
      sessionStorage.setItem(KEY, JSON.stringify(toStored(project)));
    } catch {
      /* storage unavailable; the session simply won't persist */
    }
  }, SAVE_DELAY_MS);
  mirrorToCloud(project);
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
