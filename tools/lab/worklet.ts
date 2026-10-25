/// <reference path="../../src/worklet/worklet-globals.d.ts" />
/**
 * Sound lab worklet: the real engine, twice. A = the engine as in the app (exact maths), B =
 * the same engine built with the fast maths (fastEngine.ts). Both get every message and
 * render every block, sample-locked; `labOut` picks what is heard: A, B, or A - B (x gain,
 * the difference made audible). (Their cost is measured offline by bench.ts.)
 * A non-finite block is muted and that engine starts afresh (main resends the project).
 */
import { Engine } from '../../src/engine/Engine';
import { Engine as FastEngine } from './fastEngine';
import type { MainToWorklet } from '../../src/engine/protocol';

/** labOut: 0 = A, 1 = B, 2 = A - B times `gain`. */
type LabMsg = MainToWorklet | { type: 'labOut'; mode: number; gain: number };

class LabProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate);
  private fast = new FastEngine(sampleRate);
  private readonly bL = new Float32Array(128);
  private readonly bR = new Float32Array(128);
  private mode = 0;
  private gain = 1;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<LabMsg>) => {
      const msg = e.data;
      if (msg.type === 'labOut') { this.mode = msg.mode; this.gain = msg.gain; return; }
      this.engine.handleMessage(msg);
      this.fast.handleMessage(msg);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    const n = Math.min(left.length, this.bL.length);
    this.bL.fill(0, 0, n);
    this.bR.fill(0, 0, n);
    this.engine.process(left, right, n);
    this.fast.process(this.bL, this.bR, n);
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { sa += left[i] + right[i]; sb += this.bL[i] + this.bR[i]; }
    if (sa - sa !== 0) { left.fill(0); right.fill(0); this.engine = new Engine(sampleRate); this.port.postMessage('reset'); }
    if (sb - sb !== 0) { this.bL.fill(0); this.bR.fill(0); this.fast = new FastEngine(sampleRate); this.port.postMessage('reset'); }
    if (this.mode === 1) {
      left.set(this.bL.subarray(0, n));
      if (right !== left) right.set(this.bR.subarray(0, n));
    } else if (this.mode === 2) {
      for (let i = 0; i < n; i++) {
        left[i] = (left[i] - this.bL[i]) * this.gain;
        if (right !== left) right[i] = (right[i] - this.bR[i]) * this.gain;
      }
    }
    return true;
  }
}

registerProcessor('lab-engine', LabProcessor);
