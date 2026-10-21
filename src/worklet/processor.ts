/// <reference path="./worklet-globals.d.ts" />
/**
 * AudioWorkletProcessor hosting the pure engine. Bundled by Vite as a standalone script
 * (imported from host.ts with "?worker&url").
 *
 * Audio-thread rules: no allocation in process(), no logging, no blocking.
 */
import { Engine } from '../engine/Engine';
import { NUM_CHANNELS } from '../engine/project';
import { STATUS_HZ, type MainToWorklet, type WorkletToMain } from '../engine/protocol';

const PROCESSOR_NAME = 'groovebox-engine';

class GrooveboxProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate);
  /** Frames since the last engine reset (resets are rate-limited to one a second). */
  private framesSinceReset = sampleRate;
  private readonly statusInterval = Math.round(sampleRate / STATUS_HZ);
  private framesSinceStatus = 0;
  // Reused status object; postMessage clones it.
  private readonly status: Extract<WorkletToMain, { type: 'status' }> = {
    type: 'status', peakL: 0, peakR: 0, frame: 0, playing: false,
    steps: new Array<number>(NUM_CHANNELS).fill(0), patterns: new Array<number>(NUM_CHANNELS).fill(0), barPhase: 0, barSteps: 16, songRow: -1, songBar: 0,
  };
  private readonly pong = { type: 'pong', id: 0 } as Extract<WorkletToMain, { type: 'pong' }>;
  private readonly resetMsg: WorkletToMain = { type: 'engineReset' };

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<MainToWorklet>) => {
      const msg = e.data;
      if (msg.type === 'ping') {
        this.pong.id = msg.id;
        this.port.postMessage(this.pong);
        return;
      }
      this.engine.handleMessage(msg);
    };
    this.engine.onRecorded = (msg) => this.port.postMessage(msg);
    const ready: WorkletToMain = { type: 'ready', sampleRate };
    this.port.postMessage(ready);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
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
    if (this.framesSinceStatus >= this.statusInterval) {
      this.framesSinceStatus = 0;
      const s = this.status;
      s.peakL = this.engine.peakL;
      s.peakR = this.engine.peakR;
      s.frame = this.engine.frame;
      s.playing = this.engine.playing;
      s.barPhase = this.engine.barPhase;
      s.barSteps = this.engine.barSteps;
      s.songRow = this.engine.songRow;
      s.songBar = this.engine.songBar;
      for (let ch = 0; ch < s.steps.length; ch++) {
        s.steps[ch] = this.engine.currentStep[ch];
        s.patterns[ch] = this.engine.activePattern[ch];
      }
      this.port.postMessage(s);
      this.engine.resetPeaks();
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, GrooveboxProcessor);
