/**
 * MENU > GLOBAL SETTINGS > NATIVE AUDIO TEST (the Android app only): step 1 of the native
 * engine. The same test blip (1 kHz, 1 ms attack, 60 ms decay) played through the native
 * audio path (native/, Rust on AAudio: NativeAudioPlugin) on strip keys 1-8 and through the
 * WebView's Web Audio on keys 9-16, with each path's output latency, so the difference can be
 * heard and read side by side. Opened with the page, closed with it.
 */
import { registerPlugin } from '@capacitor/core';

interface NativeInfo { rate: number; burst: number; buffer: number; exclusive: boolean; lowLatency: boolean }
interface NativeAudio {
  start(): Promise<NativeInfo>;
  stop(): Promise<void>;
  tap(): Promise<void>;
  latency(): Promise<NativeInfo & { ms: number }>;
}

const Native = registerPlugin<NativeAudio>('NativeAudio');

/** A rolling average of the last few readings (they jitter by a burst). */
const smooth = (old: number, v: number) => (Number.isFinite(old) ? old + (v - old) * 0.3 : v);

export class AudioTest {
  private open = false;
  private info: NativeInfo | null = null;
  private error = '';
  private nativeMs = NaN;
  private web: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private onHide = () => { if (document.visibilityState !== 'visible') this.close(); };

  /** Open (or keep open) while the page shows; close when it does not. */
  sync(showing: boolean): void {
    if (showing && !this.open) this.start();
    else if (!showing && this.open) this.close();
  }

  private start(): void {
    this.open = true;
    this.error = '';
    this.nativeMs = NaN;
    Native.start().then(
      (i) => { this.info = i; },
      (e: unknown) => { this.error = String((e as { message?: string })?.message ?? e).toUpperCase(); },
    );
    try {
      this.web = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      this.web = null;
    }
    this.timer = setInterval(() => {
      Native.latency().then((r) => {
        this.info = r;
        if (r.ms >= 0) this.nativeMs = smooth(this.nativeMs, r.ms);
      }, () => undefined);
    }, 250);
    document.addEventListener('visibilitychange', this.onHide);
  }

  private close(): void {
    this.open = false;
    clearInterval(this.timer);
    void Native.stop().catch(() => undefined);
    void this.web?.close().catch(() => undefined);
    this.web = null;
    this.info = null;
    document.removeEventListener('visibilitychange', this.onHide);
  }

  /** Strip key 1-16: the blip through the native path (1-8) or the WebView (9-16). */
  tap(key: number): void {
    if (key <= 8) {
      void Native.tap().catch(() => undefined);
      return;
    }
    const ctx = this.web;
    if (!ctx) return;
    void ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.value = 1000;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.5, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(env).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  /** The page's lines. */
  lines(): string[] {
    const ms = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)} MS` : '...');
    const i = this.info;
    const web = this.web as (AudioContext & { outputLatency?: number }) | null;
    const webMs = web ? ((web.baseLatency ?? 0) + (web.outputLatency ?? 0)) * 1000 : NaN;
    return [
      'KEYS 1-8 NATIVE, 9-16 WEBVIEW',
      this.error ? `NATIVE: ${this.error}` : `NATIVE OUT ${ms(this.nativeMs)}`,
      i ? `${(i.rate / 1000).toFixed(1)} KHZ, BURST ${i.burst}, BUF ${i.buffer}` : 'NATIVE: OPENING ...',
      i ? `${i.exclusive ? 'EXCLUSIVE' : 'SHARED'}, ${i.lowLatency ? 'LOW LATENCY' : 'NORMAL'}` : '',
      `WEBVIEW OUT ${ms(webMs)}`,
    ];
  }
}
