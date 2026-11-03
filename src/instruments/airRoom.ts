/**
 * AIR's room (KICK, SNARE): a small, dense, GATED room. The drum goes through the type's fixed
 * EQ first (AirEq: so the tail never carries the sub, the mud or the fizz), waits out a
 * pre-delay (the hit's transient stays clear), then early reflections and a dense tail, all
 * mono. The tail always rings long inside (TAIL_RT); what you hear is shaped by the gate: each
 * hit opens it, it falls gradually over AIR LEN (by GATE_FALL, so a longer gate fades over
 * longer), then tails off in GATE_TAIL. Changing LEN never moves a delay, so it never clicks.
 * Allocation-free.
 */
import { Svf } from './dsp';

/** AIR LEN's range (s): how long the gate stays open after a hit. */
export const AIR_LEN_MIN = 0.03;
export const AIR_LEN_MAX = 0.8;
/** How far the gate falls over LEN (x, about -10 dB), then its tail-off time constant (s). */
const GATE_FALL = 0.32;
const GATE_TAIL = 0.012;
/** The tail's own decay (RT60, s): long, so it is dense and even while the gate is open. */
const TAIL_RT = 1.6;
/** Early reflections (ms after the pre-delay) and their gains: a small, close room. */
const EARLY_MS = [4.3, 7.9, 11.6, 16.3, 21.7, 27.1];
const EARLY_GAIN = [0.55, -0.45, 0.38, -0.31, 0.25, -0.2];
/** The tail: eight parallel damped combs (ms), then four diffusing allpasses (ms, gain). */
const COMB_MS = [22.1, 24.7, 27.3, 29.9, 32.3, 34.7, 37.1, 39.7];
const ALLPASS_MS = [7.3, 5.1, 3.1, 1.7];
const ALLPASS_G = 0.6;
/** The combs' damping (one-pole low-pass in the loop): each round darker. */
const DAMP = 0.3;
/** The low shelf's resonance: Q 0.707 (Svf k = 2 - 2 x reso = 1.414). */
const SHELF_RESO = 0.293;
const SHELF_K = 2 - 2 * SHELF_RESO;
/** Tail level against the early reflections (eight combs: each fed a little). */
const TAIL_GAIN = 0.16;

/** A type's room EQ (before the room) and pre-delay. */
export interface AirEq {
  /** Two high-passes here (Hz): the KICK's, so no sub or body reaches the room. */
  highPass?: number;
  /** A low shelf (Hz, dB): the SNARE's, some body without the mud. */
  lowShelf?: { hz: number; db: number };
  /** The top roll-off (Hz) and its resonance (0 = gentle). */
  lowPass: number;
  lowPassReso: number;
  /** Before the room starts (ms). */
  preMs: number;
}

export class AirRoom {
  private readonly hp1 = new Svf();
  private readonly hp2 = new Svf();
  private readonly shelf = new Svf();
  private readonly lp = new Svf();
  private readonly useHp: boolean;
  /** The low shelf (Simper's SVF form): A = 10^(dB / 40); y = x + k(A - 1) band + (A^2 - 1) low. */
  private readonly shelfA: number;
  private readonly shelfOn: boolean;
  /** The pre-EQ'd input (pre-delay + early reflections read from it). */
  private readonly line: Float32Array;
  private write = 0;
  private readonly early: Int32Array;
  private readonly pre: number;
  private readonly combs: Float32Array[];
  private readonly combAt = new Int32Array(COMB_MS.length);
  private readonly combStore = new Float64Array(COMB_MS.length);
  private readonly combG = new Float64Array(COMB_MS.length);
  private readonly aps: Float32Array[];
  private readonly apAt = new Int32Array(ALLPASS_MS.length);
  private readonly sr: number;
  /** The gate: its gain, samples left open, the fall per sample while open, the tail-off's. */
  private gate = 0;
  private gateLeft = 0;
  private gateFall = 1;
  private readonly gateTail: number;
  private len = 0.15;

