/**
 * The Android app's engine host: the same protocol as the worklet's (host.ts), spoken to the
 * native engine (native/, Rust on AAudio). Messages are batched per task and sent in order;
 * what the engine writes (status, pong, recorded, engineReset) is pulled: `poll` before each
 * frame is drawn (main.ts) and every few ms besides. Both go straight through the page's
 * `GrooveNative` object (NativeAudioPlugin's JavaScript interface); a build without it uses
 * the plugin's calls and "engine" events. The WebView plays no audio at all.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';
import type { EngineHost, LatencyInfo } from './host';

interface StreamInfo { rate: number; burst: number; buffer: number; exclusive: boolean; lowLatency: boolean }
interface NativeEngine {
  engineStart(o: { events: boolean }): Promise<StreamInfo>;
  focus(): Promise<void>;
  suspend(o: { on: boolean }): Promise<void>;
  send(o: { msgs: string }): Promise<void>;
  latency(): Promise<StreamInfo & { ms: number }>;
  addListener(event: 'engine', cb: (e: { msgs: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'focus', cb: (e: { lost: boolean }) => void): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<NativeEngine>('NativeAudio');

/** NativeAudioPlugin's direct line (a JavaScript interface: synchronous, off the main thread). */
interface Direct { send(json: string): void; poll(): string }
const direct = (): Direct | undefined => (window as unknown as { GrooveNative?: Direct }).GrooveNative;

/** How often the engine's writes are fetched besides each frame (recorded notes, a hidden page). */
const POLL_MS = 8;

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

  /** A call or another app took the audio (Android's audio focus): the page stops. */
  onFocusLost: (() => void) | null = null;
  private suspended = false;

  async start(): Promise<void> {
    await Native.addListener('focus', () => this.onFocusLost?.());
    const d = direct();
    if (!d) await Native.addListener('engine', (e) => this.receive(e.msgs));
    this.info = await Native.engineStart({ events: !d });
    this.started = true;
    this.flush();
    if (d) window.setInterval(() => this.poll(), POLL_MS);
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
    // PLAY: hold Android's audio focus while playing.
    if (msg.type === 'transport' && msg.playing && this.started) void Native.focus().catch(() => {});
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
    const d = direct();
    if (d) d.send(msgs);
    else void Native.send({ msgs });
  }

  /** Fetch what the engine wrote (the direct line only; events come by themselves). */
  poll(): void {
    const d = this.started ? direct() : undefined;
    if (d) this.receive(d.poll());
  }

  private receive(json: string): void {
    if (json.length <= 2) return;
    for (const m of JSON.parse(json) as WorkletToMain[]) this.onMessage(m);
  }

  get running(): boolean {
    return this.started;
  }

  resume(): void {
    // The native stream runs on its own (no gesture or resume needed).
  }

  /** In the background with nothing playing (true): the stream closed; back (false): open again. */
  suspend(on: boolean): void {
    if (!this.started || on === this.suspended) return;
    this.suspended = on;
    void Native.suspend({ on }).catch(() => { this.suspended = false; });
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
