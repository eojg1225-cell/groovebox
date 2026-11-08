/**
 * The Android app's engine host: the same protocol as the worklet's (host.ts), spoken to the
 * native engine (native/, Rust on AAudio) through NativeAudioPlugin. Messages are batched per
 * task and sent in order; what the engine writes (status, pong, recorded, engineReset) comes
 * back as "engine" events. The WebView plays no audio at all.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';
import type { EngineHost, LatencyInfo } from './host';

interface StreamInfo { rate: number; burst: number; buffer: number; exclusive: boolean; lowLatency: boolean }
interface NativeEngine {
  engineStart(): Promise<StreamInfo>;
  send(o: { msgs: string }): Promise<void>;
  latency(): Promise<StreamInfo & { ms: number }>;
  addListener(event: 'engine', cb: (e: { msgs: string }) => void): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<NativeEngine>('NativeAudio');

type StatusMsg = Extract<WorkletToMain, { type: 'status' }>;

export class NativeHost implements EngineHost {
  private started = false;
  private queue: MainToWorklet[] = [];
  private flushing = false;
  private pingId = 0;
  private readonly pingSentAt = new Map<number, number>();
  private info: StreamInfo | null = null;
  private outputMs = NaN;
  roundTripMs = NaN;
  onStatus: ((s: StatusMsg) => void) | null = null;
  onRecorded: ((m: Extract<WorkletToMain, { type: 'recordedNote' | 'recordedLock' | 'recordedChord' }>) => void) | null = null;
  onEngineReset: (() => void) | null = null;

  async start(): Promise<void> {
    await Native.addListener('engine', (e) => {
      for (const m of JSON.parse(e.msgs) as WorkletToMain[]) this.onMessage(m);
    });
    this.info = await Native.engineStart();
    this.started = true;
    this.flush();
    window.setInterval(() => this.ping(), 1000);
    window.setInterval(() => void this.readLatency(), 500);
    this.ping();
    void this.readLatency();
  }

  /** The stream's settings (sample rate, burst, exclusive ...), once started. */
  get stream(): StreamInfo | null {
    return this.info;
  }

  send(msg: MainToWorklet): void {
    this.queue.push(msg);
    if (this.started && !this.flushing) {
      this.flushing = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushing = false;
    if (!this.started || this.queue.length === 0) return;
    const msgs = JSON.stringify(this.queue);
    this.queue = [];
    void Native.send({ msgs });
  }

  get running(): boolean {
    return this.started;
  }

  resume(): void {
    // The native stream runs on its own (no gesture or resume needed).
  }

  latency(): LatencyInfo {
    return { sampleRate: this.info?.rate ?? NaN, baseMs: 0, outputMs: this.outputMs, roundTripMs: this.roundTripMs };
  }

  private async readLatency(): Promise<void> {
    const r = await Native.latency().catch(() => null);
    if (!r || r.ms < 0) return;
    // A rolling average: the reading jitters by a burst.
    this.outputMs = Number.isFinite(this.outputMs) ? this.outputMs + (r.ms - this.outputMs) * 0.3 : r.ms;
  }

  private ping(): void {
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
      case 'ready': break;
    }
  }
}
