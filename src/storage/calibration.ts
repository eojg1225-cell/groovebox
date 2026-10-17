/**
 * Knob centres (the calibration window): for a knob's parameter, the value that sits at the
 * middle of its travel. Kept in this browser and mirrored to the artifact store
 * (`calibration/centres`) so they can be built into the defaults.
 */
import { writeCloudDoc } from './cloud';

const KEY = 'groovebox.knobCentres';
const OPEN_KEY = 'groovebox.calibrateOpen';

export type Centres = Record<string, number>;

export function loadCentres(): Centres {
  try {
    const raw = localStorage.getItem(KEY);
    const data = raw ? (JSON.parse(raw) as unknown) : null;
    if (!data || typeof data !== 'object') return {};
    const out: Centres = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function saveCentres(centres: Centres): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(centres));
  } catch {
    /* private mode: the cloud copy still has them */
  }
  writeCloudDoc('calibration/centres', { savedAt: Date.now(), centres });
}

/** Whether the calibration window is open (open unless closed). */
export function calibrateOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setCalibrateOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* ignore */
  }
}
