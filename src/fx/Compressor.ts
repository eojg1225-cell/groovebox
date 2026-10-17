import type { ParamSpec } from '../engine/params';

/**
 * Bus compressor (FX 1, FX 2, FX 3): in series, for an even level. THRESH and RATIO set
 * how hard levels above the threshold are held down; ATTACK / RELEASE how fast it grabs and
 * lets go. Stereo-linked peak detection, gain smoothed in dB, automatic make-up (half the
 * reduction a full-scale peak would get) so turning it up keeps the level, not drops it.
 * RATIO 1:1 = off (bit-transparent). Allocation-free.
 */
export const COMP_PARAMS: readonly ParamSpec[] = [
  { id: 'cmp_thresh', name: 'THRESH', min: -60, max: 0, defaultValue: -18, unit: 'DB', curve: 'linear', decimals: 0 },
  { id: 'cmp_ratio', name: 'RATIO', min: 1, max: 20, defaultValue: 1, unit: ':1', curve: 'exp', decimals: 1 },
  { id: 'cmp_attack', name: 'CMP ATK', min: 0.0001, max: 0.1, defaultValue: 0.005, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'cmp_release', name: 'CMP REL', min: 0.01, max: 2, defaultValue: 0.15, unit: 'S', curve: 'exp', decimals: 3 },
];

export class Compressor {
  private readonly sr: number;
  private thresh = -18;
  private ratio = 1;
  private attack = 0;
  private release = 0;
  private makeupDb = 0;
  private grDb = 0;
  /** Deepest gain reduction (dB, positive) since the last read (for metering). */
  reduction = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    for (const p of COMP_PARAMS) this.setParam(p.id, p.defaultValue);
  }

  setParam(id: string, v: number): void {
    switch (id) {
      case 'cmp_thresh': this.thresh = v; break;
      case 'cmp_ratio': this.ratio = Math.max(1, v); break;
      case 'cmp_attack': this.attack = 1 - Math.exp(-1 / (Math.max(v, 1e-5) * this.sr)); break;
      case 'cmp_release': this.release = 1 - Math.exp(-1 / (Math.max(v, 1e-4) * this.sr)); break;
    }
    this.makeupDb = (-this.thresh * (1 - 1 / this.ratio)) / 2;
  }

  /** Off at 1:1 (callers can skip it). */
  get active(): boolean {
    return this.ratio > 1.0001 || this.grDb > 1e-4;
  }

  /** The gain for one stereo sample pair (apply it to both). */
  gain(l: number, r: number): number {
    const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
    const slope = 1 - 1 / this.ratio;
    let target = 0;
    if (slope > 0 && a > 1e-6) {
      const over = 20 * Math.log10(a) - this.thresh;
      if (over > 0) target = over * slope;
    }
    this.grDb += (target - this.grDb) * (target > this.grDb ? this.attack : this.release);
    if (this.grDb > this.reduction) this.reduction = this.grDb;
    return Math.pow(10, (this.makeupDb - this.grDb) / 20);
  }

  /** In place over [off, off + n). */
  process(l: Float32Array, r: Float32Array, off: number, n: number): void {
    if (!this.active) return;
    for (let i = off; i < off + n; i++) {
      const g = this.gain(l[i], r[i]);
      l[i] *= g;
      r[i] *= g;
    }
    if (this.grDb < 1e-6) this.grDb = 0;
  }
}
