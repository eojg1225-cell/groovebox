import type { Instrument } from './Instrument';
import type { ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';

export const TEST_TONE_PARAMS: readonly ParamSpec[] = [
  { id: 'freq', name: 'FREQ', min: 40, max: 2000, defaultValue: 220, unit: 'HZ', curve: 'exp' },
  { id: 'level', name: 'LEVEL', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'drive', name: 'DRIVE', min: 1, max: 20, defaultValue: 1, unit: 'X', curve: 'exp' },
  { id: 'decay', name: 'DECAY', min: 0.02, max: 2, defaultValue: 0.25, unit: 'S', curve: 'exp' },
];

const TWO_PI = Math.PI * 2;

/**
 * M0 test instrument: a sine oscillator with a gated drone and a tap-triggered blip
 * (instant attack, exponential decay) for judging touch-to-sound latency by ear.
 * A tanh drive stage gives an audible change for the knob test.
 */
export class TestTone implements Instrument {
  readonly params = TEST_TONE_PARAMS;

  private readonly sampleRate: number;
  private phase = 0;
  private readonly freq: Smoother;
  private readonly level: Smoother;
  private readonly drive: Smoother;
  private readonly gate: Smoother;
  private decaySeconds = 0.25;
  private blipEnv = 0;
  private blipMul = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.freq = new Smoother(220, 0.02, sampleRate);
    this.level = new Smoother(0.5, 0.02, sampleRate);
    this.drive = new Smoother(1, 0.02, sampleRate);
    this.gate = new Smoother(0, 0.01, sampleRate);
    this.updateDecay();
  }

  setDroneOn(on: boolean): void {
    this.gate.setTarget(on ? 1 : 0);
  }

  noteOn(_note: number, velocity: number): void {
    this.blipEnv = velocity;
  }

  noteOff(): void {
    // Blip is a one-shot; nothing to release.
  }

  setParam(id: string, value: number): void {
    switch (id) {
      case 'freq': this.freq.setTarget(value); break;
      case 'level': this.level.setTarget(value); break;
      case 'drive': this.drive.setTarget(value); break;
      case 'decay': this.decaySeconds = value; this.updateDecay(); break;
    }
  }

  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    const inc = TWO_PI / this.sampleRate;
    for (let i = start; i < end; i++) {
      const f = this.freq.next();
      const drive = this.drive.next();
      const amp = this.level.next() * (this.gate.next() + this.blipEnv);

      this.blipEnv *= this.blipMul;
      if (this.blipEnv < 1e-5) this.blipEnv = 0;

      this.phase += f * inc;
      if (this.phase >= TWO_PI) this.phase -= TWO_PI;

      const s = Math.tanh(Math.sin(this.phase) * drive) / Math.tanh(drive);
      const out = s * amp;
      outL[i] += out;
      outR[i] += out;
    }
  }

  private updateDecay(): void {
    // Time for the envelope to fall by 60 dB.
    this.blipMul = Math.pow(0.001, 1 / (this.decaySeconds * this.sampleRate));
  }
}
