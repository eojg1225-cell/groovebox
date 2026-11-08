/**
 * Entry: the panel starts zoomed in on its pixel screen showing the title card, like hardware
 * booting, and zooms out once the sound engine is running. Audio cannot start without a user
 * gesture, so the screen asks for a tap; the first touch / click / key anywhere unlocks it.
 */
import { mountColourTuner } from './ui/colourTuner';
import { applyTheme } from './ui/colours';
import './style.css';
import { Capacitor } from '@capacitor/core';
import { AudioHost, type EngineHost } from './worklet/host';
import { NativeHost } from './worklet/nativeHost';
import { initProjectStorage } from './storage/native';
import { Panel } from './ui/Panel';
import { PixelScreen } from './ui/screen';
import { drawCopyView, drawDesignView, drawLiveView, drawMenuView, drawProjectView, drawSongStripView, drawTitleView } from './ui/views';
import { App, type AudioInfo } from './ui/App';
import { NUM_CHANNELS, PATTERN_NAMES } from './engine/project';
import { createDefaultProject } from './engine/defaultProject';
import { projectStore } from './storage/projects';
import { startSlotSync } from './storage/slotSync';
import { TOUCH_DELAYS, deviceSettings } from './storage/settings';
import { ScreenAwake } from './ui/wake';

/** Start-up: how long the title stays once the engine is running, then the zoom out. */
const TITLE_HOLD_MS = 700;
const ZOOM_OUT_MS = 1200;

// Block browser gestures that would scroll, zoom or open menus while playing.
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
// Touch: the panel works on pointer events, so the browser's own touch handling is cancelled.
// That stops a held finger counting as a long-press (Android / Silk vibrate for it), text
// selection and double-tap zoom, and touches can no longer be taken over by a gesture.
const noTouchDefault = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
document.addEventListener('touchstart', noTouchDefault, { passive: false });
document.addEventListener('touchmove', noTouchDefault, { passive: false });
document.addEventListener('selectstart', (e) => e.preventDefault());

// Installable / offline (production builds only, so the dev server never caches; not in the
// Android app, whose files are in the app itself).
if (import.meta.env.PROD && 'serviceWorker' in navigator && !Capacitor.isNativePlatform()) {
  void navigator.serviceWorker.register('./sw.js').catch(() => { /* optional */ });
}

// The Android app keeps the slots in its own files: read them before anything else.
await initProjectStorage();

// Every start is a blank slate: the default project, nothing open. Saved projects (and
// their working copies) stay in their slots for LOAD (FUNC + SAVE PROJECT).
projectStore.setOpen(null);
const project = createDefaultProject();
applyTheme(); // GLOBAL SETTINGS > THEME
const panel = new Panel(document.getElementById('app') as HTMLElement, {
  channels: NUM_CHANNELS,
  patterns: PATTERN_NAMES,
});
const screen = new PixelScreen(panel.screenCanvas);

let host: EngineHost | null = null;
/**
 * The Android app plays through the native engine (Rust on AAudio, about 20 ms out against
 * the WebView's 130); where it cannot start (no AAudio, a build without the library) the
 * WebView's AudioWorklet takes over.
 */
let useNative = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('NativeAudio');
const audio: AudioInfo = { state: 'off', latencyMs: NaN, peak: 0, uiMs: 0, fps: 0, dspLoad: 0, statusGapMs: 0 };
/**
 * STAT: how late status reports reach the page, against the most punctual one over the last
 * 3 s (arrival time less the engine's own time of the report): the spread is the delivery's jitter.
 */
let lateMin = Infinity;
/** The engine clock's offset from the page's (ms) and how fast it may creep up per report (follows drift). */
let clockOffset = NaN;
const CLOCK_CREEP_MS = 0.05;
let lateMax = -Infinity;
let lateSince = 0;
const app = new App(project, panel, (msg) => host?.send(msg));
// Test builds: the colour tuner (sliders per track type over the panel).
if (import.meta.env.VITE_COLOUR_TUNER) mountColourTuner(() => app.refreshPanel());
// On claude.ai the 64 project slots are kept in the artifact's db too: the same on every device.
startSlotSync(() => app.notify('PROJECTS SYNCED'));

// ------------------------------------------------------------------ audio unlock

const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown'] as const;

/**
 * Touch devices: go full screen and lock to landscape on the first touch (where the
 * browser allows it). Elsewhere the panel rotates itself on portrait screens.
 */
