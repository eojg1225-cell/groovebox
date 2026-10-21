/// <reference path="../../src/worklet/worklet-globals.d.ts" />
/** Bass TIMBRE sweep worklet: the real engine, one instance. */
import { Engine } from '../../src/engine/Engine';
import type { MainToWorklet } from '../../src/engine/protocol';

class BassSweepProcessor extends AudioWorkletProcessor {
  private readonly engine = new Engine(sampleRate);

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
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== left[i]) left[i] = 0;
      if (right[i] !== right[i]) right[i] = 0;
    }
    return true;
  }
}

registerProcessor('basssweep-engine', BassSweepProcessor);
