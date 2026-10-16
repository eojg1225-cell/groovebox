import type { Effect } from './Effect';
import type { ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';

export const MIDCUT_PARAMS: readonly ParamSpec[] = [
  { id: 'mid_freq', name: 'MID FREQ', min: 150, max: 6000, defaultValue: 1000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'mid_width', name: 'WIDTH', min: 0.3, max: 4, defaultValue: 1, unit: 'Q', curve: 'exp', decimals: 1 },
  { id: 'mid_depth', name: 'DEPTH', min: 0, max: 30, defaultValue: 12, unit: 'DB', curve: 'linear', decimals: 0 },
  { id: 'mid_return', name: 'MID RTN', min: 0, max: 1, defaultValue: 0.7, unit: '', curve: 'linear' },
];

const UPDATE = 32; // samples between coefficient updates

/** Parametric cut: an RBJ peaking biquad with negative gain, parameters smoothed. */
export class MidCut implements Effect {
  readonly params = MIDCUT_PARAMS;
  private readonly sr: number;
  private readonly freq: Smoother;
  private readonly depth: Smoother;
  private readonly ret: Smoother;
  private q = 1;
  private counter = 0;
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1L = 0; private x2L = 0; private y1L = 0; private y2L = 0;
  private x1R = 0; private x2R = 0; private y1R = 0; private y2R = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.freq = new Smoother(1000, 0.03, sampleRate);
    this.depth = new Smoother(12, 0.03, sampleRate);
    this.ret = new Smoother(0.7, 0.02, sampleRate);
  }

  setParam(id: string, v: number): void {
    switch (id) {
      case 'mid_freq': this.freq.setTarget(v); break;
      case 'mid_width': this.q = v; this.counter = 0; break;
      case 'mid_depth': this.depth.setTarget(v); break;
      case 'mid_return': this.ret.setTarget(v); break;
    }
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const f = this.freq.next();
      const dB = this.depth.next();
      if (this.counter-- <= 0) {
        this.counter = UPDATE;
        this.coefficients(f, this.q, -dB);
      }
      const xl = inL[i];
      const yl = this.b0 * xl + this.b1 * this.x1L + this.b2 * this.x2L - this.a1 * this.y1L - this.a2 * this.y2L;
      this.x2L = this.x1L; this.x1L = xl; this.y2L = this.y1L; this.y1L = yl;
      const xr = inR[i];
      const yr = this.b0 * xr + this.b1 * this.x1R + this.b2 * this.x2R - this.a1 * this.y1R - this.a2 * this.y2R;
      this.x2R = this.x1R; this.x1R = xr; this.y2R = this.y1R; this.y1R = yr;
      const r = this.ret.next();
      outL[off + i] += yl * r;
      outR[off + i] += yr * r;
    }
    if (Math.abs(this.y1L) < 1e-15) { this.y1L = 0; this.y2L = 0; }
    if (Math.abs(this.y1R) < 1e-15) { this.y1R = 0; this.y2R = 0; }
  }

  private coefficients(f: number, q: number, gainDb: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * cos) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha / A) / a0;
  }
}
