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
 * The page sends its messages as JSON text, a batch at a time (host.ts), so nothing is
 * serialised here. A panic in the engine traps the module (Rust aborts there): the block is
 * silent, a fresh instance of the same module takes over and the page is told
 * (`engineReset`: it sends everything again), as for a non-finite output.
 *
 * Audio-thread rules: no allocation in process() (but on the blocks the engine writes a
 * report, and when a trapped engine is replaced), no logging, no blocking.
 */
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';
import { ENGINE_WASM } from './engineWasm.gen';
import { WasmEngine, fromBase64 } from './wasmEngine';

const PROCESSOR_NAME = 'groovebox-engine';

/** A trapped engine is replaced at most this often (a project that traps on load again stays silent). */
const RESTART_MS = 1000;

class GrooveboxProcessor extends AudioWorkletProcessor {
  private engine: WasmEngine | null;
  private stopGen = 0;
  private restartedAt = -Infinity;

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
    this.port.onmessage = (e: MessageEvent<string | MainToWorklet | MainToWorklet[]>) => {
      try {
        if (typeof e.data === 'string') this.engine?.sendJson(e.data);
        else this.engine?.send(e.data);
      } catch {
        this.restart();
      }
    };
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
    try {
      engine.render(n);
      const a = engine.audio;
      for (let i = 0, j = 0; i < n; i++, j += 2) {
        left[i] = a[j];
        right[i] = a[j + 1];
      }
      const msgs = engine.drain();
      if (msgs) for (const m of msgs) this.port.postMessage(m);
    } catch {
      // The engine trapped (a panic): silence, then a fresh one.
      left.fill(0);
      right.fill(0);
      this.restart();
    }
    return true;
  }

  /** A fresh engine from the same module; the page sends everything again. */
  private restart(): void {
    const old = this.engine;
    if (!old) return;
    const now = Date.now();
    try {
      this.engine = new WasmEngine(old.module, sampleRate);
    } catch {
      this.engine = null;
      return;
    }
    if (now - this.restartedAt < RESTART_MS) return;
    this.restartedAt = now;
    const reset: WorkletToMain = { type: 'engineReset' };
    this.port.postMessage(reset);
  }
}

registerProcessor(PROCESSOR_NAME, GrooveboxProcessor);
