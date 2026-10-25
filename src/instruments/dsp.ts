/** Small allocation-free DSP building blocks shared by instruments. */

/** Multiplier that makes an exponential decay fall by 60 dB in `seconds`. */
export function decayMul(seconds: number, sampleRate: number): number {
  return Math.pow(0.001, 1 / (Math.max(seconds, 1e-4) * sampleRate));
}

/** Fast deterministic white noise (xorshift32), output -1..1. */
export class Noise {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed | 0 || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x;
    return (x | 0) / 2147483648;
  }
}

/**
 * Zero-delay-feedback state-variable filter (Simper / Cytomic TPT form).
 * Call setup() when cutoff/resonance change, then process() per sample;
 * read low/band/high from the fields after each call.
 */
export class Svf {
  low = 0;
  band = 0;
  high = 0;
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;
  private k = 2;

  /** resonance 0..1 (approaching 1 self-oscillates). */
  setup(cutoff: number, resonance: number, sampleRate: number): void {
    const fc = Math.min(cutoff, sampleRate * 0.45);
    const g = Math.tan((Math.PI * fc) / sampleRate);
    this.k = 2 - 2 * Math.min(resonance, 0.98);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  process(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    // Flush denormals.
    if (Math.abs(this.ic1) < 1e-15) this.ic1 = 0;
    if (Math.abs(this.ic2) < 1e-15) this.ic2 = 0;
    this.low = v2;
    this.band = v1;
    this.high = x - this.k * v1 - v2;
  }

  reset(): void {
    this.ic1 = this.ic2 = 0;
  }

  /** Died away (its state flushed to zero): silence in = silence out. */
  get quiet(): boolean {
    return this.ic1 === 0 && this.ic2 === 0;
  }
}

/**
 * An onboard effect's idle switch (PLUCK's delay + room, the drums' AIR): once silence has
 * gone in and (nearly) silence come out for longer than its longest echo, it is skipped until
 * sound comes in again. Call skip() before processing a block and done() after.
 */
export class IdleGate {
  private quiet = 0;
  private silentIn = false;
  private readonly frames: number;

  constructor(seconds: number, sampleRate: number) {
    this.frames = Math.round(seconds * sampleRate);
  }

  skip(l: Float32Array, r: Float32Array, n: number): boolean {
    this.silentIn = silent(l, r, n);
    if (!this.silentIn) this.quiet = 0;
    return this.silentIn && this.quiet >= this.frames;
  }

  done(l: Float32Array, r: Float32Array, n: number): void {
    if (!this.silentIn) return;
    for (let i = 0; i < n; i++) {
      if (Math.abs(l[i]) > IDLE_LEVEL || Math.abs(r[i]) > IDLE_LEVEL) { this.quiet = 0; return; }
    }
    this.quiet += n;
  }
}
const IDLE_LEVEL = 1e-6;

/** Nothing but zeros in l / r [0, n). */
export function silent(l: Float32Array, r: Float32Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (l[i] !== 0 || r[i] !== 0) return false;
  return true;
}

/** PolyBLEP correction for a discontinuity at phase 0 (phase, inc in cycles). */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export function midiToHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}
