import { Smoother } from '../engine/smoother';

/**
 * Master LO-FI: one knob that moves towards saturated tape. As AMOUNT rises:
 * a low-end bump (~+5 dB under 150 Hz), progressive tanh saturation with loudness
 * compensation, and a 12 dB/oct high roll-off from 20 kHz down to ~3.5 kHz.
 * At 0 it is bypassed. Processes in place.
 */
export class Tape {
  private readonly sr: number;
  private readonly amount: Smoother;
  private readonly lowCoeff: number;
  private lowL = 0; private lowR = 0;
  private lp1L = 0; private lp2L = 0; private lp1R = 0; private lp2R = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.amount = new Smoother(0, 0.05, sampleRate);
    this.lowCoeff = 1 - Math.exp((-2 * Math.PI * 150) / sampleRate);
  }

  setAmount(a: number): void {
    this.amount.setTarget(Math.min(1, Math.max(0, a)));
  }

  setImmediate(a: number): void {
    this.amount.setImmediate(Math.min(1, Math.max(0, a)));
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.amount.next();
      if (a < 1e-4) {
        // Keep the filter state following the signal so engaging it doesn't click.
        this.lp1L = this.lp2L = l[i]; this.lp1R = this.lp2R = r[i];
        this.lowL = l[i]; this.lowR = r[i];
        continue;
      }
      const drive = 1 + a * 7;
      const comp = 1 / (1 + a * 1.6);
      const lpc = 1 - Math.exp((-2 * Math.PI * 20000 * Math.pow(2, -a * 2.5)) / this.sr);
      // Low bump
      this.lowL += (l[i] - this.lowL) * this.lowCoeff;
      this.lowR += (r[i] - this.lowR) * this.lowCoeff;
      let xl = l[i] + this.lowL * a * 0.8;
      let xr = r[i] + this.lowR * a * 0.8;
      // Saturation (slightly asymmetric, like tape)
      xl = Math.tanh(xl * drive + 0.05 * a) - Math.tanh(0.05 * a);
      xr = Math.tanh(xr * drive + 0.05 * a) - Math.tanh(0.05 * a);
      xl *= comp * (1 + a);
      xr *= comp * (1 + a);
      // High roll-off, two one-pole stages
      this.lp1L += (xl - this.lp1L) * lpc; this.lp2L += (this.lp1L - this.lp2L) * lpc;
      this.lp1R += (xr - this.lp1R) * lpc; this.lp2R += (this.lp1R - this.lp2R) * lpc;
      l[i] = this.lp2L;
      r[i] = this.lp2R;
    }
    if (Math.abs(this.lp2L) < 1e-15) { this.lp1L = this.lp2L = this.lowL = 0; }
    if (Math.abs(this.lp2R) < 1e-15) { this.lp1R = this.lp2R = this.lowR = 0; }
  }
}
