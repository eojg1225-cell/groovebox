/**
 * Settings kept on this device, the same for every project (MENU > GLOBAL SETTINGS): in
 * localStorage, read once at start. Missing or broken values take the defaults.
 */

/** KNOB SPEED: pixels of slow drag for a knob's full range. */
export const KNOB_SPEEDS = [
  { name: 'SLOW', px: 600 },
  { name: 'NORMAL', px: 400 },
  { name: 'FAST', px: 250 },
] as const;
/** HOLD TIME: FUNC released sooner than this (no knob turned) is a tap, which latches it. */
export const HOLD_TIMES = [
  { name: 'SHORT', ms: 250 },
  { name: 'NORMAL', ms: 350 },
  { name: 'LONG', ms: 500 },
] as const;
/** TOUCH DELAY choices (ms): how much later than the engine the player hears a tap land. */
export const TOUCH_DELAYS = [0, 5, 10, 15, 20, 25, 30, 40, 50] as const;

interface DeviceSettings {
  /** Index into KNOB_SPEEDS. */
  knobSpeed: number;
  /** Quick drags move a knob further (1) or not (0). */
  knobAccel: number;
  /** Index into TOUCH_DELAYS. */
  touchDelay: number;
  /** Index into HOLD_TIMES. */
  holdTime: number;
  /** KEEP SCREEN ON: 0 = while playing, 1 = always. */
  screenOn: number;
}

const KEY = 'groovebox.device';
const DEFAULTS: DeviceSettings = { knobSpeed: 1, knobAccel: 1, touchDelay: 3, holdTime: 1, screenOn: 0 };
/** How many choices each setting has. */
const CHOICES: Record<keyof DeviceSettings, number> = {
  knobSpeed: KNOB_SPEEDS.length, knobAccel: 2, touchDelay: TOUCH_DELAYS.length, holdTime: HOLD_TIMES.length, screenOn: 2,
};

function load(): DeviceSettings {
  const out = { ...DEFAULTS };
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof DeviceSettings, unknown>>;
    for (const k of Object.keys(DEFAULTS) as (keyof DeviceSettings)[]) {
      const v = stored[k];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < CHOICES[k]) out[k] = v;
    }
  } catch { /* no storage here, or nothing valid stored: the defaults */ }
  return out;
}

export const deviceSettings: DeviceSettings = load();

export function saveDeviceSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(deviceSettings));
  } catch { /* not kept: still applies until the page closes */ }
}
