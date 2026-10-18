import { Smoother } from '../engine/smoother';

const UPDATE = 32; // samples between coefficient updates
/** MID CUT at full: this deep (dB) ... */
export const TRACK_CUT_MAX_DB = 18;
/** ... and this wide (Q): a narrow notch when turned a little, a broad scoop at the top. */
const Q_NARROW = 2.5;
const Q_WIDE = 0.7;

/**
 * A track's MID CUT (after its DRIVE, an insert): one knob sets depth and width together,
 * the track's MID FREQ the centre. In place, allocation-free; idle (bypassed) at 0.
 */
export class TrackCut {
  private readonly sr: number;
  private readonly freq: Smoother;
  private readonly amount: Smoother;
  private counter = 0;
  private freqTarget = 1000;
  private amountTarget = 0;
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1L = 0; private x2L = 0; private y1L = 0; private y2L = 0;
  private x1R = 0; private x2R = 0; private y1R = 0; private y2R = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.freq = new Smoother(1000, 0.03, sampleRate);
    this.amount = new Smoother(0, 0.03, sampleRate);
  }

  setFreq(hz: number): void {
    this.freqTarget = hz;
    this.freq.setTarget(hz);
  }

  /** 0 = off .. 1 = the deepest, widest cut. */
  setAmount(a: number): void {
    this.amountTarget = a;
    this.amount.setTarget(a);
  }

  /** Jump to the targets (a project load, not while playing). */
  settle(): void {
    this.freq.setImmediate(this.freqTarget);
    this.amount.setImmediate(this.amountTarget);
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    if (this.amountTarget === 0 && this.amount.value < 1e-4) {
      if (this.amount.value !== 0) { this.amount.setImmediate(0); this.reset(); }
      return;
    }
    for (let i = 0; i < n; i++) {
      const f = this.freq.next();
      const a = this.amount.next();
      if (this.counter-- <= 0) {
        this.counter = UPDATE;
        this.coefficients(f, Q_NARROW + (Q_WIDE - Q_NARROW) * a, -TRACK_CUT_MAX_DB * a);
      }
      const xl = l[i];
      const yl = this.b0 * xl + this.b1 * this.x1L + this.b2 * this.x2L - this.a1 * this.y1L - this.a2 * this.y2L;
      this.x2L = this.x1L; this.x1L = xl; this.y2L = this.y1L; this.y1L = yl;
      const xr = r[i];
      const yr = this.b0 * xr + this.b1 * this.x1R + this.b2 * this.x2R - this.a1 * this.y1R - this.a2 * this.y2R;
      this.x2R = this.x1R; this.x1R = xr; this.y2R = this.y1R; this.y1R = yr;
      l[i] = yl;
      r[i] = yr;
    }
    if (Math.abs(this.y1L) < 1e-15) { this.y1L = 0; this.y2L = 0; }
    if (Math.abs(this.y1R) < 1e-15) { this.y1R = 0; this.y2R = 0; }
  }

  private reset(): void {
    this.x1L = this.x2L = this.y1L = this.y2L = 0;
    this.x1R = this.x2R = this.y1R = this.y2R = 0;
    this.counter = 0;
  }

  /** RBJ peaking biquad (negative gain = a cut). */
  private coefficients(f: number, q: number, gainDb: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * cos) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha / A) / a0;
  }
}
