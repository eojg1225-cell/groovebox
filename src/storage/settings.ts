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
/** COUNT-IN: bars of clicks before live recording starts. */
export const COUNT_INS = ['OFF', '1 BAR', '2 BARS'] as const;
/** METRONOME: when the click plays with the music. */
export const METRONOMES = ['OFF', 'RECORDING', 'ALWAYS'] as const;
/** CLICK LEVEL choices, %. */
export const CLICK_LEVELS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;
/** HOLD + RESET: track / FX / LFO buttons held while RESET is pressed are kept out of it, or are all it resets. */
export const HOLD_RESETS = ['KEEP HELD', 'RESET HELD'] as const;
/** TOUCH DELAY choices (ms): how much later than the engine the player hears a tap land. */
export const TOUCH_DELAYS = [0, 5, 10, 15, 20, 25, 30, 40, 50] as const;

interface DeviceSettings {
  /** Index into COUNT_INS. */
  countIn: number;
  /** Index into METRONOMES. */
  metronome: number;
  /** Index into CLICK_LEVELS. */
  clickLevel: number;
  /** Index into HOLD_RESETS. */
  holdReset: number;
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
const DEFAULTS: DeviceSettings = { countIn: 0, metronome: 0, clickLevel: 7, holdReset: 0, knobSpeed: 1, knobAccel: 1, touchDelay: 3, holdTime: 1, screenOn: 0 };
/** How many choices each setting has. */
const CHOICES: Record<keyof DeviceSettings, number> = {
  countIn: COUNT_INS.length, metronome: METRONOMES.length, clickLevel: CLICK_LEVELS.length, holdReset: HOLD_RESETS.length,
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