  constructor(sampleRate: number, eq: AirEq) {
    this.sr = sampleRate;
    const n = (ms: number) => Math.max(1, Math.round((ms / 1000) * sampleRate));
    this.useHp = eq.highPass !== undefined;
    if (eq.highPass !== undefined) {
      this.hp1.setup(eq.highPass, 0.3, sampleRate);
      this.hp2.setup(eq.highPass, 0.3, sampleRate);
    }
    this.shelfOn = eq.lowShelf !== undefined;
    this.shelfA = eq.lowShelf ? Math.pow(10, eq.lowShelf.db / 40) : 1;
    if (eq.lowShelf) this.shelf.setup(eq.lowShelf.hz / Math.sqrt(this.shelfA), SHELF_RESO, sampleRate);
    this.lp.setup(eq.lowPass, eq.lowPassReso, sampleRate);
    this.pre = n(eq.preMs);
    this.early = Int32Array.from(EARLY_MS, (ms) => n(eq.preMs + ms));
    this.line = new Float32Array(n(eq.preMs + EARLY_MS[EARLY_MS.length - 1]) + 1);
    this.combs = COMB_MS.map((ms) => new Float32Array(n(ms)));
    this.aps = ALLPASS_MS.map((ms) => new Float32Array(n(ms)));
    // Each comb loses 60 dB over TAIL_RT: g = 10^(-3 * delay / rt).
    this.combs.forEach((c, k) => { this.combG[k] = Math.pow(10, (-3 * c.length) / sampleRate / TAIL_RT); });
    this.gateTail = Math.exp(-1 / (GATE_TAIL * sampleRate));
  }

  /** AIR LEN (s): how long the gate stays open after each hit. */
  setLength(seconds: number): void {
    this.len = Math.min(AIR_LEN_MAX, Math.max(AIR_LEN_MIN, seconds));
  }

  /** A hit: the gate opens (again) and falls over AIR LEN. */
  trigger(): void {
    const left = Math.max(1, Math.round(this.len * this.sr));
    this.gate = 1;
    this.gateLeft = left;
    this.gateFall = Math.pow(GATE_FALL, 1 / left);
  }

  reset(): void {
    this.hp1.reset(); this.hp2.reset(); this.shelf.reset(); this.lp.reset();
    this.line.fill(0);
    for (const c of this.combs) c.fill(0);
    for (const a of this.aps) a.fill(0);
    this.combStore.fill(0);
    this.gate = 0;
    this.gateLeft = 0;
  }

  /** Mono in (x), mono wet out (y); may be the same array. */
  process(x: Float32Array, y: Float32Array, n: number): void {
    const line = this.line, len = line.length, early = this.early, pre = this.pre;
    for (let i = 0; i < n; i++) {
      // Pre-EQ.
      let v = x[i];
      if (this.useHp) {
        this.hp1.process(v);
        this.hp2.process(this.hp1.high);
        v = this.hp2.high;
      }
      if (this.shelfOn) {
        const a = this.shelfA;
        this.shelf.process(v);
        v += SHELF_K * (a - 1) * this.shelf.band + (a * a - 1) * this.shelf.low;
      }
      this.lp.process(v);
      line[this.write] = this.lp.low;
      // Early reflections.
      let er = 0;
      for (let k = 0; k < early.length; k++) {
        let rp = this.write - early[k];
        if (rp < 0) rp += len;
        er += line[rp] * EARLY_GAIN[k];
      }
      // The tail: parallel damped combs fed the pre-delayed input, then four allpasses.
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
        const u = d - ALLPASS_G * tail;
        let w = tail + ALLPASS_G * u;
        if (w < 1e-15 && w > -1e-15) w = 0;
        a[at] = w;
        this.apAt[k] = at + 1 === a.length ? 0 : at + 1;
        tail = u;
      }
      if (++this.write === len) this.write = 0;
      // The gate: a gradual fall over AIR LEN, then a quick tail-off.
      if (this.gateLeft > 0) {
        this.gate *= this.gateFall;
        this.gateLeft--;
      } else if (this.gate !== 0) {
        this.gate *= this.gateTail;
        if (this.gate < 1e-4) this.gate = 0;
      }
      y[i] = (er + tail * TAIL_GAIN) * this.gate;
    }
  }
}
