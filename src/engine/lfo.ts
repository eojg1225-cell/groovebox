/**
 * The LFO: one, shared by the tracks put on it (the LFO button after FX 1-3).
 * Tempo-synced rate, six shapes, PHASE, SMOOTH (slew), FADE in, RETRIG (FREE = locked to
 * the song, NOTE = restarts on each of the track's notes), SPREAD (offsets each track's
 * phase), modulating volume, pitch, filter cutoff, pan and send level.
 * Pure helpers shared by the engine (DSP) and the UI (parameter specs).
 */
import { choice, type ParamSpec } from './params';

/**
 * Cycle lengths in 16th-note steps: straight, triplet and odd ones (3 bars against the
 * 1-bar loop, dotted 3/4, 3/8, 3/16, a 5/16 that drifts against the beat).
 */
export const LFO_RATES = [
  { name: '4 BAR', steps: 64 }, { name: '3 BAR', steps: 48 }, { name: '2 BAR', steps: 32 },
  { name: '1.5 BAR', steps: 24 }, { name: '1 BAR', steps: 16 }, { name: '3/4', steps: 12 },
  { name: '1/2', steps: 8 }, { name: '3/8', steps: 6 }, { name: '1/2T', steps: 16 / 3 },
  { name: '5/16', steps: 5 }, { name: '1/4', steps: 4 }, { name: '3/16', steps: 3 },
  { name: '1/4T', steps: 8 / 3 }, { name: '1/8', steps: 2 }, { name: '1/8T', steps: 4 / 3 },
  { name: '1/16', steps: 1 }, { name: '1/16T', steps: 2 / 3 }, { name: '1/32', steps: 0.5 },
  { name: '1/64', steps: 0.25 },
] as const;

/** The rate list before v18 (stored by index), for loading older saves. */
export const LFO_RATES_V17 = ['4 BAR', '2 BAR', '1 BAR', '1/2', '1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32', '1/64'];

export const LFO_SHAPES = ['SINE', 'SQUARE', 'TRI', 'SAW DN', 'SAW UP', 'S+H'] as const;

export interface LfoState {
  rate: number; // index into LFO_RATES
  shape: number; // index into LFO_SHAPES
  morph: number; // 0..1: blends SHAPE into the next shape (sine > square > tri > saw dn > saw up > s+h > sine)
  vol: number; // 0..1 volume modulation depth
  pitch: number; // 0..48 semitones of pitch modulation
  filter: number; // 0..8 octaves of filter cutoff modulation
  pan: number; // 0..1 pan modulation depth
  phase: number; // 0..1 of a cycle
  smooth: number; // 0..1 slew
  fade: number; // 0..4 bars to fade in (from PLAY, or from each note with RETRIG NOTE)
  retrig: number; // index into LFO_RETRIG
  send: number; // 0..1 send level modulation
  spread: number; // 0..1: track n's phase is offset by spread x n / 6
  fm: number; // 0..1 modulation (FM level) depth on the synths
}

export const LFO_RETRIG = ['FREE', 'NOTE'] as const;

export type LfoId = keyof LfoState;

export const LFO_PARAMS: Record<LfoId, ParamSpec> = {
  // RATE is discrete but a performance control, so not coarse.
  rate: { id: 'rate', name: 'LFO RATE', min: 0, max: LFO_RATES.length - 1, defaultValue: 10, unit: '', curve: 'linear', options: LFO_RATES.map((r) => r.name) },
  shape: choice('shape', 'LFO SHAPE', LFO_SHAPES),
  morph: { id: 'morph', name: 'MORPH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  vol: { id: 'vol', name: 'VOL MOD', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  pitch: { id: 'pitch', name: 'PITCH MOD', min: 0, max: 48, defaultValue: 0, unit: 'ST', curve: 'linear', decimals: 1 },
  filter: { id: 'filter', name: 'FILTER MOD', min: 0, max: 8, defaultValue: 0, unit: 'OCT', curve: 'linear', decimals: 1 },
  pan: { id: 'pan', name: 'PAN MOD', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  phase: { id: 'phase', name: 'PHASE', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  smooth: { id: 'smooth', name: 'SMOOTH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  fade: { id: 'fade', name: 'FADE IN', min: 0, max: 4, defaultValue: 0, unit: 'BAR', curve: 'linear' },
  retrig: { id: 'retrig', name: 'RETRIG', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear', options: LFO_RETRIG },
  send: { id: 'send', name: 'SEND MOD', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  spread: { id: 'spread', name: 'SPREAD', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  fm: { id: 'fm', name: 'FM MOD', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
};

/**
 * LFO view knobs, 2 x 8 (top row then bottom row). Modules: RATE / SHAPE, PHASE / SMOOTH,
 * FADE IN / RETRIG, VOL / PITCH, FILTER / PAN, SEND / SPREAD, MORPH / FM MOD (8 empty).
 */
export const LFO_LAYOUT: readonly (LfoId | null)[] = [
  'rate', 'phase', 'fade', 'vol', 'filter', 'send', 'morph', null,
  'shape', 'smooth', 'retrig', 'pitch', 'pan', 'spread', 'fm', null,
];

export function defaultLfo(): LfoState {
  return { rate: 10, shape: 0, morph: 0, fm: 0, vol: 0, pitch: 0, filter: 0, pan: 0, phase: 0, smooth: 0, fade: 0, retrig: 0, send: 0, spread: 0 };
}

/**
 * LFO value -1..1 at cycle phase 0..1 (S+H uses `held`, chosen per cycle). MORPH blends
 * the shape into the next one in the list (S+H wraps round to SINE).
 */
export function lfoValue(shape: number, phase: number, held: number, morph = 0): number {
  const a = baseShape(shape, phase, held);
  if (morph <= 0) return a;
  return a + (baseShape((shape + 1) % LFO_SHAPES.length, phase, held) - a) * morph;
}

/**
 * Shapes for stabs: each starts at its peak (+1 = full volume, open filter ...) so a
 * retriggered LFO hits with the note - except SAW UP, which rises to end at its peak.
 */
function baseShape(shape: number, phase: number, held: number): number {
  switch (shape) {
    case 1: return phase < 0.5 ? 1 : -1;
    case 2: return 4 * Math.abs(phase - 0.5) - 1;
    case 3: return 1 - 2 * phase;
    case 4: return 2 * phase - 1;
    case 5: return held;
    default: return Math.cos(2 * Math.PI * phase);
  }
}
