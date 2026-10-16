/**
 * Per-track LFO: tempo-synced rate, six shapes, modulating volume and pitch.
 * Pure helpers shared by the engine (DSP) and the UI (parameter specs).
 */
import { choice, type ParamSpec } from './params';

/** Cycle lengths in 16th-note steps. */
export const LFO_RATES = [
  { name: '4 BAR', steps: 64 }, { name: '2 BAR', steps: 32 }, { name: '1 BAR', steps: 16 },
  { name: '1/2', steps: 8 }, { name: '1/4', steps: 4 }, { name: '1/4T', steps: 8 / 3 },
  { name: '1/8', steps: 2 }, { name: '1/8T', steps: 4 / 3 }, { name: '1/16', steps: 1 },
  { name: '1/16T', steps: 2 / 3 }, { name: '1/32', steps: 0.5 },
] as const;

export const LFO_SHAPES = ['SINE', 'SQUARE', 'TRI', 'SAW DN', 'SAW UP', 'S+H'] as const;

export interface LfoState {
  rate: number; // index into LFO_RATES
  shape: number; // index into LFO_SHAPES
  vol: number; // 0..1 volume modulation depth
  pitch: number; // 0..12 semitones of pitch modulation
}

export type LfoId = keyof LfoState;

export const LFO_PARAMS: Record<LfoId, ParamSpec> = {
  // RATE is discrete but a performance control, so not coarse.
  rate: { id: 'rate', name: 'LFO RATE', min: 0, max: LFO_RATES.length - 1, defaultValue: 4, unit: '', curve: 'linear', options: LFO_RATES.map((r) => r.name) },
  shape: choice('shape', 'LFO SHAPE', LFO_SHAPES),
  vol: { id: 'vol', name: 'VOL MOD', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  pitch: { id: 'pitch', name: 'PITCH MOD', min: 0, max: 12, defaultValue: 0, unit: 'ST', curve: 'linear', decimals: 1 },
};

export function defaultLfo(): LfoState {
  return { rate: 4, shape: 0, vol: 0, pitch: 0 };
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
