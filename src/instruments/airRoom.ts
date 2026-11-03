/**
 * AIR's room (KICK, SNARE): the small mono ambience heard on sampled breaks. The drum goes
 * through the type's fixed EQ first (pre-EQ: two high-passes, then a low-pass, so the tail
 * never carries the sub, the mud or the fizz), then early reflections and a dense diffuse
 * tail, all mono. The tail always rings long inside (TAIL_RT, past the old SIZE's longest);
 * each hit starts one envelope of AIR_LENGTH that shapes what is heard, and TAIL bends it:
 * low = a steep fall from the start (logarithmic-like), middle = a straight fall, high = the
 * inverse (it holds, then rolls off steeply: gated). Nothing moves a delay, so turning TAIL
 * never clicks. Allocation-free.
 */
import { Svf } from './dsp';

/** The tail's own decay (RT60, s): longer than the old SIZE's top (1.2 s), so it is dense. */
const TAIL_RT = 4;
/** The envelope each hit starts (s), and its table's points. */
const AIR_LENGTH = 0.5;
const ENV_POINTS = 256;
/** How far TAIL bends the envelope at either end: (1 - t)^k at 0, 1 - t^k at 1. */
const TAIL_BEND = 10;
/** Early reflections (ms after the pre-delay) and their gains: a small, close room. */
const EARLY_MS = [4.3, 7.9, 11.6, 16.3, 21.7, 27.1];
const EARLY_GAIN = [0.55, -0.45, 0.38, -0.31, 0.25, -0.2];
/** The tail's combs (ms) and its two diffusing allpasses (ms, gain). */
const COMB_MS = [19.7, 23.3, 27.1, 31.9];
const ALLPASS_MS = [5.1, 1.7];
const ALLPASS_G = 0.6;
const PRE_MS = 3;
/** The combs' damping (one-pole low-pass in the loop): each round darker. */
const DAMP = 0.35;
const EQ_RESO = 0.3;
/** The room's level at TAIL 0.4: as loud as the old room at its default SIZE (gated measure). */
const ROOM_GAIN = 1.175;
/** Tail level against the early reflections. */
const TAIL_GAIN = 0.32;

export class AirRoom {
  private readonly hp1 = new Svf();
  private readonly hp2 = new Svf();
  private readonly lp = new Svf();
  /** The pre-EQ'd input (pre-delay + early reflections read from it). */
  private readonly line: Float32Array;
  private write = 0;
  private readonly early: Int32Array;
  private readonly combs: Float32Array[];
  private readonly combAt = new Int32Array(COMB_MS.length);
  private readonly combStore = new Float64Array(COMB_MS.length);
  private readonly combG = new Float64Array(COMB_MS.length);
  private readonly aps: Float32Array[];
  private readonly apAt = new Int32Array(ALLPASS_MS.length);
  private readonly sr: number;
  /** The envelope: its shape (ENV_POINTS + 1 points over AIR_LENGTH), where a hit has got to. */
  private readonly env = new Float32Array(ENV_POINTS + 1);
  private envPos = ENV_POINTS;
  private readonly envStep: number;

  constructor(sampleRate: number, highPass: number, lowPass: number) {
    this.sr = sampleRate;
    const n = (ms: number) => Math.max(1, Math.round((ms / 1000) * sampleRate));
    this.hp1.setup(highPass, EQ_RESO, sampleRate);
    this.hp2.setup(highPass, EQ_RESO, sampleRate);
    this.lp.setup(lowPass, EQ_RESO, sampleRate);
    this.early = Int32Array.from(EARLY_MS, (ms) => n(PRE_MS + ms));
    this.line = new Float32Array(n(PRE_MS + EARLY_MS[EARLY_MS.length - 1]) + 1);
    this.combs = COMB_MS.map((ms) => new Float32Array(n(ms)));
    this.aps = ALLPASS_MS.map((ms) => new Float32Array(n(ms)));
    // Each comb loses 60 dB over TAIL_RT: g = 10^(-3 * delay / rt).
    this.combs.forEach((c, k) => { this.combG[k] = Math.pow(10, (-3 * c.length) / sampleRate / TAIL_RT); });
    this.envStep = ENV_POINTS / (AIR_LENGTH * sampleRate);
    this.setTail(0.4);
  }

