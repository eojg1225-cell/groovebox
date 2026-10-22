import type { Effect } from './Effect';
import type { ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';

const DIST_PARAMS: readonly ParamSpec[] = [
  { id: 'dst_drive', name: 'DRIVE', min: 1, max: 50, defaultValue: 8, unit: 'X', curve: 'exp', decimals: 1 },
  { id: 'dst_tone', name: 'DST TONE', min: 300, max: 12000, defaultValue: 4000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'dst_char', name: 'CHARACTER', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'dst_return', name: 'DST RTN', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
];

/** Waveshaper: blend of soft (tanh) and hard clipping, then a one-pole tone filter. */
export class Distortion implements Effect {
  readonly params = DIST_PARAMS;
  private readonly sr: number;
  private readonly drive: Smoother;
  private readonly ret: Smoother;
  private char = 0.3;
  private lpCoeff = 0.4;
  private lpL = 0;
  private lpR = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.drive = new Smoother(8, 0.02, sampleRate);
    this.ret = new Smoother(0.5, 0.02, sampleRate);
    this.setParam('dst_tone', 4000);
  }

  setParam(id: string, v: number): void {
    switch (id) {
      case 'dst_drive': this.drive.setTarget(v); break;
      case 'dst_tone': this.lpCoeff = 1 - Math.exp((-2 * Math.PI * v) / this.sr); break;
      case 'dst_char': this.char = v; break;
      case 'dst_return': this.ret.setTarget(v); break;
    }
  }

  reset(): void {
    this.lpL = this.lpR = 0;
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    const c = this.char;
    for (let i = 0; i < n; i++) {
      const d = this.drive.next();
      const r = this.ret.next() * 0.6;
      const xl = inL[i] * d;
      const xr = inR[i] * d;
      const sl = Math.tanh(xl) * (1 - c) + (xl > 1 ? 1 : xl < -1 ? -1 : xl) * c;
      const sr = Math.tanh(xr) * (1 - c) + (xr > 1 ? 1 : xr < -1 ? -1 : xr) * c;
      this.lpL += (sl - this.lpL) * this.lpCoeff;
      this.lpR += (sr - this.lpR) * this.lpCoeff;
      outL[off + i] += this.lpL * r;
      outR[off + i] += this.lpR * r;
    }
    if (Math.abs(this.lpL) < 1e-15) this.lpL = 0;
    if (Math.abs(this.lpR) < 1e-15) this.lpR = 0;
  }
}
