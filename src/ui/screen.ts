/**
 * Fixed low-resolution pixel display, scaled up with crisp edges by CSS.
 * Drawing is done in screen pixels with a tiny API so views stay simple to port.
 */
import { ADVANCE, GLYPH_H, GLYPH_W, glyphBits, textWidth } from './font';

export const SCREEN_W = 256;
export const SCREEN_H = 128;

export const INK = {
  bg: '#061312',
  dim: '#1a4842',
  mid: '#34a596',
  hi: '#a0f5ea',
  warn: '#e8b53a',
  shade: '#0f2422',
} as const;

/** Recorded draw commands: 'c' color | 'r' x y w h color | 't' x y text color scale mixed. */
type Op = string | number;

/**
 * The pixel display. Between begin() and end() the views' drawing is recorded, and the
 * canvas is only touched when the frame differs from the last one (most frames repeat).
 * Text is drawn from cached glyph images (one drawImage per character, not per pixel).
 */
export class PixelScreen {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;

  readonly w: number;
  readonly h: number;
  private recording = false;
  private ops: Op[] = [];
  private len = 0;
  private prev: Op[] = [];
  private prevLen = -1;
  private readonly glyphs = new Map<string, HTMLCanvasElement | null>();

  constructor(canvas: HTMLCanvasElement, w = SCREEN_W, h = SCREEN_H) {
    canvas.width = w;
    canvas.height = h;
    this.w = w;
    this.h = h;
    this.canvas = canvas;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2D canvas not available');
    g.imageSmoothingEnabled = false;
    this.g = g;
  }

  /** Start a frame: the drawing that follows is recorded. */
  begin(): void {
    this.recording = true;
    this.len = 0;
  }

  /** End the frame: draw it, unless it is the same as the last one. */
  end(): void {
    this.recording = false;
    const ops = this.ops;
    const n = this.len;
    let same = n === this.prevLen;
    for (let i = 0; same && i < n; i++) same = ops[i] === this.prev[i];
    if (same) return;
    for (let i = 0; i < n;) {
      switch (ops[i]) {
        case 'c': this.drawClear(ops[i + 1] as string); i += 2; break;
        case 'r': this.drawRect(ops[i + 1] as number, ops[i + 2] as number, ops[i + 3] as number, ops[i + 4] as number, ops[i + 5] as string); i += 6; break;
        default: this.drawText(ops[i + 1] as number, ops[i + 2] as number, ops[i + 3] as string, ops[i + 4] as string, ops[i + 5] as number, ops[i + 6] === 1); i += 7;
      }
    }
    // Keep this frame for the next comparison (swap the buffers).
    this.ops = this.prev;
    this.prev = ops;
    this.prevLen = n;
  }

  private push(a: Op, b: Op, c?: Op, d?: Op, e?: Op, f?: Op, g?: Op): void {
    const o = this.ops;
    let i = this.len;
    o[i++] = a; o[i++] = b;
    if (c !== undefined) { o[i++] = c; o[i++] = d!; o[i++] = e!; o[i++] = f!; }
    if (g !== undefined) o[i++] = g;
    this.len = i;
  }

  clear(color: string = INK.bg): void {
    if (this.recording) this.push('c', color);
    else this.drawClear(color);
  }

  rect(x: number, y: number, w: number, h: number, color: string): void {
    const rx = Math.round(x), ry = Math.round(y), rw = Math.round(w), rh = Math.round(h);
    if (this.recording) this.push('r', rx, ry, rw, rh, color);
    else this.drawRect(rx, ry, rw, rh, color);
  }

  frame(x: number, y: number, w: number, h: number, color: string): void {
    this.rect(x, y, w, 1, color);
    this.rect(x, y + h - 1, w, 1, color);
    this.rect(x, y, 1, h, color);
    this.rect(x + w - 1, y, 1, h, color);
  }

  text(x: number, y: number, text: string, color: string, scale = 1, mixedCase = false): void {
    const rx = Math.round(x), ry = Math.round(y);
    if (this.recording) this.push('t', rx, ry, text, color, scale, mixedCase ? 1 : 0);
    else this.drawText(rx, ry, text, color, scale, mixedCase);
  }

  textRight(xRight: number, y: number, text: string, color: string, scale = 1): void {
    this.text(xRight - textWidth(text, scale), y, text, color, scale);
  }

  private drawClear(color: string): void {
    this.g.fillStyle = color;
    this.g.fillRect(0, 0, this.w, this.h);
  }

  private drawRect(x: number, y: number, w: number, h: number, color: string): void {
    this.g.fillStyle = color;
    this.g.fillRect(x, y, w, h);
  }

  private drawText(x: number, y: number, text: string, color: string, scale: number, mixedCase: boolean): void {
    let cx = x;
    for (const ch of text) {
      const img = this.glyph(ch, color, scale, mixedCase);
      if (img) this.g.drawImage(img, cx, y);
      cx += ADVANCE * scale;
    }
  }

  /** A character in a colour and scale, drawn once into its own small canvas (null = blank). */
  private glyph(ch: string, color: string, scale: number, mixedCase: boolean): HTMLCanvasElement | null {
    const key = `${ch}|${color}|${scale}|${mixedCase ? 1 : 0}`;
    let img = this.glyphs.get(key);
    if (img !== undefined) return img;
    const bits = glyphBits(ch, mixedCase);
    img = null;
    if (bits.some((b) => b)) {
      img = document.createElement('canvas');
      img.width = GLYPH_W * scale;
      img.height = GLYPH_H * scale;
      const g = img.getContext('2d')!;
      g.fillStyle = color;
      for (let row = 0; row < GLYPH_H; row++) {
        for (let col = 0; col < GLYPH_W; col++) {
          if (bits[row * GLYPH_W + col]) g.fillRect(col * scale, row * scale, scale, scale);
        }
      }
    }
    this.glyphs.set(key, img);
    return img;
  }
}
