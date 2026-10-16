import type { Effect } from './Effect';
import type { ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';

export const COMP_PARAMS: readonly ParamSpec[] = [
  { id: 'cmp_threshold', name: 'THRESHOLD', min: -48, max: 0, defaultValue: -28, unit: 'DB', curve: 'linear', decimals: 0 },
  { id: 'cmp_ratio', name: 'RATIO', min: 1, max: 20, defaultValue: 6, unit: ':1', curve: 'exp', decimals: 1 },
  { id: 'cmp_return', name: 'CMP RTN', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
];

const ATTACK_S = 0.003;
const RELEASE_S = 0.12;

/**
 * Stereo-linked peak compressor used in parallel ("New York" style): the squashed signal
 * is added under the dry mix, thickening drums without killing their transients.
 */
export class Compressor implements Effect {
  readonly params = COMP_PARAMS;
  private readonly attack: number;
  private readonly release: number;
  private env = 0;
  private threshold = -28;
  private ratio = 6;
  private readonly ret: Smoother;

  constructor(sampleRate: number) {
    this.attack = 1 - Math.exp(-1 / (ATTACK_S * sampleRate));
    this.release = 1 - Math.exp(-1 / (RELEASE_S * sampleRate));
    this.ret = new Smoother(0.5, 0.02, sampleRate);
  }

  setParam(id: string, v: number): void {
    switch (id) {
      case 'cmp_threshold': this.threshold = v; break;
      case 'cmp_ratio': this.ratio = v; break;
      case 'cmp_return': this.ret.setTarget(v); break;
    }
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    // Make-up gain: about half the reduction a full-scale signal would get.
    const makeup = Math.pow(10, (-this.threshold * (1 - 1 / this.ratio)) / 40);
    for (let i = 0; i < n; i++) {
      const l = inL[i];
      const r = inR[i];
      const peak = Math.max(Math.abs(l), Math.abs(r));
      this.env += (peak - this.env) * (peak > this.env ? this.attack : this.release);
      if (this.env < 1e-9) this.env = 0;
      let gain = 1;
      if (this.env > 0) {
        const db = 20 * Math.log10(this.env);
        if (db > this.threshold) gain = Math.pow(10, ((this.threshold - db) * (1 - 1 / this.ratio)) / 20);
      }
      const g = gain * makeup * this.ret.next();
      outL[off + i] += Math.tanh(l * g);
      outR[off + i] += Math.tanh(r * g);
    }
  }
}
