/// <reference path="./worklet-globals.d.ts" />
/**
 * AudioWorkletProcessor hosting the engine. Bundled by Vite as a standalone script (imported
 * from host.ts with "?worker&url").
 *
 * The engine is the Rust one (native/, as the Android app plays it), compiled to WebAssembly
 * and carried in this bundle (engineWasm.gen.ts). Its host (native/src/host.rs) does the rest:
 * transport counts, the NaN guard (a fresh engine and engineReset), status 30 times a second
 * with the DSP load, pongs. Where WebAssembly cannot start there is no sound: `ready` says so
 * (engine 'none') and the page shows it.
 *
 * Audio-thread rules: no allocation in process() (but on the blocks the engine writes a
 * report), no logging, no blocking.
 */
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';
import { ENGINE_WASM } from './engineWasm.gen';
import { WasmEngine, fromBase64 } from './wasmEngine';

const PROCESSOR_NAME = 'groovebox-engine';

class GrooveboxProcessor extends AudioWorkletProcessor {
  private readonly engine: WasmEngine | null;
  private stopGen = 0;

  /**
   * STOP as an AudioParam (the UI's transport count): it arrives with each block even while
   * the audio thread is too busy to read its messages, so an overloaded engine still stops.
   */
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [{ name: 'stop', defaultValue: 0, minValue: 0, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    let engine: WasmEngine | null = null;
    try {
      engine = new WasmEngine(fromBase64(ENGINE_WASM), sampleRate);
    } catch {
      engine = null;
    }
    this.engine = engine;
    this.port.onmessage = (e: MessageEvent<MainToWorklet>) => this.engine?.send(e.data);
    const ready: WorkletToMain = { type: 'ready', sampleRate, engine: engine ? 'rust' : 'none' };
    this.port.postMessage(ready);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const engine = this.engine;
    const out = outputs[0];
    if (!engine || !out || out.length === 0) return true;
    const stop = parameters.stop?.[0] ?? 0;
    if (stop > this.stopGen) {
      // STOP by its count, past whatever waits (the host drops older transport messages).
      this.stopGen = stop;
      engine.send({ type: 'transport', playing: false, gen: stop });
    }
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    const n = left.length;
    engine.render(n);
    const a = engine.audio;
    for (let i = 0, j = 0; i < n; i++, j += 2) {
      left[i] = a[j];
      right[i] = a[j + 1];
    }
    const msgs = engine.drain();
    if (msgs) for (const m of msgs) this.port.postMessage(m);
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, GrooveboxProcessor);
