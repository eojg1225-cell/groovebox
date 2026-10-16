/**
 * The LFO: one, shared by the tracks put on it (the LFO button after FX 1-3).
 * Tempo-synced rate, six shapes, PHASE, SMOOTH (slew), FADE in, RETRIG (FREE = locked to
 * the song, NOTE = restarts on each of the track's notes), SPREAD (offsets each track's
 * phase), modulating volume, pitch, filter cutoff, pan and send level.
 * Pure helpers shared by the engine (DSP) and the UI (parameter specs).
 */
import { choice, type ParamSpec } from './params';

/** Cycle lengths in 16th-note steps. */
export const LFO_RATES = [
  { name: '4 BAR', steps: 64 }, { name: '2 BAR', steps: 32 }, { name: '1 BAR', steps: 16 },
  { name: '1/2', steps: 8 }, { name: '1/4', steps: 4 }, { name: '1/4T', steps: 8 / 3 },
  { name: '1/8', steps: 2 }, { name: '1/8T', steps: 4 / 3 }, { name: '1/16', steps: 1 },
  { name: '1/16T', steps: 2 / 3 }, { name: '1/32', steps: 0.5 }, { name: '1/64', steps: 0.25 },
] as const;

export const LFO_SHAPES = ['SINE', 'SQUARE', 'TRI', 'SAW DN', 'SAW UP', 'S+H'] as const;

export interface LfoState {
  rate: number; // index into LFO_RATES
  shape: number; // index into LFO_SHAPES
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
}

export const LFO_RETRIG = ['FREE', 'NOTE'] as const;

export type LfoId = keyof LfoState;

export const LFO_PARAMS: Record<LfoId, ParamSpec> = {
  // RATE is discrete but a performance control, so not coarse.
  rate: { id: 'rate', name: 'LFO RATE', min: 0, max: LFO_RATES.length - 1, defaultValue: 4, unit: '', curve: 'linear', options: LFO_RATES.map((r) => r.name) },
  shape: choice('shape', 'LFO SHAPE', LFO_SHAPES),
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
};

/**
 * LFO view knobs (top row then bottom row). Modules: RATE / SHAPE, PHASE / SMOOTH,
 * FADE IN / RETRIG, VOL / PITCH, FILTER / PAN, SEND / SPREAD.
 */
export const LFO_LAYOUT: readonly LfoId[] = [
  'rate', 'phase', 'fade', 'vol', 'filter', 'send',
  'shape', 'smooth', 'retrig', 'pitch', 'pan', 'spread',
];

export function defaultLfo(): LfoState {
  return { rate: 4, shape: 0, vol: 0, pitch: 0, filter: 0, pan: 0, phase: 0, smooth: 0, fade: 0, retrig: 0, send: 0, spread: 0 };
}

/** LFO value -1..1 at cycle phase 0..1 (S+H uses `held`, chosen per cycle). */
export function lfoValue(shape: number, phase: number, held: number): number {
  switch (shape) {
    case 1: return phase < 0.5 ? 1 : -1;
    case 2: return 1 - 4 * Math.abs(phase - 0.5);
    case 3: return 1 - 2 * phase;
    case 4: return 2 * phase - 1;
    case 5: return held;
    default: return Math.sin(2 * Math.PI * phase);
  }
}
