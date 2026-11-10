/// <reference path="./worklet-globals.d.ts" />
/**
 * AudioWorkletProcessor hosting the engine. Bundled by Vite as a standalone script (imported
 * from host.ts with "?worker&url").
 *
 * The engine is the Rust one (native/, as the Android app plays it), compiled to WebAssembly
 * and carried in this bundle (engineWasm.gen.ts): its host (native/src/host.rs) does what this
 * file did for the TypeScript engine: transport counts, the NaN guard (a fresh engine and
 * engineReset), status 30 times a second with the DSP load, pongs. Where WebAssembly cannot
 * start, the TypeScript engine plays instead (`ready` says which: the page shows it).
 *
 * Audio-thread rules: no allocation in process() (but on the blocks the engine writes a report),
 * no logging, no blocking.
 */
import { Engine } from '../engine/Engine';
import { NUM_CHANNELS } from '../engine/project';
import { STATUS_HZ, type MainToWorklet, type WorkletToMain } from '../engine/protocol';
import { ENGINE_WASM } from './engineWasm.gen';
import { WasmEngine, fromBase64 } from './wasmEngine';

const PROCESSOR_NAME = 'groovebox-engine';

/**
 * STOP as an AudioParam (the UI's transport count): it arrives with each block even while
 * the audio thread is too busy to read its messages, so an overloaded engine still stops.
 */
const STOP_PARAM: AudioParamDescriptor[] = [{ name: 'stop', defaultValue: 0, minValue: 0, automationRate: 'k-rate' }];

/** The TypeScript engine, as this file ran it before: only where WebAssembly cannot start. */
class TsEngineHost {
  private engine = new Engine(sampleRate);
  /** Frames since the last engine reset (resets are rate-limited to one a second). */
  private framesSinceReset = sampleRate;
  private readonly statusInterval = Math.round(sampleRate / STATUS_HZ);
  private framesSinceStatus = 0;
  // Reused status object; postMessage clones it.
  private readonly status: Extract<WorkletToMain, { type: 'status' }> & { next: number[]; nextMs: number[] } = {
    type: 'status', peakL: 0, peakR: 0, frame: 0, playing: false,
    steps: new Array<number>(NUM_CHANNELS).fill(0), patterns: new Array<number>(NUM_CHANNELS).fill(0),
    next: new Array<number>(NUM_CHANNELS).fill(-1), nextMs: new Array<number>(NUM_CHANNELS).fill(0), barPhase: 0, barSteps: 16, songRow: -1, songBar: 0, load: 0, countIn: 0,
  };
  private readonly pong = { type: 'pong', id: 0 } as Extract<WorkletToMain, { type: 'pong' }>;
  private readonly resetMsg: WorkletToMain = { type: 'engineReset' };
  /** The newest transport change applied (see the `stop` parameter). */
  private transportGen = 0;
  private readonly stopMsg: MainToWorklet = { type: 'transport', playing: false };
  /** DSP load: ms spent in process() since the last status report. */
  private busyMs = 0;

  constructor(private readonly port: MessagePort) {
    this.engine.onRecorded = (msg) => this.port.postMessage(msg);
  }

  message(msg: MainToWorklet): void {
    if (msg.type === 'ping') {
      this.pong.id = msg.id;
      this.port.postMessage(this.pong);
      return;
    }
    if (msg.type === 'transport' && msg.gen !== undefined) {
      if (msg.gen < this.transportGen) return; // overtaken by a STOP that came as the parameter
      this.transportGen = msg.gen;
    }
    this.engine.handleMessage(msg);
  }

  process(left: Float32Array, right: Float32Array, stop: number): void {
    const started = Date.now();
    if (stop > this.transportGen) {
      this.transportGen = stop;
      this.engine.handleMessage(this.stopMsg);
    }
    this.engine.process(left, right, left.length);
    // Safety net: a NaN / infinity anywhere in the engine would silence it for good (filters
    // and effects keep it). Mute the block and start a fresh engine; the main thread resends
    // the project. Allocates, but only in this failure case, at most once a second.
    let sum = 0;
    for (let i = 0; i < left.length; i++) sum += left[i] + right[i];
    this.framesSinceReset += left.length;
    if (sum - sum !== 0) {
      left.fill(0);
      right.fill(0);
      if (this.framesSinceReset >= sampleRate) {
        this.framesSinceReset = 0;
        this.engine = new Engine(sampleRate);
        this.engine.onRecorded = (msg) => this.port.postMessage(msg);
        this.port.postMessage(this.resetMsg);
      }
    }

    this.framesSinceStatus += left.length;
    // Date.now() is whole ms, but summed over many blocks the rounding evens out.
    this.busyMs += Date.now() - started;
    if (this.framesSinceStatus >= this.statusInterval) {
      const s = this.status;
      s.load = this.busyMs / (this.framesSinceStatus / sampleRate * 1000);
      this.busyMs = 0;
      this.framesSinceStatus = 0;
      s.peakL = this.engine.peakL;
      s.peakR = this.engine.peakR;
      s.frame = this.engine.frame;
      s.playing = this.engine.playing;
      s.barPhase = this.engine.barPhase;
      s.barSteps = this.engine.barSteps;
      s.songRow = this.engine.songRow;
      s.songBar = this.engine.songBar;
      s.countIn = this.engine.countBeats;
      for (let ch = 0; ch < s.steps.length; ch++) {
        s.steps[ch] = this.engine.currentStep[ch];
        s.patterns[ch] = this.engine.heardPattern(ch); // a FILL's pattern while it plays (its steps)
        s.next[ch] = this.engine.nextStep(ch);
        s.nextMs[ch] = this.engine.msToNext(ch);
      }
      this.port.postMessage(s);
      this.engine.resetPeaks();
    }
  }
}

class GrooveboxProcessor extends AudioWorkletProcessor {
  /** The Rust engine, or null where WebAssembly could not start (then `ts`). */
  private readonly rust: WasmEngine | null;
  private readonly ts: TsEngineHost | null;
  private stopGen = 0;

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return STOP_PARAM;
  }

  constructor() {
    super();
    let rust: WasmEngine | null = null;
    try {
      rust = new WasmEngine(fromBase64(ENGINE_WASM), sampleRate);
    } catch {
      rust = null;
    }
    this.rust = rust;
    this.ts = rust ? null : new TsEngineHost(this.port);
    this.port.onmessage = (e: MessageEvent<MainToWorklet>) => {
      if (this.rust) this.rust.send(e.data);
      else this.ts!.message(e.data);
    };
    const ready: WorkletToMain = { type: 'ready', sampleRate, engine: rust ? 'rust' : 'ts' };
    this.port.postMessage(ready);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const stop = parameters.stop?.[0] ?? 0;
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    const engine = this.rust;
    if (!engine) {
      this.ts!.process(left, right, stop);
      return true;
    }
    if (stop > this.stopGen) {
      // STOP by its count, past whatever waits (the host drops older transport messages).
      this.stopGen = stop;
      engine.send({ type: 'transport', playing: false, gen: stop });
    }
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
