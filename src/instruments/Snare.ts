import type { Instrument } from './Instrument';
import type { ParamSpec } from '../engine/params';
import { decayMul, Noise, Svf } from './dsp';

export const SNARE_PARAMS: readonly ParamSpec[] = [
  { id: 'tune', name: 'TUNE', min: 100, max: 400, defaultValue: 185, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'decay', name: 'DECAY', min: 0.05, max: 1, defaultValue: 0.22, unit: 'S', curve: 'exp' },
  { id: 'snappy', name: 'SNAPPY', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
  { id: 'level', name: 'LEVEL', min: 0, max: 1, defaultValue: 0.8, unit: '', curve: 'linear' },
];

const TWO_PI = Math.PI * 2;

/** Snare: pitched sine body plus high-passed noise; SNAPPY is the noise/tone balance. */
export class Snare implements Instrument {
  readonly params = SNARE_PARAMS;
  private readonly sr: number;
  private readonly noise = new Noise(98765);
  private readonly hp = new Svf();
  private tune = 185;
  private snappy = 0.6;
  private level = 0.8;
  private toneMul = 0;
  private noiseMul = 0;
  private phase = 0;
  private toneEnv = 0;
  private noiseEnv = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.hp.setup(1800, 0.2, sampleRate);
    this.setParam('decay', 0.22);
  }

  noteOn(_note: number, velocity: number): void {
    this.phase = 0;
    this.toneEnv = velocity;
    this.noiseEnv = velocity;
  }

  noteOff(): void {}

  setParam(id: string, value: number): void {
    switch (id) {
      case 'tune': this.tune = value; break;
      case 'decay':
        this.noiseMul = decayMul(value, this.sr);
        this.toneMul = decayMul(value * 0.5, this.sr);
        break;
      case 'snappy': this.snappy = value; break;
      case 'level': this.level = value; break;
    }
  }

  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    if (this.noiseEnv === 0) return;
    const inc = (TWO_PI * this.tune) / this.sr;
    const toneGain = 1 - this.snappy * 0.8;
    const noiseGain = this.snappy;
    for (let i = start; i < end; i++) {
      this.phase += inc;
      if (this.phase >= TWO_PI) this.phase -= TWO_PI;
      this.hp.process(this.noise.next());
      const s = Math.sin(this.phase) * this.toneEnv * toneGain + this.hp.high * this.noiseEnv * noiseGain;
      this.toneEnv *= this.toneMul;
      this.noiseEnv *= this.noiseMul;
      const out = s * this.level;
      outL[i] += out;
      outR[i] += out;
    }
    if (this.noiseEnv < 1e-5) { this.noiseEnv = 0; this.toneEnv = 0; }
  }
}