let landscapeTried = false;
function lockLandscape(): void {
  if (landscapeTried || !window.matchMedia('(pointer: coarse)').matches) return;
  landscapeTried = true;
  const el = document.documentElement;
  const orientation = window.screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  if (!el.requestFullscreen || document.fullscreenElement) return;
  el.requestFullscreen({ navigationUI: 'hide' })
    .then(() => orientation?.lock?.('landscape'))
    .catch(() => { /* not allowed here (e.g. embedded); the rotated layout covers it */ });
}

window.addEventListener('pointerup', lockLandscape, true);

function unlockAudio(): void {
  if (!host) {
    try {
      host = useNative ? new NativeHost() : new AudioHost();
    } catch {
      audio.state = 'error';
      return;
    }
    // Queued until the worklet is up, then delivered in order.
    for (const msg of app.syncMessages()) host.send(msg);
    host.onRecorded = (m) => app.onRecorded(m);
    host.onEngineReset = () => {
      for (const msg of app.syncMessages()) host?.send(msg);
      sentListenMs = -1; // a fresh engine: send the listen latency again
      app.notify('ENGINE RESTARTED');
    };
    host.onStatus = (s) => {
      // The engine's first status report: it is up and playing blocks.
      const t = performance.now();
      if (engineReadyAt < 0) engineReadyAt = t;
      const sr = host?.latency().sampleRate ?? NaN;
      // When the report was made, on the page's clock: the engine's own (even) sample clock
      // plus its offset from the page's, taken from the most punctual reports (so a late one
      // moves nothing), creeping up slowly to follow clock drift; a jump (a fresh engine) resets it.
      let at = t;
      if (Number.isFinite(sr)) {
        const late = t - (s.frame / sr) * 1000;
        clockOffset = !Number.isFinite(clockOffset) || late - clockOffset > 200 ? late : Math.min(clockOffset + CLOCK_CREEP_MS, late);
        at = (s.frame / sr) * 1000 + clockOffset;
        lateMin = Math.min(lateMin, late);
        lateMax = Math.max(lateMax, late);
        if (t - lateSince >= 3000) {
          audio.statusGapMs = lateMax - lateMin;
          lateMin = Infinity;
          lateMax = -Infinity;
          lateSince = t;
        }
      }
      app.setStatus(s, at);
      audio.peak = Math.max(Math.max(s.peakL, s.peakR), audio.peak * 0.85);
      // Smoothed over ~1 s (30 reports a second): the per-report figure is coarse (whole ms).
      audio.dspLoad += (s.load - audio.dspLoad) * 0.1;
    };
    audio.state = 'starting';
    host.start().then(
      () => {
        audio.state = 'on';
        for (const t of UNLOCK_EVENTS) window.removeEventListener(t, unlockAudio, true);
      },
      () => {
        host = null; // allow another attempt on the next touch
        if (useNative) {
          // No native engine here: the WebView's (the app needs no gesture to start audio).
          useNative = false;
          unlockAudio();
          return;
        }
        audio.state = 'error';
      },
    );
  } else if (!host.running) {
    // Touch devices grant audio on pointerup/touchend; retry the resume there.
    host.resume();
  }
}
for (const t of UNLOCK_EVENTS) window.addEventListener(t, unlockAudio, true);

// ------------------------------------------------------------------ title screen

// The overlay keeps the panel's controls out of reach until the title has zoomed away.
const titleOverlay = document.getElementById('title') as HTMLElement;
let engineReadyAt = -1;
let zoomStart = -1;
let titleDone = false;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
panel.setZoom(1);

/** The start-up title on the pixel screen; after the engine is ready, zoom out to the panel. */
function titleFrame(now: number): void {
  const status = audio.state === 'error' ? 'AUDIO FAILED - TAP TO RETRY'
    : engineReadyAt >= 0 ? 'READY' : audio.state === 'off' ? 'TAP TO START' : 'LOADING ...';
  const blink = audio.state !== 'off' || Math.floor(now / 500) % 2 === 0;
  drawTitleView(screen, status, blink);
  if (engineReadyAt < 0 || now - engineReadyAt < TITLE_HOLD_MS) return;
  if (zoomStart < 0) zoomStart = now;
  const p = reducedMotion ? 1 : Math.min(1, (now - zoomStart) / ZOOM_OUT_MS);
  // Ease in and out.
  panel.setZoom(1 - p * p * (3 - 2 * p));
  if (p >= 1) {
    titleDone = true;
    titleOverlay.remove();
  }
}

