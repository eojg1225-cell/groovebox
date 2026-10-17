/**
 * Cloud mirror (claude.ai artifact only): the working project is copied to the artifact's
 * `db` store, so it survives across devices and can be read back to seed the default
 * project. Elsewhere (GitHub Pages, dev server) the capability is absent and this does
 * nothing.
 */
import type { Project } from '../engine/project';
import { toStored } from '../engine/projectFile';

const DOC = 'projects/current';
const DELAY_MS = 3000;

interface DocRef { set(data: Record<string, unknown>): Promise<void> }
interface Db { doc(path: string): DocRef }
type ClaudeRuntime = { use(name: string): Promise<unknown> };

let db: Db | null | undefined; // undefined = not resolved yet
let resolving = false;
let pending: Project | null = null;
let timer: number | undefined;
let writing = false;

function resolveDb(): void {
  if (db !== undefined || resolving) return;
  const claude = (window as unknown as { claude?: ClaudeRuntime }).claude;
  if (!claude?.use) { db = null; return; }
  resolving = true;
  claude.use('db').then(
    (ns) => { db = (ns as Db | null) ?? null; if (pending) schedule(); },
    () => { db = null; },
  );
}

function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void flush(), DELAY_MS);
}

async function flush(): Promise<void> {
  if (!db || !pending || writing) return;
  const project = pending;
  pending = null;
  writing = true; // one write at a time
  try {
    await db.doc(DOC).set({ savedAt: Date.now(), project: toStored(project) as unknown as Record<string, unknown> });
  } catch {
    /* offline, signed out or not allowed: the local copy still has it */
  } finally {
    writing = false;
    if (pending) schedule();
  }
}

/** Debounced copy of the project to the artifact store (no-op outside claude.ai). */
export function mirrorToCloud(project: Project): void {
  pending = project;
  resolveDb();
  if (db) schedule();
}
