import { choice, type ParamSpec } from './params';
import { METERS } from './project';

export const GATE_MIN = 0.125;
export const GATE_MAX = 2;

/** Per-channel mixer parameters. */
export const MIX_PARAMS: readonly ParamSpec[] = [
  { id: 'volume', name: 'VOLUME', min: 0, max: 1, defaultValue: 0.8, unit: '', curve: 'linear' },
  { id: 'pan', name: 'PAN', min: -1, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'send', name: 'SEND LVL', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  // ACCENT / GHOST depth: how far accents and ghosts sit from a normal hit (100 % = as
  // designed, 0 % = every hit the same, 200 % = twice the difference in dB).
  { id: 'dyn', name: 'ACC/GHOST', min: 0, max: 200, defaultValue: 100, unit: '%', curve: 'linear', decimals: 0 },
  // TRIM (id "gate"): how long a sequenced note's last step is held, in steps (1 = the whole step, as
  // entered). Ties and RING / SLIDE notes keep their length; only the end moves.
  // MID CUT: the track's own cut after its DRIVE (depth and width together; the centre is
  // the sound's MID FREQ, SOUND page FUNC).
  { id: 'cut', name: 'MID CUT', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'gate', name: 'TRIM', min: GATE_MIN, max: GATE_MAX, defaultValue: 1, unit: ' ST', curve: 'linear', decimals: 2 },
];

export type MixId = 'volume' | 'pan' | 'send' | 'dyn' | 'gate' | 'cut';

/** The channel field each mixer parameter lives in. */
export const MIX_FIELD = { volume: 'volume', pan: 'pan', send: 'sendLevel', dyn: 'dynamics', gate: 'gateLength', cut: 'midCut' } as const;

/** Velocity of a normal hit (ghost 0.45, accent 1.0). */
const NORMAL_VELOCITY = 0.8;

/**
 * A hit's velocity after the track's ACC/GHOST depth: its distance from a normal hit is
 * scaled in dB (depth 1 = unchanged, 0 = normal, 2 = twice as far either way).
 */
export function dynVelocity(velocity: number, depth: number): number {
  if (depth === 1 || velocity <= 0) return velocity;
  return NORMAL_VELOCITY * Math.pow(velocity / NORMAL_VELOCITY, depth);
}

export const BPM_MIN = 40;
export const BPM_MAX = 300;

/** Project-wide parameters (PROJECT page; TEMPO and MASTER also have master knobs). */
export const GLOBAL_PARAMS: readonly ParamSpec[] = [
  // Whole BPM only (a DAW gets the same tempo, so tempo-synced effects line up).
  { id: 'bpm', name: 'TEMPO', min: BPM_MIN, max: BPM_MAX, defaultValue: 128, unit: '', curve: 'linear', decimals: 0 },
  { id: 'swing', name: 'SWING', min: 50, max: 75, defaultValue: 50, unit: '%', curve: 'linear', decimals: 0 },
  { id: 'master', name: 'MASTER', min: 0, max: 1, defaultValue: 0.8, unit: '', curve: 'linear' },
  choice('meter', 'TIME SIG', METERS.map((m) => m.name)),
];

