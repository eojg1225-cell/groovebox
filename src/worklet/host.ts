/**
 * Main-thread side of the worklet bridge: owns the AudioContext and AudioWorkletNode and
 * speaks the protocol in engine/protocol.ts. This is the only place that touches Web Audio.
 * If the processor itself fails (`processorerror`: nothing plays), a new node takes its
 * place and the page sends everything again (`onEngineReset`), as for ENGINE RESTARTED.
 */
import workletUrl from './processor.ts?worker&url';
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';

// Must match the name registered in processor.ts.
const PROCESSOR_NAME = 'groovebox-engine';
/** A failed processor is replaced, but not again within this time (it would only fail again). */
const NODE_RETRY_MS = 5000;

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

/** Where the engine runs: the WebView's AudioWorklet (AudioHost) or the app's native engine (NativeHost). */
export interface EngineHost {
  start(): Promise<void>;
  send(msg: MainToWorklet): void;
  /** Playing blocks now. */
  readonly running: boolean;
  /** Ask for the audio again (after a tab was hidden, or a touch device's first gesture). */
  resume(): void;
  latency(): LatencyInfo;
  /** Fetch what the engine wrote now (the native engine, which the page pulls from; the worklet's arrives by itself). */
  poll?(): void;
  roundTripMs: number;
  onStatus: ((s: StatusMsg) => void) | null;
  onRecorded: ((m: Extract<WorkletToMain, { type: 'recordedNote' | 'recordedLock' | 'recordedChord' }>) => void) | null;
  onEngineReset: (() => void) | null;
}

export class AudioHost implements EngineHost {
  readonly ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  /** The processor's `stop` parameter: STOP that gets through an overloaded audio thread. */
  private stopParam: AudioParam | null = null;
  private pingId = 0;
  private pingSentAt = new Map<number, number>();
  /** Messages sent before the worklet exists; flushed in order once it does. */
  private pending: MainToWorklet[] = [];
  private flushing = false;
  private failedAt = -Infinity;
  roundTripMs = NaN;
  onStatus: ((s: StatusMsg) => void) | null = null;
  /** Motion-record results written by the worklet. */
  onRecorded: ((m: Extract<WorkletToMain, { type: 'recordedNote' | 'recordedLock' | 'recordedChord' }>) => void) | null = null;
  /** The worklet replaced a failed engine (non-finite output): send it the state again. */
  onEngineReset: (() => void) | null = null;
  /** The worklet is up: 'rust' = its engine started, 'none' = WebAssembly could not start (no sound). */
  onReady: ((engine: 'rust' | 'none') => void) | null = null;

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
    this.makeNode();
    await this.ctx.resume();

    // Resume after the tab was backgrounded or the OS interrupted audio.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.ctx.resume();
    });
    window.setInterval(() => this.ping(), 1000);
    this.ping();
  }

  /** The processor's node, connected; a failed one is replaced (at most every few seconds). */
  private makeNode(): void {
    const node = new AudioWorkletNode(this.ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e: MessageEvent<WorkletToMain>) => this.onMessage(e.data);
    node.onprocessorerror = () => {
      if (this.node !== node) return;
      node.disconnect();
      this.node = null;
      const now = performance.now();
      if (now - this.failedAt < NODE_RETRY_MS) return; // failing again at once: stay silent
      this.failedAt = now;
      this.makeNode();
      this.onEngineReset?.();
    };
    node.connect(this.ctx.destination);
    this.node = node;
    this.stopParam = node.parameters.get('stop') ?? null;
    this.flush();
  }

  /**
   * Load the worklet module by URL; if the host page's security policy refuses that
   * (e.g. some embedded/sandboxed hosts), fetch the same file and load it as a blob.
   */
  private async loadWorklet(): Promise<void> {
    // The worklet keeps one file name across builds, so a browser may still hold an older
    // copy: refresh the cached file first (a mismatched engine can silence everything).
    await fetch(workletUrl, { cache: 'reload' }).catch(() => null);
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

  /**
   * Messages go as one JSON text per task (serialised here, not on the audio thread), in
   * order; before the worklet exists they wait.
   */
  send(msg: MainToWorklet): void {
    this.pending.push(msg);
    if (this.node && !this.flushing) {
      this.flushing = true;
      queueMicrotask(() => this.flush());
    }
    // STOP also as the parameter (the message may wait behind an overloaded audio thread).
    if (msg.type === 'transport' && !msg.playing && msg.gen && this.stopParam) this.stopParam.value = msg.gen;
  }

  private flush(): void {
    this.flushing = false;
    if (!this.node || this.pending.length === 0) return;
    this.node.port.postMessage(JSON.stringify(this.pending));
    this.pending = [];
  }

  get running(): boolean {
    return this.node !== null && this.ctx.state === 'running';
  }

  resume(): void {
    void this.ctx.resume();
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
      case 'recordedNote':
      case 'recordedLock':
      case 'recordedChord':
        this.onRecorded?.(msg);
        break;
      case 'engineReset': this.onEngineReset?.(); break;
      case 'ready': this.onReady?.(msg.engine ?? 'rust'); break;
    }
  }
}
