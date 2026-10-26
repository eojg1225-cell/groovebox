import videoUrl from './awake.mp4';

type WakeLock = { release(): Promise<void>; addEventListener(type: 'release', fn: () => void): void };
type WakeNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLock> } };

/**
 * Keeps the screen on while wanted: the Screen Wake Lock, or where that is refused or
 * missing (a page in a frame that may not ask for it, as the claude.ai Artifact; older
 * browsers) a tiny muted looping video playing out of sight, which browsers keep the screen
 * on for (the NoSleep trick).
 */
export class ScreenAwake {
  private lock: WakeLock | null = null;
  private video: HTMLVideoElement | null = null;
  private want = false;

  constructor() {
    // The browser drops the lock (and may pause the video) while the page is hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this.lock = null;
      if (this.want) void this.on();
    });
  }

  set(want: boolean): void {
    if (want === this.want) return;
    this.want = want;
    if (want) void this.on();
    else this.off();
  }

  private async on(): Promise<void> {
    const nav = navigator as WakeNavigator;
    try {
      if (!nav.wakeLock) throw new Error('no wake lock');
      const lock = await nav.wakeLock.request('screen');
      if (!this.want) { void lock.release(); return; }
      this.lock = lock;
      lock.addEventListener('release', () => { if (this.lock === lock) this.lock = null; });
      this.video?.pause();
    } catch {
      this.playVideo();
    }
  }

  private off(): void {
    void this.lock?.release().catch(() => undefined);
    this.lock = null;
    this.video?.pause();
  }

  private playVideo(): void {
    if (!this.video) {
      const v = document.createElement('video');
      v.src = videoUrl;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('aria-hidden', 'true');
      // On the page (a hidden video may not count) but out of sight and out of the way.
      v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
      document.body.appendChild(v);
      this.video = v;
    }
    void this.video.play().catch(() => undefined);
  }
}
