/// <reference path="../../src/worklet/worklet-globals.d.ts" />
/**
 * Sound lab worklet: the app's engine (the Rust one, as WebAssembly: src/worklet/wasmEngine.ts),
 * every message straight in, a block rendered and copied out. A non-finite block makes the
 * engine start afresh (its host says engineReset): the page resends the project.
 */
import type { MainToWorklet } from '../../src/engine/protocol';
import { ENGINE_WASM } from '../../src/worklet/engineWasm.gen';
import { WasmEngine, fromBase64 } from '../../src/worklet/wasmEngine';

class LabProcessor extends AudioWorkletProcessor {
  private readonly engine = new WasmEngine(fromBase64(ENGINE_WASM), sampleRate);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<MainToWorklet>) => this.engine.send(e.data);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    const n = left.length;
    this.engine.render(n);
    const a = this.engine.audio;
    for (let i = 0, j = 0; i < n; i++, j += 2) {
      left[i] = a[j];
      right[i] = a[j + 1];
    }
    const msgs = this.engine.drain();
    if (msgs?.some((m) => m.type === 'engineReset')) this.port.postMessage('reset');
    return true;
  }
}

registerProcessor('lab-engine', LabProcessor);