// ------------------------------------------------------------------ wake lock

/** The screen stays on while playing, or always (TOUCH SETTINGS: KEEP SCREEN ON). */
const keepAwake = () => app.playing || deviceSettings.screenOn === 1;
const screenAwake = new ScreenAwake();

// ------------------------------------------------------------------ frame loop

let sentListenMs = -1;

/**
 * Frame rate: the panel redraws at the display's rate while it is touched (knob drags stay
 * smooth), at 30 fps while playing (the playhead moves a 16th in ~110 ms at 133 BPM) and at
 * 15 fps when idle (blinks are 4 per second at most). Input is still handled at once; only
 * the redraw waits. Less drawing leaves the CPU to the audio thread (the Fire).
 */
const ACTIVE_MS = 1500;
const PLAYING_FRAME_MS = 1000 / 30;
const IDLE_FRAME_MS = 1000 / 15;
let lastInput = 0;
for (const t of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) {
  window.addEventListener(t, () => { lastInput = performance.now(); }, { capture: true, passive: true });
}
let lastDraw = -Infinity;
/** Measured drawing cost (ms per frame, smoothed) and frames drawn per second: the footer shows them. */
const perf = { frameMs: 0, fps: 0, frames: 0, since: 0 };

const frame = (now: number) => {
  requestAnimationFrame(frame);
  const interval = !titleDone || now - lastInput < ACTIVE_MS ? 0 : app.playing ? PLAYING_FRAME_MS : IDLE_FRAME_MS;
  // A little slack, so a 60 Hz display lands on every 2nd / 4th refresh, not one later; but
  // a step light due to move since the last draw is drawn on this very refresh, so the
  // steps move evenly (within a refresh) instead of on the 30 fps tick (0-33 ms late).
  const due = app.stepDueAt();
  if (now - lastDraw < interval - 4 && !(due <= now && due > lastDraw)) return;
  lastDraw = now;
  const t0 = performance.now();
  if (host) {
    // The native engine's reports are fetched here, just before drawing: the freshest one.
    host.poll?.();
    const lat = host.latency();
    audio.latencyMs = (Number.isFinite(lat.baseMs) ? lat.baseMs : 0) + (Number.isFinite(lat.outputMs) ? lat.outputMs : 0);
    // TOUCH DELAY: touch / click to event, on top of the reported audio latency: what the
    // player hears is this much behind what the engine plays when they tap along (live
    // recording allows for it).
    app.heardDelayMs = audio.latencyMs;
    const listenMs = audio.latencyMs + TOUCH_DELAYS[deviceSettings.touchDelay];
    if (Math.abs(listenMs - sentListenMs) >= 1) {
      sentListenMs = listenMs;
      host.send({ type: 'setListenLatency', ms: listenMs });
    }
    if (audio.state === 'on' && !host.running) audio.state = 'off';
    else if (audio.state === 'off' && host.running) audio.state = 'on';
  }
  screenAwake.set(keepAwake());
  app.updateFrame(now);
  screen.begin();
  if (!titleDone) titleFrame(now);
  else if (app.projMenu) drawProjectView(screen, app.projectView());
  else if (app.menu) drawMenuView(screen, app.menuView());
  else if (app.songGrid) drawSongStripView(screen, app.songStripView(now, audio));
  else if (app.copyShowing) drawCopyView(screen, app.copyView());
  else if (app.arpOpen) drawDesignView(screen, app.arpScreen(now, audio));
  else if (app.sendOpen) drawDesignView(screen, app.sendView(now, audio));
  else if (app.mode === 'design' || app.songRecord || app.playMix) drawDesignView(screen, app.designView(now, audio));
  else drawLiveView(screen, app.liveView(now, audio));
  screen.end();
  perf.frameMs += (performance.now() - t0 - perf.frameMs) * 0.05;
  perf.frames++;
  if (now - perf.since >= 1000) {
    perf.fps = (perf.frames * 1000) / (now - perf.since);
    perf.frames = 0;
    perf.since = now;
    audio.uiMs = perf.frameMs;
    audio.fps = perf.fps;
  }
};
requestAnimationFrame(frame);
