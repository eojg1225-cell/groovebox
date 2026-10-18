import { Smoother } from '../engine/smoother';

/** Coefficients refresh this often (samples) while the knob moves. */
const UPDATE = 32;

/**
 * Master LO-FI: a post-processing colour, tape-like rather than an effect. As AMOUNT rises:
 *  - MID DIP: a wide dip (Q 0.7) centred ~800 Hz, moving up a little (to ~1 kHz) as it
 *    deepens: about -3 dB at half, -8 dB at full;
 *  - SATURATION: a soft, slightly asymmetric curve (even harmonics) normalised to unity
 *    gain for quiet signals, so it only rounds off peaks - gentle tape compression -
 *    blended in parallel with the dry signal;
 *  - only near the top: a soft high roll-off (17 kHz at half, ~9 kHz at full).
 * Most of the knob is subtle; the last part is a deliberate, noticeable degradation.
 * At 0 it is bypassed. Processes in place.
 */
export class Tape {
  private readonly sr: number;
  private readonly amount: Smoother;
  private counter = 0;
  // Mid-cut biquad (RBJ peaking), direct form 1, per channel.
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1L = 0; private x2L = 0; private y1L = 0; private y2L = 0;
  private x1R = 0; private x2R = 0; private y1R = 0; private y2R = 0;
  // Saturation and roll-off settings for the current amount.
  private drive = 1; private bias = 0; private biasOut = 0; private norm = 1; private wet = 0; private makeup = 1;
  private lpc = 1;
  private lpL = 0; private lpR = 0;
  // DC blocker after the (asymmetric) saturation.
  private readonly dcR: number;
  private dxL = 0; private dyL = 0; private dxR = 0; private dyR = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.amount = new Smoother(0, 0.05, sampleRate);
    this.dcR = 1 - (2 * Math.PI * 8) / sampleRate; // ~8 Hz
  }

  setAmount(a: number): void {
    this.amount.setTarget(Math.min(1, Math.max(0, a)));
  }

  setImmediate(a: number): void {
    this.amount.setImmediate(Math.min(1, Math.max(0, a)));
    this.counter = 0;
  }

  /** Recompute everything for amount a (0..1]. */
  private update(a: number): void {
    // Mid cut
    const f0 = 800 * (1 + 0.3 * a);
    const gainDb = -8 * Math.pow(a, 1.3);
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f0) / this.sr;
    const alpha = Math.sin(w0) / (2 * 0.7);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * cos) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha / A) / a0;
    // Saturation: drive up to 4x (mostly near the top), asymmetry, unity small-signal gain,
    // parallel blend.
    this.drive = 1 + 3 * a * a * a;
    this.bias = 0.15 * a;
    this.biasOut = Math.tanh(this.bias);
    const slope = 1 - this.biasOut * this.biasOut; // tanh' at the bias point
    this.norm = 1 / (this.drive * slope);
    this.wet = a;
    this.makeup = 1 + 0.3 * a * a;
    // Roll-off only near the top of the knob.
    const fc = 20000 * Math.pow(2, -1.2 * a * a * a);
    this.lpc = fc >= 19500 ? 1 : 1 - Math.exp((-2 * Math.PI * fc) / this.sr);
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.amount.next();
      const xl = l[i];
      const xr = r[i];
      if (a < 1e-4) {
        // Bypassed: keep the filters following the signal so engaging it doesn't click.
        this.x2L = this.x1L = this.y2L = this.y1L = this.lpL = xl;
        this.x2R = this.x1R = this.y2R = this.y1R = this.lpR = xr;
        this.dxL = xl; this.dxR = xr; this.dyL = this.dyR = 0;
        this.counter = 0;
        continue;
      }
      if (this.counter-- <= 0) {
        this.counter = UPDATE;
        this.update(a);
      }
      // Mid cut
      let ml = this.b0 * xl + this.b1 * this.x1L + this.b2 * this.x2L - this.a1 * this.y1L - this.a2 * this.y2L;
      let mr = this.b0 * xr + this.b1 * this.x1R + this.b2 * this.x2R - this.a1 * this.y1R - this.a2 * this.y2R;
      this.x2L = this.x1L; this.x1L = xl; this.y2L = this.y1L; this.y1L = ml;
      this.x2R = this.x1R; this.x1R = xr; this.y2R = this.y1R; this.y1R = mr;
      // Saturation (parallel)
      const sl = (Math.tanh(ml * this.drive + this.bias) - this.biasOut) * this.norm;
      const sr = (Math.tanh(mr * this.drive + this.bias) - this.biasOut) * this.norm;
      ml = (ml + (sl - ml) * this.wet) * this.makeup;
      mr = (mr + (sr - mr) * this.wet) * this.makeup;
      // DC blocker: the asymmetry adds a small offset.
      this.dyL = ml - this.dxL + this.dcR * this.dyL; this.dxL = ml; ml = this.dyL;
      this.dyR = mr - this.dxR + this.dcR * this.dyR; this.dxR = mr; mr = this.dyR;
      // High roll-off
      if (this.lpc < 1) {
        this.lpL += (ml - this.lpL) * this.lpc;
        this.lpR += (mr - this.lpR) * this.lpc;
        ml = this.lpL;
        mr = this.lpR;
      } else {
        this.lpL = ml;
        this.lpR = mr;
      }
      l[i] = ml;
      r[i] = mr;
    }
    if (Math.abs(this.y1L) < 1e-15) this.y1L = this.y2L = 0;
    if (Math.abs(this.y1R) < 1e-15) this.y1R = this.y2R = 0;
    if (Math.abs(this.dyL) < 1e-15) this.dyL = 0;
    if (Math.abs(this.dyR) < 1e-15) this.dyR = 0;
  }
}
