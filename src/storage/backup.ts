/**
 * Project backups: every saved slot (with its working copy, the unsaved edits) in one JSON
 * file, to keep somewhere safe or to move projects between the Artifact and the Android app
 * (MENU > PROJECT BACKUP). Importing merges: nothing on this device is overwritten by
 * anything older, and a project whose slot is taken here goes to a free one.
 */
import { PROJECT_SLOTS, localProjects, slotChanged, type SlotEntry } from './projects';

const FORMAT = 'grooveaccess-backup';

interface BackupProject {
  /** The slot it was in (0-63). */
  slot: number;
  id: string;
  name: string;
  savedAt: number;
  /** The saved project, as stored (engine/projectFile.ts). */
  project: Record<string, unknown>;
  /** Its working copy (unsaved edits), as stored. */
  work?: Record<string, unknown>;
}

interface Backup {
  format: typeof FORMAT;
  version: 1;
  exportedAt: number;
  projects: BackupProject[];
}

/** What an import did. */
interface ImportResult {
  /** New here. */
  added: number;
  /** Newer than the copy here, which it replaced. */
  updated: number;
  /** Already here, as new or newer. */
  same: number;
  /** No free slot left. */
  skipped: number;
}

const parseObject = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw) as unknown;
    return x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Every saved slot of this device, as backup text. */
export function makeBackup(now = Date.now()): string {
  const projects: BackupProject[] = [];
  localProjects.slots().forEach((e, slot) => {
    if (!e) return;
    const project = parseObject(localProjects.raw(e.id));
    if (!project) return;
    const work = parseObject(localProjects.rawWork(e.id));
    projects.push({ slot, id: e.id, name: e.name, savedAt: e.savedAt, project, ...(work ? { work } : {}) });
  });
  const backup: Backup = { format: FORMAT, version: 1, exportedAt: now, projects };
  return JSON.stringify(backup);
}

/** The projects in a backup's text (null = not a backup). Broken entries are left out. */
function readBackup(text: string): BackupProject[] | null {
  const b = parseObject(text);
  if (!b || b.format !== FORMAT || !Array.isArray(b.projects)) return null;
  const out: BackupProject[] = [];
  for (const x of b.projects as Record<string, unknown>[]) {
    if (!x || typeof x.id !== 'string' || !x.id || !x.project || typeof x.project !== 'object') continue;
    const slot = Number(x.slot);
    out.push({
      slot: Number.isInteger(slot) && slot >= 0 && slot < PROJECT_SLOTS ? slot : -1,
      id: x.id,
      name: String(x.name ?? '').slice(0, 16),
      savedAt: Number(x.savedAt) || 0,
      project: x.project as Record<string, unknown>,
      work: x.work && typeof x.work === 'object' ? (x.work as Record<string, unknown>) : undefined,
    });
  }
  return out;
}

/** Bring a backup's projects in (null = the text is not a backup). */
export function importBackup(text: string): ImportResult | null {
  const projects = readBackup(text);
  if (!projects) return null;
  const result: ImportResult = { added: 0, updated: 0, same: 0, skipped: 0 };
  for (const p of projects) {
    const slots = localProjects.slots();
    const here = slots.findIndex((e) => e?.id === p.id);
    let slot: number;
    if (here >= 0) {
      if ((slots[here] as SlotEntry).savedAt >= p.savedAt) {
        result.same++;
        continue;
      }
      slot = here;
    } else {
      slot = p.slot >= 0 && !slots[p.slot] ? p.slot : slots.indexOf(null);
      if (slot < 0) {
        result.skipped++;
        continue;
      }
    }
    const entry = { id: p.id, name: p.name, savedAt: p.savedAt };
    if (!localProjects.place(slot, entry, JSON.stringify(p.project))) {
      result.skipped++;
      continue;
    }
    if (p.work && localProjects.openId() !== p.id) localProjects.putWork(p.id, JSON.stringify(p.work));
    slotChanged(slot, here >= 0 ? p.id : null);
    if (here >= 0) result.updated++;
    else result.added++;
  }
  return result;
}
