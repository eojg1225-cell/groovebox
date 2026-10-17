/**
 * Master limiter: a clean look-ahead peak limiter, so the mix never clips and is never
 * coloured below the ceiling (it replaces a tanh soft-clip that saturated the whole mix).
 *
 * Per sample: the gain needed to keep both channels under CEILING; its minimum over the
 * look-ahead window, box-averaged over the same window, reaches that gain smoothly by the
 * time the peak leaves the delay line (no overshoot, no clicks); then a slow release. Linked
 * stereo. Allocation-free after construction; LOOKAHEAD adds 1.5 ms of latency.
 */
export const CEILING = Math.pow(10, -1 / 20); // -1 dBFS
const LOOKAHEAD = 0.0015;
const RELEASE = 0.08;

export class Limiter {
  /** Look-ahead delay in frames (the limiter's latency). */
  readonly len: number;
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private pos = 0;
  // Sliding-window minimum of the needed gain (monotonic deque in a ring).
  private readonly dqVal: Float32Array;
  private readonly dqAt: Float64Array;
  private dqHead = 0;
  private dqTail = 0;
  // Box average of the windowed minimum.
  private readonly box: Float32Array;
  private boxSum: number;
  private boxPos = 0;
  private n = 0;
  private gain = 1;
  private readonly release: number;
  /** Lowest gain in the last block (for metering): 1 = not limiting. */
  reduction = 1;

  constructor(sampleRate: number) {
    this.len = Math.max(1, Math.round(LOOKAHEAD * sampleRate));
    this.delayL = new Float32Array(this.len);
    this.delayR = new Float32Array(this.len);
    this.dqVal = new Float32Array(this.len + 2);
    this.dqAt = new Float64Array(this.len + 2);
    this.box = new Float32Array(this.len).fill(1);
    this.boxSum = this.len;
    this.release = 1 - Math.exp(-1 / (RELEASE * sampleRate));
  }

  process(l: Float32Array, r: Float32Array, frames: number): void {
    const len = this.len;
    const cap = len + 2;
    let minGain = 1;
    for (let i = 0; i < frames; i++) {
      const xl = l[i];
      const xr = r[i];
      const a = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr);
      const need = a > CEILING ? CEILING / a : 1;
      // Window minimum over the last len + 1 samples.
      const now = this.n++;
      while (this.dqTail !== this.dqHead && this.dqVal[(this.dqTail - 1 + cap) % cap] >= need) this.dqTail = (this.dqTail - 1 + cap) % cap;
      this.dqVal[this.dqTail] = need;
      this.dqAt[this.dqTail] = now;
      this.dqTail = (this.dqTail + 1) % cap;
      while (this.dqAt[this.dqHead] < now - len) this.dqHead = (this.dqHead + 1) % cap;
      const wmin = this.dqVal[this.dqHead];
      // Box average: falls to the peak's gain exactly as the peak leaves the delay.
      this.boxSum += wmin - this.box[this.boxPos];
      this.box[this.boxPos] = wmin;
      this.boxPos = this.boxPos + 1 === len ? 0 : this.boxPos + 1;
      const target = this.boxSum / len;
      this.gain = target < this.gain ? target : this.gain + (target - this.gain) * this.release;
      // Delayed signal out.
      const dl = this.delayL[this.pos];
      const dr = this.delayR[this.pos];
      this.delayL[this.pos] = xl;
      this.delayR[this.pos] = xr;
      this.pos = this.pos + 1 === len ? 0 : this.pos + 1;
      let ol = dl * this.gain;
      let or = dr * this.gain;
      // Last-resort guard against rounding (never reached in normal use).
      ol = ol > 1 ? 1 : ol < -1 ? -1 : ol;
      or = or > 1 ? 1 : or < -1 ? -1 : or;
      l[i] = ol;
      r[i] = or;
      if (this.gain < minGain) minGain = this.gain;
    }
    if (this.boxSum > len) this.boxSum = len; // keep rounding drift bounded
    this.reduction = minGain;
  }
}
