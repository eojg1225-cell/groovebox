import type { Instrument } from './Instrument';
import type { ParamSpec } from '../engine/params';
import { decayMul, Noise, Svf } from './dsp';

export const HAT_PARAMS: readonly ParamSpec[] = [
  { id: 'decay', name: 'DECAY', min: 0.01, max: 1, defaultValue: 0.05, unit: 'S', curve: 'exp' },
  { id: 'tone', name: 'TONE', min: 3000, max: 14000, defaultValue: 7500, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'level', name: 'LEVEL', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
];

/** Hi-hat: high-passed noise with an exponential decay (short = closed, long = open). */
export class Hat implements Instrument {
  readonly params = HAT_PARAMS;
  private readonly sr: number;
  private readonly noise = new Noise(4242);
  private readonly hp = new Svf();
  private level = 0.6;
  private mul = 0;
  private env = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.setParam('decay', 0.05);
    this.setParam('tone', 7500);
  }

  noteOn(_note: number, velocity: number): void {
    this.env = velocity;
  }

  noteOff(): void {}

  setParam(id: string, value: number): void {
    switch (id) {
      case 'decay': this.mul = decayMul(value, this.sr); break;
      case 'tone': this.hp.setup(value, 0.3, this.sr); break;
      case 'level': this.level = value; break;
    }
  }

  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    if (this.env === 0) return;
    for (let i = start; i < end; i++) {
      this.hp.process(this.noise.next());
      const out = this.hp.high * this.env * this.level;
      this.env *= this.mul;
      outL[i] += out;
      outR[i] += out;
    }
    if (this.env < 1e-5) this.env = 0;
  }
}
