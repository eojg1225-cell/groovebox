import type { Effect } from './Effect';
import type { ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';

export const REVERB_PARAMS: readonly ParamSpec[] = [
  { id: 'rev_size', name: 'SIZE', min: 0, max: 1, defaultValue: 0.7, unit: '', curve: 'linear' },
  { id: 'rev_damp', name: 'DAMPING', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'rev_predelay', name: 'PREDELAY', min: 0, max: 120, defaultValue: 15, unit: 'MS', curve: 'linear', decimals: 0 },
  { id: 'rev_width', name: 'WIDTH', min: 0, max: 1, defaultValue: 1, unit: '', curve: 'linear' },
  { id: 'rev_return', name: 'REV RTN', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
];

// Freeverb tunings (samples at 44.1 kHz), scaled to the actual sample rate.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
const INPUT_GAIN = 0.015;

class Comb {
  private readonly buf: Float32Array;
  private i = 0;
  private store = 0;
  constructor(len: number) { this.buf = new Float32Array(len); }
  reset(): void { this.buf.fill(0); this.store = 0; }
  process(x: number, feedback: number, damp: number): number {
    const y = this.buf[this.i];
    this.store = y * (1 - damp) + this.store * damp;
    if (Math.abs(this.store) < 1e-15) this.store = 0;
    this.buf[this.i] = x + this.store * feedback;
    if (++this.i === this.buf.length) this.i = 0;
    return y;
  }
}

class Allpass {
  private readonly buf: Float32Array;
  private i = 0;
  constructor(len: number) { this.buf = new Float32Array(len); }
  reset(): void { this.buf.fill(0); }
  process(x: number): number {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i === this.buf.length) this.i = 0;
    return b - x;
  }
}

/** Freeverb-style stereo reverb with pre-delay. */
export class Reverb implements Effect {
  readonly params = REVERB_PARAMS;
  private readonly sr: number;
  private readonly combsL: Comb[] = [];
  private readonly combsR: Comb[] = [];
  private readonly apL: Allpass[] = [];
  private readonly apR: Allpass[] = [];
  private readonly pre: Float32Array;
  private preWrite = 0;
  private preDelay = 0;
  private feedback = 0.9;
  private damp = 0.5;
  private width = 1;
  private readonly ret: Smoother;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    const scale = sampleRate / 44100;
    for (const c of COMBS) {
      this.combsL.push(new Comb(Math.round(c * scale)));
      this.combsR.push(new Comb(Math.round((c + STEREO_SPREAD) * scale)));
    }
    for (const a of ALLPASSES) {
      this.apL.push(new Allpass(Math.round(a * scale)));
      this.apR.push(new Allpass(Math.round((a + STEREO_SPREAD) * scale)));
    }
    this.pre = new Float32Array(Math.ceil(0.13 * sampleRate));
    this.ret = new Smoother(0.5, 0.02, sampleRate);
    for (const p of REVERB_PARAMS) this.setParam(p.id, p.defaultValue);
  }

  setParam(id: string, v: number): void {
    switch (id) {
      case 'rev_size': this.feedback = 0.7 + v * 0.28; break;
      case 'rev_damp': this.damp = v * 0.4; break;
      case 'rev_predelay': this.preDelay = Math.round((v / 1000) * this.sr); break;
      case 'rev_width': this.width = v; break;
      case 'rev_return': this.ret.setTarget(v); break;
    }
  }

  reset(): void {
    for (const c of this.combsL) c.reset();
    for (const c of this.combsR) c.reset();
    for (const a of this.apL) a.reset();
    for (const a of this.apR) a.reset();
    this.pre.fill(0);
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    const len = this.pre.length;
    const wet1 = (this.width / 2 + 0.5) * 3;
    const wet2 = ((1 - this.width) / 2) * 3;
    for (let i = 0; i < n; i++) {
      this.pre[this.preWrite] = (inL[i] + inR[i]) * INPUT_GAIN;
      let rp = this.preWrite - this.preDelay;
      if (rp < 0) rp += len;
      const x = this.pre[rp];
      if (++this.preWrite === len) this.preWrite = 0;
      let l = 0;
      let r = 0;
      for (let k = 0; k < 8; k++) {
        l += this.combsL[k].process(x, this.feedback, this.damp);
        r += this.combsR[k].process(x, this.feedback, this.damp);
      }
      for (let k = 0; k < 4; k++) {
        l = this.apL[k].process(l);
        r = this.apR[k].process(r);
      }
      const g = this.ret.next();
      outL[off + i] += (l * wet1 + r * wet2) * g;
      outR[off + i] += (r * wet1 + l * wet2) * g;
    }
  }
}
