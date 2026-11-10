/**
 * The engine the tests play: the Rust engine (native/) as WebAssembly, the web build's own
 * (src/worklet/wasmEngine.ts), behind the shape the tests were written against: messages in
 * (handled at once), blocks rendered into the caller's buffers, recorded notes to
 * `onRecorded`, the playing state readable at any moment. `npm test` builds the module first
 * (scripts/build-wasm.mjs).
 */
import type { MainToWorklet, WorkletToMain } from '../src/engine/protocol';
import { ENGINE_WASM } from '../src/worklet/engineWasm.gen';
import { WasmEngine, fromBase64, type EngineState } from '../src/worklet/wasmEngine';

export type RecordedMsg = Extract<WorkletToMain, { type: 'recordedNote' | 'recordedLock' | 'recordedChord' }>;

const BYTES = fromBase64(ENGINE_WASM);
const MAX = 1024;

export class Engine {
  private readonly w: WasmEngine;
  private readonly watchers = new Map<number, (note: number) => void>();
  onRecorded: ((m: RecordedMsg) => void) | null = null;

  constructor(sampleRate: number) {
    this.w = new WasmEngine(BYTES, sampleRate);
  }

  handleMessage(msg: MainToWorklet): void {
    this.w.send(msg);
    this.w.apply();
    this.deliver();
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let off = 0; off < n; off += MAX) {
      const k = Math.min(MAX, n - off);
      this.w.render(k);
      const a = this.w.audio;
      for (let i = 0; i < k; i++) {
        l[off + i] = a[i * 2];
        r[off + i] = a[i * 2 + 1];
      }
      this.deliver();
    }
  }

  /** Call `cb` with every note track ch's instrument starts (after the block it starts in). */
  watchNotes(ch: number, cb: (note: number) => void): void {
    this.watchers.set(ch, cb);
    this.w.watchNotes(ch, true);
  }

  /** Voices held on track ch's synth now. */
  heldVoices(ch: number): number {
    return this.w.heldVoices(ch);
  }

  private deliver(): void {
    for (const [ch, cb] of this.watchers) for (const n of this.w.takeNotes(ch)) cb(n);
    for (const m of this.w.drain() ?? []) {
      if (m.type === 'recordedNote' || m.type === 'recordedLock' || m.type === 'recordedChord') this.onRecorded?.(m);
    }
  }

  private get state(): EngineState {
    return this.w.state();
  }

  get latency(): number { return this.state.latency; }
  get playing(): boolean { return this.state.playing; }
  get frame(): number { return this.state.frame; }
  get currentStep(): number[] { return this.state.currentStep; }
  get songRow(): number { return this.state.songRow; }
  get songBar(): number { return this.state.songBar; }
  get barPhase(): number { return this.state.barPhase; }
  get barSteps(): number { return this.state.barSteps; }
  get countBeats(): number { return this.state.countBeats; }
  heardPattern(ch: number): number { return this.state.heardPattern[ch]; }
  /** A sound parameter's value on a track before live offsets (its patch, gliding), by slot. */
  baseValue(ch: number, slot: number): number { return this.w.baseValue(ch, slot); }
}
