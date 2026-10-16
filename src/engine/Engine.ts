import type { MainToWorklet } from './protocol';
import type { ParamSpec } from './params';
import { Smoother } from './smoother';
import { TestTone } from '../instruments/TestTone';

export const MASTER_PARAMS: readonly ParamSpec[] = [
  { id: 'volume', name: 'MASTER', min: 0, max: 1, defaultValue: 0.8, unit: '', curve: 'linear' },
];

/**
 * Pure audio engine: no DOM, no Web Audio. The worklet (or a Node test) calls
 * handleMessage() and process(). Allocation-free after construction.
 *
 * M0 contents: one TestTone instrument, master volume, safety soft-clip, peak meters.
 */
export class Engine {
  readonly sampleRate: number;
  readonly tone: TestTone;
  playing = false;
  /** Running frame counter (audio clock). */
  frame = 0;
  peakL = 0;
  peakR = 0;

  private readonly master: Smoother;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.tone = new TestTone(sampleRate);
    this.master = new Smoother(0.8, 0.02, sampleRate);
  }

  handleMessage(msg: MainToWorklet): void {
    switch (msg.type) {
      case 'setParam': this.setParam(msg.id, msg.value); break;
      case 'transport':
        this.playing = msg.playing;
        this.tone.setDroneOn(msg.playing);
        break;
      case 'trigger': this.tone.noteOn(msg.note, msg.velocity); break;
      case 'ping': break; // answered by the host
    }
  }

  setParam(id: string, value: number): void {
    const dot = id.indexOf('.');
    if (dot < 0) return;
    const target = id.slice(0, dot);
    const param = id.slice(dot + 1);
    if (target === 'tone') this.tone.setParam(param, value);
    else if (target === 'master' && param === 'volume') this.master.setTarget(value);
  }

  /** Overwrites outL/outR with `frames` samples. */
  process(outL: Float32Array, outR: Float32Array, frames: number): void {
    outL.fill(0, 0, frames);
    outR.fill(0, 0, frames);
    this.tone.render(outL, outR, 0, frames);

    let pL = this.peakL;
    let pR = this.peakR;
    for (let i = 0; i < frames; i++) {
      const g = this.master.next();
      // Safety soft-clip; a proper limiter arrives with the mixer (M2).
      const l = Math.tanh(outL[i] * g);
      const r = Math.tanh(outR[i] * g);
      outL[i] = l;
      outR[i] = r;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > pL) pL = al;
      if (ar > pR) pR = ar;
    }
    this.peakL = pL;
    this.peakR = pR;
    this.frame += frames;
  }

  resetPeaks(): void {
    this.peakL = 0;
    this.peakR = 0;
  }
}
