/// <reference path="../../src/worklet/worklet-globals.d.ts" />
/**
 * Sound lab worklet: the real engine. A non-finite block is muted and the engine starts
 * afresh (main resends the project, as in the app).
 */
import { Engine } from '../../src/engine/Engine';
import type { MainToWorklet } from '../../src/engine/protocol';

class LabProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<MainToWorklet>) => this.engine.handleMessage(e.data);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    this.engine.process(left, right, left.length);
    let sum = 0;
    for (let i = 0; i < left.length; i++) sum += left[i] + right[i];
    if (sum - sum !== 0) {
      left.fill(0); right.fill(0);
      this.engine = new Engine(sampleRate);
      this.port.postMessage('reset');
    }
    return true;
  }
}

registerProcessor('lab-engine', LabProcessor);
