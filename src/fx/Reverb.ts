import type { Effect } from './Effect';
import type { ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';

const REVERB_PARAMS: readonly ParamSpec[] = [
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
  /** Freeverb's damped comb over a block: adds each output to acc[j] (state in locals). */
  block(x: Float64Array, acc: Float64Array, n: number, feedback: number, damp: number): void {
    const buf = this.buf, len = buf.length;
    let i = this.i, store = this.store;
    for (let j = 0; j < n; j++) {
      const y = buf[i];
      store = y * (1 - damp) + store * damp;
      if (Math.abs(store) < 1e-15) store = 0;
      buf[i] = x[j] + store * feedback;
      if (++i === len) i = 0;
      acc[j] += y;
    }
    this.i = i;
    this.store = store;
  }
}

class Allpass {
  private readonly buf: Float32Array;
  private i = 0;
  constructor(len: number) { this.buf = new Float32Array(len); }
  reset(): void { this.buf.fill(0); }
  /** The allpass (g = 0.5) over a block, in place. */
  block(v: Float64Array, n: number): void {
    const buf = this.buf, len = buf.length;
    let i = this.i;
    for (let j = 0; j < n; j++) {
      const b = buf[i];
      buf[i] = v[j] + b * 0.5;
      if (++i === len) i = 0;
      v[j] = b - v[j];
    }
    this.i = i;
  }
}

/** The reverb runs in blocks of up to this many samples (each comb / allpass over a block at a time). */
const BLOCK = 128;

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
  /** A block's pre-delayed input and its left / right sums. */
  private readonly bx = new Float64Array(BLOCK);
  private readonly bl = new Float64Array(BLOCK);
  private readonly br = new Float64Array(BLOCK);

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

  /**
   * Reads every input of a block before writing its outputs, so in and out may be the same
   * arrays (at the same offset). Each comb and allpass runs over the block in turn: the same
   * sums in the same order as sample by sample.
   */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    for (let from = 0; from < n; from += BLOCK) this.processBlock(inL, inR, outL, outR, off, from, Math.min(BLOCK, n - from));
  }

  private processBlock(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, from: number, n: number): void {
    const len = this.pre.length;
    const wet1 = (this.width / 2 + 0.5) * 3;
    const wet2 = ((1 - this.width) / 2) * 3;
    const x = this.bx, l = this.bl, r = this.br;
    for (let j = 0; j < n; j++) {
      this.pre[this.preWrite] = (inL[from + j] + inR[from + j]) * INPUT_GAIN;
      let rp = this.preWrite - this.preDelay;
      if (rp < 0) rp += len;
      x[j] = this.pre[rp];
      if (++this.preWrite === len) this.preWrite = 0;
      l[j] = 0;
      r[j] = 0;
    }
    for (let k = 0; k < 8; k++) {
      this.combsL[k].block(x, l, n, this.feedback, this.damp);
      this.combsR[k].block(x, r, n, this.feedback, this.damp);
    }
    for (let k = 0; k < 4; k++) {
      this.apL[k].block(l, n);
      this.apR[k].block(r, n);
    }
    for (let j = 0; j < n; j++) {
      const g = this.ret.next();
      outL[off + from + j] += (l[j] * wet1 + r[j] * wet2) * g;
      outR[off + from + j] += (r[j] * wet1 + l[j] * wet2) * g;
    }
  }
}
