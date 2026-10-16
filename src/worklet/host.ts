/**
 * Main-thread side of the worklet bridge: owns the AudioContext and AudioWorkletNode and
 * speaks the protocol in engine/protocol.ts. This is the only place that touches Web Audio.
 */
import workletUrl from './processor.ts?worker&url';
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';

// Must match the name registered in processor.ts.
const PROCESSOR_NAME = 'groovebox-engine';

export interface LatencyInfo {
  sampleRate: number;
  /** AudioContext.baseLatency in ms (processing latency), or NaN if unsupported. */
  baseMs: number;
  /** AudioContext.outputLatency in ms (to the speaker), or NaN if unsupported. */
  outputMs: number;
  /** Last measured UI -> worklet -> UI message round trip in ms. */
  roundTripMs: number;
}

type StatusMsg = Extract<WorkletToMain, { type: 'status' }>;

export class AudioHost {
  readonly ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private pingId = 0;
  private pingSentAt = new Map<number, number>();
  roundTripMs = NaN;
  onStatus: ((s: StatusMsg) => void) | null = null;

  /** Must be called synchronously inside a user gesture handler. */
  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    // Kick the resume inside the gesture; awaited later in start().
    void this.ctx.resume();
  }

  async start(): Promise<void> {
    if (!this.ctx.audioWorklet) {
      throw new Error('AudioWorklet is not supported in this browser (a secure https page is required).');
    }
    await this.loadWorklet();
    const node = new AudioWorkletNode(this.ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e: MessageEvent<WorkletToMain>) => this.onMessage(e.data);
    node.connect(this.ctx.destination);
    this.node = node;
    await this.ctx.resume();

    // Resume after the tab was backgrounded or the OS interrupted audio.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.ctx.resume();
    });
    window.setInterval(() => this.ping(), 1000);
    this.ping();
  }

  /**
   * Load the worklet module by URL; if the host page's security policy refuses that
   * (e.g. some embedded/sandboxed hosts), fetch the same file and load it as a blob.
   */
  private async loadWorklet(): Promise<void> {
    try {
      await this.ctx.audioWorklet.addModule(workletUrl);
    } catch (err) {
      const res = await fetch(workletUrl).catch(() => null);
      if (!res?.ok) throw err;
      const blobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
      try {
        await this.ctx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }
  }

  send(msg: MainToWorklet): void {
    this.node?.port.postMessage(msg);
  }

  setParam(id: string, value: number): void {
    this.send({ type: 'setParam', id, value });
  }

  latency(): LatencyInfo {
    const c = this.ctx as AudioContext & { outputLatency?: number };
    return {
      sampleRate: c.sampleRate,
      baseMs: typeof c.baseLatency === 'number' ? c.baseLatency * 1000 : NaN,
      outputMs: typeof c.outputLatency === 'number' ? c.outputLatency * 1000 : NaN,
      roundTripMs: this.roundTripMs,
    };
  }

  private ping(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
    const id = ++this.pingId;
    this.pingSentAt.set(id, performance.now());
    this.send({ type: 'ping', id });
  }

  private onMessage(msg: WorkletToMain): void {
    switch (msg.type) {
      case 'status': this.onStatus?.(msg); break;
      case 'pong': {
        const t = this.pingSentAt.get(msg.id);
        if (t !== undefined) {
          this.roundTripMs = performance.now() - t;
          this.pingSentAt.delete(msg.id);
        }
        break;
      }
      case 'ready': break;
    }
  }
}
