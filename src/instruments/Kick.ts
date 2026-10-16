import type { Instrument } from './Instrument';
import type { ParamSpec } from '../engine/params';
import { decayMul, Noise } from './dsp';

export const KICK_PARAMS: readonly ParamSpec[] = [
  { id: 'tune', name: 'TUNE', min: 30, max: 120, defaultValue: 48, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'decay', name: 'DECAY', min: 0.05, max: 2, defaultValue: 0.45, unit: 'S', curve: 'exp' },
  { id: 'punch', name: 'PUNCH', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
  { id: 'click', name: 'CLICK', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'level', name: 'LEVEL', min: 0, max: 1, defaultValue: 0.9, unit: '', curve: 'linear' },
];

const TWO_PI = Math.PI * 2;

/** Sine kick with an exponential pitch sweep (punch) and a short noise click. */
export class Kick implements Instrument {
  readonly params = KICK_PARAMS;
  private readonly sr: number;
  private readonly noise = new Noise(1234);
  private tune = 48;
  private punch = 0.6;
  private click = 0.3;
  private level = 0.9;
  private ampMul = 0;
  private readonly pitchMul: number;
  private readonly clickMul: number;
  private phase = 0;
  private amp = 0;
  private pitchEnv = 0;
  private clickEnv = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.pitchMul = decayMul(0.12, sampleRate);
    this.clickMul = decayMul(0.008, sampleRate);
    this.setParam('decay', 0.45);
  }

  noteOn(_note: number, velocity: number): void {
    this.phase = 0;
    this.amp = velocity;
    this.pitchEnv = 1;
    this.clickEnv = velocity;
  }

  noteOff(): void {}

  setParam(id: string, value: number): void {
    switch (id) {
      case 'tune': this.tune = value; break;
      case 'decay': this.ampMul = decayMul(value, this.sr); break;
      case 'punch': this.punch = value; break;
      case 'click': this.click = value; break;
      case 'level': this.level = value; break;
    }
  }

  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    if (this.amp === 0) return;
    const inc = TWO_PI / this.sr;
    for (let i = start; i < end; i++) {
      const f = this.tune * (1 + this.punch * 6 * this.pitchEnv);
      this.phase += f * inc;
      if (this.phase >= TWO_PI) this.phase -= TWO_PI;
      const s = Math.sin(this.phase) * this.amp + this.noise.next() * this.clickEnv * this.click * 0.6;
      this.amp *= this.ampMul;
      this.pitchEnv *= this.pitchMul;
      this.clickEnv *= this.clickMul;
      const out = s * this.level;
      outL[i] += out;
      outR[i] += out;
    }
    if (this.amp < 1e-5) this.amp = 0;
  }
}
