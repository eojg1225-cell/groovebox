import type { Effect } from './Effect';
import type { ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';
import { read } from './Chorus';

export const FLANGER_PARAMS: readonly ParamSpec[] = [
  { id: 'flg_rate', name: 'FLG RATE', min: 0.02, max: 4, defaultValue: 0.15, unit: 'HZ', curve: 'exp' },
  { id: 'flg_depth', name: 'FLG DEPTH', min: 0, max: 1, defaultValue: 0.7, unit: '', curve: 'linear' },
  { id: 'flg_manual', name: 'MANUAL', min: 0.3, max: 8, defaultValue: 2, unit: 'MS', curve: 'exp', decimals: 1 },
  { id: 'flg_fdbk', name: 'FLG FDBK', min: -0.95, max: 0.95, defaultValue: 0.6, unit: '', curve: 'linear' },
  { id: 'flg_return', name: 'FLG RTN', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
];

/** Jet flanger: short modulated delay with feedback (negative = hollow, positive = metallic). */
export class Flanger implements Effect {
  readonly params = FLANGER_PARAMS;
  private readonly sr: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private write = 0;
  private phase = 0;
  private rate = 0.15;
  private depth = 0.7;
  private fdbk = 0.6;
  private readonly manual: Smoother;
  private readonly ret: Smoother;
  private fbL = 0;
  private fbR = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    const len = Math.ceil(0.02 * sampleRate);
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
    this.manual = new Smoother(2, 0.05, sampleRate);
    this.ret = new Smoother(0.6, 0.02, sampleRate);
  }

  setParam(id: string, v: number): void {
    switch (id) {
      case 'flg_rate': this.rate = v; break;
      case 'flg_depth': this.depth = v; break;
      case 'flg_manual': this.manual.setTarget(v); break;
      case 'flg_fdbk': this.fdbk = v; break;
      case 'flg_return': this.ret.setTarget(v); break;
    }
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    const len = this.bufL.length;
    const msToSamples = this.sr / 1000;
    const inc = this.rate / this.sr;
    for (let i = 0; i < n; i++) {
      this.phase += inc;
      if (this.phase >= 1) this.phase -= 1;
      const lfo = 0.5 * (1 + Math.sin(2 * Math.PI * this.phase)); // 0..1
      const ms = this.manual.next() * (1 - this.depth * 0.9 * lfo);
      const d = Math.max(1, ms * msToSamples);
      this.bufL[this.write] = inL[i] + Math.tanh(this.fbL * this.fdbk);
      this.bufR[this.write] = inR[i] + Math.tanh(this.fbR * this.fdbk);
      const yL = read(this.bufL, this.write, d, len);
      const yR = read(this.bufR, this.write, d * 1.03, len);
      this.fbL = Math.abs(yL) < 1e-15 ? 0 : yL;
      this.fbR = Math.abs(yR) < 1e-15 ? 0 : yR;
      if (++this.write === len) this.write = 0;
      const r = this.ret.next();
      // Mix with the dry send so the comb notches are heard.
      outL[off + i] += (yL + inL[i]) * 0.5 * r;
      outR[off + i] += (yR + inR[i]) * 0.5 * r;
    }
  }
}
