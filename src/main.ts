/**
 * Entry: title screen that fades into the panel. Audio cannot start without a user
 * gesture, so the first touch/click/key anywhere quietly unlocks it.
 */
import './style.css';
import { AudioHost } from './worklet/host';
import { Panel } from './ui/Panel';
import { INK, PixelScreen } from './ui/screen';
import { drawMainView } from './ui/views';
import { App, PAGES, type AudioInfo } from './ui/App';
import { ACTIVE_CHANNELS, NUM_CHANNELS, PATTERN_NAMES, createDefaultProject } from './engine/project';
import { loadSession } from './storage/session';
import { textWidth } from './ui/font';

const TITLE_HOLD_MS = 1400;

// Block browser gestures that would scroll, zoom or open menus while playing.
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

// Installable / offline (production builds only, so the dev server never caches).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js').catch(() => { /* optional */ });
}

const project = loadSession() ?? createDefaultProject();
const panel = new Panel(document.getElementById('app') as HTMLElement, {
  channels: NUM_CHANNELS,
  activeChannels: ACTIVE_CHANNELS,
  patterns: PATTERN_NAMES,
  pages: PAGES,
});
const screen = new PixelScreen(panel.screenCanvas);

let host: AudioHost | null = null;
const audio: AudioInfo = { state: 'off', latencyMs: NaN, peak: 0 };
const app = new App(project, panel, (msg) => host?.send(msg));

// ------------------------------------------------------------------ audio unlock

const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown'] as const;

function unlockAudio(): void {
  if (!host) {
    try {
      host = new AudioHost();
    } catch {
      audio.state = 'error';
      return;
    }
    // Queued until the worklet is up, then delivered in order.
    for (const msg of app.syncMessages()) host.send(msg);
    host.onRecorded = (m) => app.onRecorded(m);
    host.onStatus = (s) => {
      app.setStatus(s);
      audio.peak = Math.max(Math.max(s.peakL, s.peakR), audio.peak * 0.85);
    };
    audio.state = 'starting';
    host.start().then(
      () => {
        audio.state = 'on';
        for (const t of UNLOCK_EVENTS) window.removeEventListener(t, unlockAudio, true);
      },
      () => {
        audio.state = 'error';
        host = null; // allow another attempt on the next touch
      },
    );
  } else if (host.ctx.state !== 'running') {
    // Touch devices grant audio on pointerup/touchend; retry the resume there.
    void host.ctx.resume();
  }
}
for (const t of UNLOCK_EVENTS) window.addEventListener(t, unlockAudio, true);

// ------------------------------------------------------------------ title screen

const title = document.getElementById('title') as HTMLElement;
const titleScreen = new PixelScreen(title.querySelector('canvas') as HTMLCanvasElement, 160, 48);
titleScreen.clear(INK.bg);
titleScreen.text((160 - textWidth('GROOVEBOX', 4)) / 2, 8, 'GROOVEBOX', INK.hi, 4);
const tagline = 'TECHNO - DNB - DUB - JUNGLE';
titleScreen.text((160 - textWidth(tagline)) / 2, 36, tagline, INK.mid);

let titleGone = false;
function dismissTitle(): void {
  if (titleGone) return;
  titleGone = true;
  title.classList.add('fade');
  window.setTimeout(() => title.remove(), 700);
}
window.setTimeout(dismissTitle, TITLE_HOLD_MS);
title.addEventListener('pointerdown', dismissTitle);

// ------------------------------------------------------------------ wake lock

type WakeLock = { release(): Promise<void> };
let wakeLock: WakeLock | null = null;
async function updateWakeLock(): Promise<void> {
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLock> } };
  try {
    if (app.playing && !wakeLock && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
    if (!app.playing && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported or denied */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { wakeLock = null; void updateWakeLock(); }
});

// ------------------------------------------------------------------ frame loop

let wasPlaying = false;
const frame = (now: number) => {
  if (host) {
    const lat = host.latency();
    audio.latencyMs = (Number.isFinite(lat.baseMs) ? lat.baseMs : 0) + (Number.isFinite(lat.outputMs) ? lat.outputMs : 0);
    if (audio.state === 'on' && host.ctx.state !== 'running') audio.state = 'off';
    else if (audio.state === 'off' && host.ctx.state === 'running') audio.state = 'on';
  }
  if (app.playing !== wasPlaying) { wasPlaying = app.playing; void updateWakeLock(); }
  app.updateFrame(now);
  drawMainView(screen, app.screenView(now, audio));
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
