/**
 * Fixed low-resolution pixel display, scaled up with crisp edges by CSS.
 * Drawing is done in screen pixels with a tiny API so views stay simple to port.
 */
import { ADVANCE, GLYPH_H, GLYPH_W, glyphBits, textWidth } from './font';

export const SCREEN_W = 256;
export const SCREEN_H = 128;

export const INK = {
  bg: '#0a1410',
  dim: '#1f4a35',
  mid: '#3fa070',
  hi: '#9cffc8',
  warn: '#ffb347',
  shade: '#11241b',
} as const;

export class PixelScreen {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;

  readonly w: number;
  readonly h: number;

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

  clear(color: string = INK.bg): void {
    this.g.fillStyle = color;
    this.g.fillRect(0, 0, this.w, this.h);
  }

  rect(x: number, y: number, w: number, h: number, color: string): void {
    this.g.fillStyle = color;
    this.g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  frame(x: number, y: number, w: number, h: number, color: string): void {
    this.rect(x, y, w, 1, color);
    this.rect(x, y + h - 1, w, 1, color);
    this.rect(x, y, 1, h, color);
    this.rect(x + w - 1, y, 1, h, color);
  }

  text(x: number, y: number, text: string, color: string, scale = 1, mixedCase = false): void {
    this.g.fillStyle = color;
    let cx = Math.round(x);
    const cy = Math.round(y);
    for (const ch of text) {
      const bits = glyphBits(ch, mixedCase);
      for (let row = 0; row < GLYPH_H; row++) {
        for (let col = 0; col < GLYPH_W; col++) {
          if (bits[row * GLYPH_W + col]) this.g.fillRect(cx + col * scale, cy + row * scale, scale, scale);
        }
      }
      cx += ADVANCE * scale;
    }
  }

  textRight(xRight: number, y: number, text: string, color: string, scale = 1): void {
    this.text(xRight - textWidth(text, scale), y, text, color, scale);
  }
}
