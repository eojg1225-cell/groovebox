import type { Effect } from './Effect';
import type { ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';

export const CHORUS_PARAMS: readonly ParamSpec[] = [
  { id: 'cho_rate', name: 'CHO RATE', min: 0.05, max: 5, defaultValue: 0.6, unit: 'HZ', curve: 'exp' },
  { id: 'cho_depth', name: 'CHO DEPTH', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'cho_width', name: 'WIDTH', min: 0, max: 1, defaultValue: 0.8, unit: '', curve: 'linear' },
  { id: 'cho_return', name: 'CHO RTN', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
];

const BASE_MS = 12;
const DEPTH_MS = 7;

/** Stereo chorus: one modulated delay per side, LFOs offset by WIDTH (0 = mono, 1 = 180°). */
export class Chorus implements Effect {
  readonly params = CHORUS_PARAMS;
  private readonly sr: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private write = 0;
  private phase = 0;
  private rate = 0.6;
  private depth = 0.5;
  private width = 0.8;
  private readonly ret: Smoother;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    const len = Math.ceil(((BASE_MS + DEPTH_MS + 2) / 1000) * sampleRate);
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
    this.ret = new Smoother(0.6, 0.02, sampleRate);
  }

  setParam(id: string, v: number): void {
    switch (id) {
      case 'cho_rate': this.rate = v; break;
      case 'cho_depth': this.depth = v; break;
      case 'cho_width': this.width = v; break;
      case 'cho_return': this.ret.setTarget(v); break;
    }
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    const len = this.bufL.length;
    const base = (BASE_MS / 1000) * this.sr;
    const depth = (DEPTH_MS / 1000) * this.sr * this.depth;
    const inc = this.rate / this.sr;
    for (let i = 0; i < n; i++) {
      this.bufL[this.write] = inL[i];
      this.bufR[this.write] = inR[i];
      this.phase += inc;
      if (this.phase >= 1) this.phase -= 1;
      const a = 2 * Math.PI * this.phase;
      const yL = read(this.bufL, this.write, base + depth * 0.5 * (1 + Math.sin(a)), len);
      const yR = read(this.bufR, this.write, base + depth * 0.5 * (1 + Math.sin(a + Math.PI * this.width)), len);
      if (++this.write === len) this.write = 0;
      const r = this.ret.next();
      outL[off + i] += yL * r;
      outR[off + i] += yR * r;
    }
  }
}

/** Linear-interpolated read `delay` samples behind `write`. */
export function read(buf: Float32Array, write: number, delay: number, len: number): number {
  let rp = write - delay;
  if (rp < 0) rp += len;
  const i0 = Math.floor(rp);
  const i1 = i0 + 1 === len ? 0 : i0 + 1;
  const f = rp - i0;
  return buf[i0] + (buf[i1] - buf[i0]) * f;
}
