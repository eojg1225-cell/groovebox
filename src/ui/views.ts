/**
 * What the pixel screen shows. Pure drawing from a plain state object.
 */
import { INK, PixelScreen, SCREEN_H, SCREEN_W } from './screen';

export interface ScreenState {
  playing: boolean;
  lastName: string;
  lastValueText: string;
  lastNorm: number;
  peakL: number;
  peakR: number;
  tapFlash: number; // 0..1
  sampleRate: number;
  baseMs: number;
  outputMs: number;
  roundTripMs: number;
  audioState: string;
}

function ms(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) + 'MS' : 'N/A';
}

function meterDb(peak: number): number {
  // Map -48..0 dBFS to 0..1.
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(1, (db + 48) / 48));
}

export function drawMainView(s: PixelScreen, st: ScreenState): void {
  s.clear();

  // Header
  s.rect(0, 0, SCREEN_W, 9, INK.dim);
  s.text(2, 2, 'GROOVEBOX M0', INK.hi);
  s.textRight(SCREEN_W - 2, 2, st.playing ? '> PLAY' : 'STOP', st.playing ? INK.hi : INK.mid);

  // Last touched control
  s.text(4, 16, st.lastName, INK.mid);
  s.text(4, 26, st.lastValueText, INK.hi, 3);
  s.frame(4, 48, 160, 7, INK.mid);
  s.rect(6, 50, 156 * st.lastNorm, 3, INK.hi);

  // Tap indicator
  s.frame(176, 16, 32, 32, INK.mid);
  if (st.tapFlash > 0) {
    const inset = Math.round((1 - st.tapFlash) * 12);
    s.rect(178 + inset, 18 + inset, 28 - inset * 2, 28 - inset * 2, INK.hi);
  }
  s.text(180, 50, 'TAP', INK.mid);

  // Meters
  s.text(216, 16, 'L', INK.mid);
  s.text(232, 16, 'R', INK.mid);
  drawMeter(s, 214, 24, meterDb(st.peakL), st.peakL >= 0.99);
  drawMeter(s, 230, 24, meterDb(st.peakR), st.peakR >= 0.99);

  // Debug / latency
  const y = SCREEN_H - 32;
  s.rect(0, y - 3, SCREEN_W, 1, INK.dim);
  s.text(4, y, `SR ${st.sampleRate}  AUDIO ${st.audioState.toUpperCase()}`, INK.mid);
  s.text(4, y + 8, `BASE ${ms(st.baseMs)}  OUT ${ms(st.outputMs)}`, INK.mid);
  const total = (Number.isFinite(st.baseMs) ? st.baseMs : 0) + (Number.isFinite(st.outputMs) ? st.outputMs : 0);
  s.text(4, y + 16, `TOTAL ${ms(total)}  MSG RTT ${ms(st.roundTripMs)}`, INK.hi);
}

function drawMeter(s: PixelScreen, x: number, y: number, level: number, clip: boolean): void {
  const h = 60;
  s.frame(x, y, 10, h, INK.dim);
  const segs = 14;
  const lit = Math.round(level * segs);
  for (let i = 0; i < segs; i++) {
    const sy = y + h - 4 - i * 4;
    const color = i < lit ? (i >= segs - 2 ? INK.warn : INK.hi) : INK.dim;
    s.rect(x + 2, sy, 6, 3, color);
  }
  if (clip) s.rect(x, y - 4, 10, 2, INK.warn);
}
