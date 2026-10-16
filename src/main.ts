/**
 * App entry: tap-to-start overlay, then wires the on-screen panel (ControlSurface) to the
 * audio engine (via AudioHost) and draws the pixel screen.
 */
import './style.css';
import { AudioHost } from './worklet/host';
import { Panel } from './ui/Panel';
import { PixelScreen } from './ui/screen';
import { drawMainView, type ScreenState } from './ui/views';
import { formatValue, toNorm, toValue, type ParamSpec } from './engine/params';
import { TEST_TONE_PARAMS } from './instruments/TestTone';
import { MASTER_PARAMS } from './engine/Engine';

interface KnobBinding {
  knobId: string;
  paramId: string; // "<target>.<param>" as understood by the engine
  spec: ParamSpec;
}

const BINDINGS: KnobBinding[] = [
  ...TEST_TONE_PARAMS.map((spec) => ({ knobId: `k_${spec.id}`, paramId: `tone.${spec.id}`, spec })),
  { knobId: 'k_master', paramId: 'master.volume', spec: MASTER_PARAMS[0] },
];

const app = document.getElementById('app') as HTMLElement;
const overlay = document.getElementById('start') as HTMLElement;
const startButton = document.getElementById('start-button') as HTMLElement;
const startError = document.getElementById('start-error') as HTMLElement;

// Block browser gestures that would scroll, zoom or open menus while playing.
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

// Installable / offline (production builds only, so the dev server never caches).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
}

let starting = false;
startButton.addEventListener('pointerup', (e) => {
  // On touch devices opened in a normal browser tab, go full screen with the same tap.
  if (e.pointerType === 'touch') enterFullscreen();
  void start();
});
startButton.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') void start();
});

function enterFullscreen(): void {
  const standalone = window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
  const el = document.documentElement;
  if (standalone || document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* not allowed; carry on */ });
}

async function start(): Promise<void> {
  if (starting) return;
  starting = true;
  startError.textContent = '';
  let host: AudioHost;
  try {
    host = new AudioHost(); // synchronous, inside the gesture
    await host.start();
  } catch (err) {
    starting = false;
    startError.textContent = `Could not start audio: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  overlay.remove();
  runApp(host);
}

function runApp(host: AudioHost): void {
  const panel = new Panel(
    app,
    BINDINGS.map((b) => ({ id: b.knobId, label: b.spec.name, defaultValue: toNorm(b.spec, b.spec.defaultValue) })),
  );
  const screen = new PixelScreen(panel.screenCanvas);
  const byKnob = new Map(BINDINGS.map((b) => [b.knobId, b]));

  const st: ScreenState = {
    playing: false,
    lastName: 'READY',
    lastValueText: 'TAP!',
    lastNorm: 0,
    peakL: 0,
    peakR: 0,
    tapFlash: 0,
    sampleRate: host.ctx.sampleRate,
    baseMs: NaN,
    outputMs: NaN,
    roundTripMs: NaN,
    audioState: host.ctx.state,
  };

  // Push defaults so engine and UI agree.
  for (const b of BINDINGS) host.setParam(b.paramId, b.spec.defaultValue);

  let wakeLock: { release(): Promise<void> } | null = null;
  async function setWakeLock(on: boolean): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    try {
      if (on && !wakeLock && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { /* not supported or denied; harmless */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && st.playing) { wakeLock = null; void setWakeLock(true); }
  });

  panel.subscribe((e) => {
    switch (e.type) {
      case 'knob': {
        const b = byKnob.get(e.id);
        if (!b) return;
        const value = toValue(b.spec, e.value);
        host.setParam(b.paramId, value);
        st.lastName = b.spec.name;
        st.lastValueText = formatValue(b.spec, value);
        st.lastNorm = e.value;
        break;
      }
      case 'button':
        if (e.id === 'play' && e.pressed) {
          st.playing = !st.playing;
          host.send({ type: 'transport', playing: st.playing });
          panel.setButtonLit('play', st.playing);
          void setWakeLock(st.playing);
        } else if (e.id === 'tap' && e.pressed) {
          host.send({ type: 'trigger', note: 60, velocity: 1 });
          st.tapFlash = 1;
        }
        break;
    }
  });

  host.onStatus = (s) => {
    st.peakL = Math.max(s.peakL, st.peakL * 0.85);
    st.peakR = Math.max(s.peakR, st.peakR * 0.85);
  };

  let last = performance.now();
  const frame = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    st.tapFlash = Math.max(0, st.tapFlash - dt * 4);
    const lat = host.latency();
    st.baseMs = lat.baseMs;
    st.outputMs = lat.outputMs;
    st.roundTripMs = lat.roundTripMs;
    st.audioState = host.ctx.state;
    drawMainView(screen, st);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