  /**
   * TAIL 0..1: the envelope's shape over AIR_LENGTH. Below the middle (1 - t)^k, a steep fall
   * from the start; above it 1 - t^k, held and then a steep roll-off; k from 1 (the middle, a
   * straight fall) up to 1 + TAIL_BEND at either end.
   */
  setTail(v: number): void {
    const x = Math.min(1, Math.max(0, v));
    const k = 1 + TAIL_BEND * Math.abs(2 * x - 1);
    for (let i = 0; i <= ENV_POINTS; i++) {
      const t = i / ENV_POINTS;
      this.env[i] = x < 0.5 ? Math.pow(1 - t, k) : 1 - Math.pow(t, k);
    }
    this.env[ENV_POINTS] = 0;
  }

  /** A hit: the envelope starts again. */
  trigger(): void {
    this.envPos = 0;
  }

  reset(): void {
    this.hp1.reset(); this.hp2.reset(); this.lp.reset();
    this.line.fill(0);
    for (const c of this.combs) c.fill(0);
    for (const a of this.aps) a.fill(0);
    this.combStore.fill(0);
    this.envPos = ENV_POINTS;
  }

  /** Mono in (x), mono wet out (y); may be the same array. */
  process(x: Float32Array, y: Float32Array, n: number): void {
    const line = this.line, len = line.length, early = this.early;
    const pre = early[0] - Math.round((EARLY_MS[0] / 1000) * this.sr);
    for (let i = 0; i < n; i++) {
      // Pre-EQ.
      this.hp1.process(x[i]);
      this.hp2.process(this.hp1.high);
      this.lp.process(this.hp2.high);
      line[this.write] = this.lp.low;
      // Early reflections.
      let er = 0;
      for (let k = 0; k < early.length; k++) {
        let rp = this.write - early[k];
        if (rp < 0) rp += len;
        er += line[rp] * EARLY_GAIN[k];
      }
      // The tail: parallel damped combs fed the pre-delayed input, then two allpasses.
      let rp = this.write - pre;
      if (rp < 0) rp += len;
      const into = line[rp] * 0.25;
      let tail = 0;
      for (let k = 0; k < this.combs.length; k++) {
        const c = this.combs[k];
        const at = this.combAt[k];
        const out = c[at];
        let store = out * (1 - DAMP) + this.combStore[k] * DAMP;
        if (store < 1e-15 && store > -1e-15) store = 0;
        this.combStore[k] = store;
        c[at] = into + store * this.combG[k];
        this.combAt[k] = at + 1 === c.length ? 0 : at + 1;
        tail += out;
      }
      for (let k = 0; k < this.aps.length; k++) {
        const a = this.aps[k];
        const at = this.apAt[k];
        const d = a[at];
        const v = d - ALLPASS_G * tail;
        let w = tail + ALLPASS_G * v;
        if (w < 1e-15 && w > -1e-15) w = 0;
        a[at] = w;
        this.apAt[k] = at + 1 === a.length ? 0 : at + 1;
        tail = v;
      }
      if (++this.write === len) this.write = 0;
      // The envelope (read between its points); after AIR_LENGTH: silent.
      let g = 0;
      if (this.envPos < ENV_POINTS) {
        const at = this.envPos | 0, f = this.envPos - at;
        g = this.env[at] + (this.env[at + 1] - this.env[at]) * f;
        this.envPos += this.envStep;
      }
      y[i] = (er + tail * TAIL_GAIN) * g * ROOM_GAIN;
    }
  }
}
