/**
 * MENU > PROJECT BACKUP: a backup file out (EXPORT) or in (IMPORT). In the Android app
 * through Android's file picker; in the claude.ai Artifact the page's `downloads`
 * capability saves it; in any other browser a download. Import in a browser: the file
 * chooser. Each resolves to the message the screen shows.
 */
import { importBackup, makeBackup } from './backup';
import { isApp, openBackupFile, saveBackupFile } from './native';

type Downloads = { save(o: { filename: string; data: string }): Promise<unknown> };
type ClaudeRuntime = { use(name: string): Promise<unknown> };

const fileName = () => `grooveaccess-projects-${new Date().toISOString().slice(0, 10)}.json`;

/** Every saved project into one file. */
export async function exportProjects(): Promise<string> {
  const text = makeBackup();
  const count = (JSON.parse(text) as { projects: unknown[] }).projects.length;
  if (count === 0) return 'NO SAVED PROJECTS';
  try {
    if (isApp()) {
      return (await saveBackupFile(fileName(), text)) ? `EXPORTED ${count} PROJECTS` : 'EXPORT CANCELLED';
    }
    const claude = (window as unknown as { claude?: ClaudeRuntime }).claude;
    const downloads = claude?.use ? ((await claude.use('downloads')) as Downloads | null) : null;
    if (downloads) {
      await downloads.save({ filename: fileName(), data: text });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = fileName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
    return `EXPORTED ${count} PROJECTS`;
  } catch (e) {
    return (e as { code?: string })?.code === 'declined' ? 'EXPORT CANCELLED' : 'EXPORT FAILED';
  }
}

/** A file picked in the browser (null: cancelled). */
function pickFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) resolve(null);
      else f.text().then(resolve, () => resolve(null));
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Bring the projects in a backup file in, beside what is here. */
export async function importProjects(): Promise<string> {
  let text: string | null;
  try {
    text = isApp() ? await openBackupFile() : await pickFile();
  } catch {
    return 'IMPORT FAILED';
  }
  if (text === null) return 'IMPORT CANCELLED';
  const r = importBackup(text);
  if (!r) return 'NOT A PROJECT BACKUP';
  const parts = [`${r.added} NEW`];
  if (r.updated) parts.push(`${r.updated} NEWER`);
  if (r.same) parts.push(`${r.same} ALREADY HERE`);
  if (r.skipped) parts.push(`${r.skipped} NO ROOM`);
  return `IMPORTED: ${parts.join(', ')}`;
}
