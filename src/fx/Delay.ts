import type { Effect } from './Effect';
import type { ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';

/** Tempo-synced divisions, in 16th notes. */
export const DELAY_DIVISIONS = [
  { name: '1/16', sixteenths: 1 }, { name: '1/8', sixteenths: 2 }, { name: '3/16', sixteenths: 3 },
  { name: '1/4', sixteenths: 4 }, { name: '3/8', sixteenths: 6 }, { name: '1/2', sixteenths: 8 },
  { name: '3/4', sixteenths: 12 }, { name: '1 BAR', sixteenths: 16 },
] as const;

export const DELAY_PARAMS: readonly ParamSpec[] = [
  // Discrete, but a performance control (not coarse): dub players ride the time.
  { id: 'dly_time', name: 'DLY TIME', min: 0, max: DELAY_DIVISIONS.length - 1, defaultValue: 2, unit: '', curve: 'linear', options: DELAY_DIVISIONS.map((d) => d.name) },
  { id: 'dly_fdbk', name: 'FEEDBACK', min: 0, max: 1.1, defaultValue: 0.45, unit: '', curve: 'linear' },
  { id: 'dly_tone', name: 'DLY TONE', min: 300, max: 12000, defaultValue: 2800, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'dly_return', name: 'DLY RTN', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
];

const MAX_SECONDS = 4.5;

/**
 * Stereo dub delay: time follows the tempo (glides smoothly when changed, so no clicks),
 * a low-pass in the feedback path darkens each repeat, and tanh in the loop lets feedback
 * above 1 run away gracefully instead of exploding.
 */
export class Delay implements Effect {
  readonly params = DELAY_PARAMS;
  private readonly sr: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private write = 0;
  private bpm = 120;
  private division = 2;
  private readonly time: Smoother;
  private readonly ret: Smoother;
  private fdbk = 0.45;
  private lpCoeff = 0.3;
  private lpL = 0;
  private lpR = 0;

  /** maxSeconds: the longest delay held (onboard delays keep a shorter buffer). */
  constructor(sampleRate: number, maxSeconds = MAX_SECONDS) {
    this.sr = sampleRate;
    const len = Math.ceil(maxSeconds * sampleRate);
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
    this.time = new Smoother(this.targetFrames(), 0.12, sampleRate);
    this.ret = new Smoother(0.6, 0.02, sampleRate);
  }

  setTempo(bpm: number): void {
    this.bpm = bpm;
    this.time.setTarget(this.targetFrames());
  }

  /** Jump straight to the target time (used when a project loads, not while playing). */
  settle(): void {
    this.time.setImmediate(this.targetFrames());
  }

  setParam(id: string, v: number): void {
    switch (id) {
      case 'dly_time': this.division = Math.round(v); this.time.setTarget(this.targetFrames()); break;
      case 'dly_fdbk': this.fdbk = v; break;
      case 'dly_tone': this.lpCoeff = 1 - Math.exp((-2 * Math.PI * v) / this.sr); break;
      case 'dly_return': this.ret.setTarget(v); break;
    }
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    const len = this.bufL.length;
    for (let i = 0; i < n; i++) {
      const d = Math.min(this.time.next(), len - 2);
      let rp = this.write - d;
      if (rp < 0) rp += len;
      const i0 = Math.floor(rp);
      const frac = rp - i0;
      const i1 = i0 + 1 === len ? 0 : i0 + 1;
      const yL = this.bufL[i0] + (this.bufL[i1] - this.bufL[i0]) * frac;
      const yR = this.bufR[i0] + (this.bufR[i1] - this.bufR[i0]) * frac;
      this.lpL += (yL - this.lpL) * this.lpCoeff;
      this.lpR += (yR - this.lpR) * this.lpCoeff;
      if (Math.abs(this.lpL) < 1e-15) this.lpL = 0;
      if (Math.abs(this.lpR) < 1e-15) this.lpR = 0;
      this.bufL[this.write] = inL[i] + Math.tanh(this.lpL * this.fdbk);
      this.bufR[this.write] = inR[i] + Math.tanh(this.lpR * this.fdbk);
      if (++this.write === len) this.write = 0;
      const r = this.ret.next();
      outL[off + i] += yL * r;
      outR[off + i] += yR * r;
    }
  }

  private targetFrames(): number {
    return (DELAY_DIVISIONS[this.division].sixteenths * 60 * this.sr) / (this.bpm * 4);
  }
}
