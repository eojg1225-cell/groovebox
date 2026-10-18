/// <reference path="../../src/worklet/worklet-globals.d.ts" />
/**
 * Sound test worklet: two engines side by side. A plays the project; B plays only the test
 * track (used by the CROSSFADE option, where two TIMBRE sounds sound at once).
 */
import { Engine } from '../../src/engine/Engine';
import type { MainToWorklet } from '../../src/engine/protocol';

type Msg = { to: 'A' | 'B' | 'both'; msg: MainToWorklet };

class SoundTestProcessor extends AudioWorkletProcessor {
  private readonly a = new Engine(sampleRate);
  private readonly b = new Engine(sampleRate);
  private bl = new Float32Array(128);
  private br = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Msg>) => {
      const { to, msg } = e.data;
      if (to !== 'B') this.a.handleMessage(msg);
      if (to !== 'A') this.b.handleMessage(msg);
    };
    this.port.postMessage({ type: 'ready' });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    const n = left.length;
    if (this.bl.length !== n) { this.bl = new Float32Array(n); this.br = new Float32Array(n); }
    this.a.process(left, right, n);
    this.bl.fill(0); this.br.fill(0);
    this.b.process(this.bl, this.br, n);
    for (let i = 0; i < n; i++) {
      const l = left[i] + this.bl[i], r = right[i] + this.br[i];
      left[i] = l === l ? l : 0;
      right[i] = r === r ? r : 0;
    }
    return true;
  }
}

registerProcessor('soundtest-engine', SoundTestProcessor);
