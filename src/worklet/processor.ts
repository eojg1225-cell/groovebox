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
  private readonly engine = new Engine(sampleRate);
  private readonly statusInterval = Math.round(sampleRate / STATUS_HZ);
  private framesSinceStatus = 0;
  // Reused status object; postMessage clones it.
  private readonly status: Extract<WorkletToMain, { type: 'status' }> = {
    type: 'status', peakL: 0, peakR: 0, frame: 0, playing: false,
    steps: new Array<number>(NUM_CHANNELS).fill(0), patterns: new Array<number>(NUM_CHANNELS).fill(0), barPhase: 0,
  };
  private readonly pong = { type: 'pong', id: 0 } as Extract<WorkletToMain, { type: 'pong' }>;

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

    this.framesSinceStatus += left.length;
    if (this.framesSinceStatus >= this.statusInterval) {
      this.framesSinceStatus = 0;
      const s = this.status;
      s.peakL = this.engine.peakL;
      s.peakR = this.engine.peakR;
      s.frame = this.engine.frame;
      s.playing = this.engine.playing;
      s.barPhase = this.engine.barPhase;
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
