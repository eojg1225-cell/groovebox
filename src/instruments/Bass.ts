import type { Instrument } from './Instrument';
import type { ParamSpec } from '../engine/params';
import { decayMul, midiToHz, polyBlep, Svf } from './dsp';

export const BASS_PARAMS: readonly ParamSpec[] = [
  { id: 'tune', name: 'TUNE', min: -12, max: 12, defaultValue: 0, unit: 'ST', curve: 'linear', decimals: 1 },
  { id: 'wave', name: 'WAVE', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'cutoff', name: 'CUTOFF', min: 50, max: 6000, defaultValue: 380, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'reso', name: 'RESO', min: 0, max: 0.95, defaultValue: 0.55, unit: '', curve: 'linear' },
  { id: 'env', name: 'ENV', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'decay', name: 'DECAY', min: 0.03, max: 1.5, defaultValue: 0.25, unit: 'S', curve: 'exp' },
  { id: 'level', name: 'LEVEL', min: 0, max: 1, defaultValue: 0.7, unit: '', curve: 'linear' },
];

const ATTACK_SECONDS = 0.002;
const FILTER_UPDATE = 16; // samples between filter coefficient updates

/**
 * Basic monophonic bass: polyBLEP saw/square blend into a resonant low-pass with a
 * decaying filter envelope. Placeholder until the full virtual analog (M3) and 303 (M6).
 */
export class Bass implements Instrument {
  readonly params = BASS_PARAMS;
  private readonly sr: number;
  private readonly filter = new Svf();
  private tune = 0;
  private wave = 0;
  private cutoff = 380;
  private reso = 0.55;
  private envAmt = 0.5;
  private level = 0.7;
  private ampMul = 0;
  private fenvMul = 0;
  private readonly attackInc: number;
  private freq = 65.4;
  private phase = 0;
  private amp = 0;
  private attack = 1;
  private fenv = 0;
  private counter = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.attackInc = 1 / (ATTACK_SECONDS * sampleRate);
    this.setParam('decay', 0.25);
  }

  noteOn(note: number, velocity: number): void {
    this.freq = midiToHz(note + this.tune);
    this.amp = velocity;
    this.attack = 0;
    this.fenv = 1;
    this.counter = 0;
  }

  noteOff(): void {}

  setParam(id: string, value: number): void {
    switch (id) {
      case 'tune': this.tune = value; break;
      case 'wave': this.wave = value; break;
      case 'cutoff': this.cutoff = value; break;
      case 'reso': this.reso = value; break;
      case 'env': this.envAmt = value; break;
      case 'decay':
        this.fenvMul = decayMul(value, this.sr);
        this.ampMul = decayMul(value * 2 + 0.1, this.sr);
        break;
      case 'level': this.level = value; break;
    }
  }

  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    if (this.amp === 0) return;
    const dt = this.freq / this.sr;
    for (let i = start; i < end; i++) {
      if (this.counter-- <= 0) {
        this.counter = FILTER_UPDATE;
        // Envelope sweeps the cutoff up to ~5 octaves.
        const fc = this.cutoff * Math.pow(2, this.envAmt * 5 * this.fenv);
        this.filter.setup(fc, this.reso, this.sr);
      }
      this.phase += dt;
      if (this.phase >= 1) this.phase -= 1;
      const saw = 2 * this.phase - 1 - polyBlep(this.phase, dt);
      let p2 = this.phase + 0.5;
      if (p2 >= 1) p2 -= 1;
      const square = saw - (2 * p2 - 1 - polyBlep(p2, dt));
      const osc = saw * (1 - this.wave) + square * 0.5 * this.wave;

      this.filter.process(osc);
      if (this.attack < 1) this.attack = Math.min(1, this.attack + this.attackInc);
      const out = this.filter.low * this.amp * this.attack * this.level;
      this.amp *= this.ampMul;
      this.fenv *= this.fenvMul;
      outL[i] += out;
      outR[i] += out;
    }
    if (this.amp < 1e-5) { this.amp = 0; this.filter.reset(); }
  }
}
