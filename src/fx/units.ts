/**
 * The FX buses' effect units (see buses.ts). Each one writes its wet signal for a block into
 * the given buffers (overwriting them); the bus applies VOLUME, fades and skipping. TYPE
 * picks the unit's mode by name; A / B are its two controls. Allocation-free after
 * construction: every buffer is sized for the longest mode the unit will be asked for.
 */
import { Svf } from '../instruments/dsp';
import { Smoother } from '../engine/smoother';
import { DELAY_MODES, DRIVE_MODES, FX_DELAY_TIMES, MOD_MODES, VERB_MODES } from './buses';

export interface FxUnit {
  setMode(name: string): void;
  set(id: string, v: number): void;
  setTempo(bpm: number): void;
  /** Silence its memory (it restarts clean after being skipped or switching TYPE). */
  reset(): void;
  render(inL: Float32Array, inR: Float32Array, wetL: Float32Array, wetR: Float32Array, n: number): void;
}

const TAU = 2 * Math.PI;
const flush = (x: number) => (x > 1e-15 || x < -1e-15 ? x : 0);
/** The most samples a unit renders at once (FxBus's largest block). */
export const FX_BLOCK = 256;

/** Linear-interpolated read `delay` samples behind `write` in a circular buffer. */
function tap(buf: Float32Array, write: number, delay: number): number {
  const len = buf.length;
  let rp = write - delay;
  if (rp < 0) rp += len; // callers keep delay below len
  // A tiny negative position plus len can round to len itself: wrap it back.
  if (rp >= len) rp -= len;
  const i0 = Math.floor(rp);
  const i1 = i0 + 1 === len ? 0 : i0 + 1;
  const f = rp - i0;
  return buf[i0] + (buf[i1] - buf[i0]) * f;
}

/** One-pole low-pass coefficient for a corner frequency. */
const onePole = (hz: number, sr: number) => 1 - Math.exp((-TAU * Math.min(hz, sr * 0.45)) / sr);

// ------------------------------------------------------------------------------- MOD

const PHASER_STAGES = 6;
const MOD_UPDATE = 16;

/**
 * MOD: CHORUS (one swept delay a side), ENSEMBLE (three per side plus a fast shimmer, the
 * string-machine sound), FLANGER (a very short swept delay fed back on itself), PHASER (six
 * swept allpasses fed back). Its notches and movement come from the wet return summing with
 * the dry track. RATE = LFO speed (Hz), DEPTH = how far it sweeps.
 */
export class ModFx implements FxUnit {
  private readonly sr: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private write = 0;
  private mode = 0; // 0 chorus, 1 ensemble, 2 flanger, 3 phaser
  private rate = 0.5;
  private depth = 0.5;
  private phase = 0;
  private fbL = 0; private fbR = 0;
  // Phaser: allpass states per stage (x1, y1), coefficient, update counter.
  private readonly apXL = new Float64Array(PHASER_STAGES);
  private readonly apYL = new Float64Array(PHASER_STAGES);
  private readonly apXR = new Float64Array(PHASER_STAGES);
  private readonly apYR = new Float64Array(PHASER_STAGES);
  private aL = 0; private aR = 0; private counter = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.bufL = new Float32Array(Math.ceil(0.04 * sampleRate));
    this.bufR = new Float32Array(Math.ceil(0.04 * sampleRate));
  }

  setMode(name: string): void {
    this.mode = Math.max(0, MOD_MODES.indexOf(name as (typeof MOD_MODES)[number]));
  }

  set(id: string, v: number): void {
    if (id === 'mod_rate') this.rate = v;
    else if (id === 'mod_depth') this.depth = v;
  }

  setTempo(): void { /* free-running */ }

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.fbL = this.fbR = 0;
    this.apXL.fill(0); this.apYL.fill(0); this.apXR.fill(0); this.apYR.fill(0);
    this.counter = 0;
  }

  render(inL: Float32Array, inR: Float32Array, wetL: Float32Array, wetR: Float32Array, n: number): void {
    const ms = this.sr / 1000;
    const inc = this.rate / this.sr;
    const d = this.depth;
    const len = this.bufL.length;
    for (let i = 0; i < n; i++) {
      this.phase += inc;
      if (this.phase >= 1) this.phase -= 1;
      const p = this.phase;
      let yl = 0;
      let yr = 0;
      switch (this.mode) {
        case 0: { // CHORUS
          this.bufL[this.write] = inL[i];
          this.bufR[this.write] = inR[i];
          yl = tap(this.bufL, this.write, (12 + 7 * d * (0.5 + 0.5 * Math.sin(TAU * p))) * ms);
          yr = tap(this.bufR, this.write, (12 + 7 * d * (0.5 + 0.5 * Math.sin(TAU * (p + 0.4)))) * ms);
          break;
        }
        case 1: { // ENSEMBLE: three voices a side, 120 degrees apart, plus a fast shimmer
          this.bufL[this.write] = inL[i];
          this.bufR[this.write] = inR[i];
          const vib = 0.35 * d * Math.sin(TAU * p * 7) * ms;
          for (let k = 0; k < 3; k++) {
            const o = k / 3;
            yl += tap(this.bufL, this.write, (9 + 3 * d * (0.5 + 0.5 * Math.sin(TAU * (p + o)))) * ms + vib);
            yr += tap(this.bufR, this.write, (9 + 3 * d * (0.5 + 0.5 * Math.sin(TAU * (p + o + 1 / 6)))) * ms - vib);
          }
          yl *= 0.47;
          yr *= 0.47;
          break;
        }
        case 2: { // FLANGER: 0.25 - 5 ms, fed back
          this.bufL[this.write] = inL[i] + this.fbL * 0.65;
          this.bufR[this.write] = inR[i] + this.fbR * 0.65;
          yl = tap(this.bufL, this.write, (0.25 + 4.75 * d * (0.5 + 0.5 * Math.sin(TAU * p))) * ms);
          yr = tap(this.bufR, this.write, (0.25 + 4.75 * d * (0.5 + 0.5 * Math.sin(TAU * (p + 0.25)))) * ms);
          this.fbL = flush(yl);
          this.fbR = flush(yr);
          break;
        }
        default: { // PHASER: six first-order allpasses swept 150 Hz ... (DEPTH) octaves up
          if (this.counter-- <= 0) {
            this.counter = MOD_UPDATE;
            const coef = (hz: number) => { const tn = Math.tan((Math.PI * Math.min(hz, this.sr * 0.45)) / this.sr); return (tn - 1) / (tn + 1); };
            this.aL = coef(150 * Math.pow(2, d * 5 * (0.5 + 0.5 * Math.sin(TAU * p))));
            this.aR = coef(150 * Math.pow(2, d * 5 * (0.5 + 0.5 * Math.sin(TAU * (p + 0.25)))));
          }
          let xl = inL[i] + this.fbL * 0.5;
          let xr = inR[i] + this.fbR * 0.5;
          for (let k = 0; k < PHASER_STAGES; k++) {
            const ol = this.aL * xl + this.apXL[k] - this.aL * this.apYL[k];
            this.apXL[k] = xl; this.apYL[k] = flush(ol); xl = ol;
            const or = this.aR * xr + this.apXR[k] - this.aR * this.apYR[k];
            this.apXR[k] = xr; this.apYR[k] = flush(or); xr = or;
          }
          this.fbL = flush(xl);
          this.fbR = flush(xr);
          yl = xl;
          yr = xr;
        }
      }
      if (++this.write === len) this.write = 0;
      wetL[i] = yl;
      wetR[i] = yr;
    }
  }
}

// ----------------------------------------------------------------------------- DELAY

/** Allpass diffuser (REVERSE's smear, the reverbs). */
class Allpass {
  private readonly buf: Float32Array;
  private i = 0;
  constructor(len: number) { this.buf = new Float32Array(Math.max(1, len)); }
  reset(): void { this.buf.fill(0); this.i = 0; }
  process(x: number, g: number): number {
    const d = this.buf[this.i];
    const y = d - g * x;
    this.buf[this.i] = flush(x + g * y);
    if (++this.i >= this.buf.length) this.i = 0;
    return y;
  }

  /** process() over a block, in place (state in locals, the same arithmetic). */
  block(v: Float64Array, n: number, g: number): void {
    const buf = this.buf, len = buf.length;
    let i = this.i;
    for (let j = 0; j < n; j++) {
      const x = v[j];
      const y = buf[i] - g * x;
      buf[i] = flush(x + g * y);
      if (++i >= len) i = 0;
      v[j] = y;
    }
    this.i = i;
  }
}

/** REVERSE smear diffusers (samples at 48 kHz). */
const SMEAR = [225, 341, 441, 556, 1100, 1700];

/**
 * DELAY, tempo-synced (RATE) with FEEDBACK (above 1 runs away into tanh, gracefully):
 *  STEREO     a repeat on each side, slightly darkened.
 *  PING-PONG  repeats bounce left / right.
 *  TAPE       warm repeats: band-limited, saturated, with wow and flutter.
 *  DUB TAPE   TAPE pushed: darker, thinner, dirtier, more wow (dub throws).
 *  SWEEP      each repeat through a resonant band-pass that sweeps over two bars.
 *  REVERSE    each RATE-long slice plays backwards (hits swell towards where they land);
 *             FEEDBACK = reverse echoes of the echoes, lightly smeared.
 *  SLAPBACK   one quick, bright, centred repeat (FEEDBACK only adds a little more).
 */
export class DelayFx implements FxUnit {
  private readonly sr: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private write = 0;
  private mode = 0;
  private bpm = 120;
  private steps = 2;
  private fdbk = 0.4;
  private readonly time: Smoother;
  private lpL = 0; private lpR = 0; private hpL = 0; private hpR = 0;
  private lfo = 0;
  private readonly bpL = new Svf();
  private readonly bpR = new Svf();
  private counter = 0;
  // REVERSE
  private cycle = 0;
  private wetL = 0; private wetR = 0;
  private readonly smL: Allpass[];
  private readonly smR: Allpass[];

  /** reverse: this unit may be asked for REVERSE (two slices of up to a bar: a longer buffer). */
  constructor(sampleRate: number, reverse: boolean) {
    this.sr = sampleRate;
    const seconds = reverse ? 8.5 : 6.2;
    this.bufL = new Float32Array(Math.ceil(seconds * sampleRate));
    this.bufR = new Float32Array(Math.ceil(seconds * sampleRate));
    this.time = new Smoother(this.target(), 0.12, sampleRate);
    const scale = sampleRate / 48000;
    this.smL = reverse ? SMEAR.map((d) => new Allpass(Math.round(d * scale))) : [];
    this.smR = reverse ? SMEAR.map((d) => new Allpass(Math.round(d * scale * 1.07))) : [];
  }

  setMode(name: string): void {
    this.mode = Math.max(0, DELAY_MODES.indexOf(name as (typeof DELAY_MODES)[number]));
  }

  set(id: string, v: number): void {
    if (id === 'dly_rate') { this.steps = FX_DELAY_TIMES[Math.round(v)]?.steps ?? 2; this.time.setTarget(this.target()); }
    else if (id === 'dly_fdbk') this.fdbk = v;
  }

  setTempo(bpm: number): void {
    this.bpm = bpm;
    this.time.setTarget(this.target());
  }

  /** Jump to the target time (project load). */
  settle(): void {
    this.time.setImmediate(this.target());
  }

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.lpL = this.lpR = this.hpL = this.hpR = 0;
    this.bpL.reset();
    this.bpR.reset();
    this.wetL = this.wetR = 0;
    for (const a of this.smL) a.reset();
    for (const a of this.smR) a.reset();
  }

  private target(): number {
    return (this.steps * 60 * this.sr) / (this.bpm * 4);
  }

  render(inL: Float32Array, inR: Float32Array, wetL: Float32Array, wetR: Float32Array, n: number): void {
    if (this.mode === 5) { this.renderReverse(inL, inR, wetL, wetR, n); return; }
    const sr = this.sr;
    const len = this.bufL.length;
    const m = this.mode;
    // Per mode: loop low-pass, loop high-pass, saturation drive, wow / flutter depth.
    const lpHz = m === 2 ? 3500 : m === 3 ? 1800 : m === 6 ? 7000 : 6000;
    const hpHz = m === 2 ? 100 : m === 3 ? 300 : 40;
    const lp = onePole(lpHz, sr);
    const hp = onePole(hpHz, sr);
    const sat = m === 3 ? 2 : m === 2 ? 1.3 : 1;
    const wow = m === 3 ? 0.004 : m === 2 ? 0.0025 : 0;
    const fb = m === 6 ? this.fdbk * 0.3 : this.fdbk;
    // SWEEP: band-pass centre over two bars.
    const lfoInc = (this.bpm / 60 / 8) / sr;
    for (let i = 0; i < n; i++) {
      this.lfo += m === 4 ? lfoInc : m === 2 || m === 3 ? 0.6 / sr : 0;
      if (this.lfo >= 1) this.lfo -= 1;
      let d = this.time.next();
      if (wow > 0) d *= 1 + wow * Math.sin(TAU * this.lfo) + wow * 0.2 * Math.sin(TAU * this.lfo * 11.7);
      d = Math.min(Math.max(d, 2), len - 2);
      let yl = tap(this.bufL, this.write, d);
      let yr = tap(this.bufR, this.write, d);
      // Loop tone: low-pass then high-pass (one-pole each).
      this.lpL += (yl - this.lpL) * lp; this.lpR += (yr - this.lpR) * lp;
      this.hpL += (this.lpL - this.hpL) * hp; this.hpR += (this.lpR - this.hpR) * hp;
      let fl = this.lpL - this.hpL;
      let fr = this.lpR - this.hpR;
      if (m === 4) {
        if (this.counter-- <= 0) {
          this.counter = 16;
          const hz = 400 * Math.pow(2, 3.3 * (0.5 + 0.5 * Math.sin(TAU * this.lfo)));
          this.bpL.setup(hz, 0.75, sr);
          this.bpR.setup(hz * 1.12, 0.75, sr);
        }
        this.bpL.process(fl); this.bpR.process(fr);
        fl = this.bpL.band * 1.6; fr = this.bpR.band * 1.6;
        yl = fl; yr = fr;
      }
      if (sat > 1) { fl = Math.tanh(fl * sat) / sat; fr = Math.tanh(fr * sat) / sat; }
      const sl = flush(Math.tanh(fl * fb));
      const srr = flush(Math.tanh(fr * fb));
      if (m === 1) {
        // PING-PONG: the input enters on the left, each side feeds the other.
        this.bufL[this.write] = (inL[i] + inR[i]) * 0.5 + srr;
        this.bufR[this.write] = sl;
      } else if (m === 6) {
        const mono = (inL[i] + inR[i]) * 0.5;
        this.bufL[this.write] = mono + sl;
        this.bufR[this.write] = mono + srr;
      } else {
        this.bufL[this.write] = inL[i] + sl;
        this.bufR[this.write] = inR[i] + srr;
      }
      if (++this.write === len) this.write = 0;
      if (m === 2 || m === 3) { yl = this.lpL - this.hpL; yr = this.lpR - this.hpR; }
      wetL[i] = yl;
      wetR[i] = yr;
    }
    this.lpL = flush(this.lpL); this.lpR = flush(this.lpR); this.hpL = flush(this.hpL); this.hpR = flush(this.hpR);
  }

  /** REVERSE: record (with feedback), read each slice backwards through two sin^2 windows. */
  private renderReverse(inL: Float32Array, inR: Float32Array, wetL: Float32Array, wetR: Float32Array, n: number): void {
    const size = this.bufL.length;
    const len = Math.max(256, Math.min(Math.floor(size / 2) - 2, Math.round(this.time.value)));
    const g = 0.57;
    for (let i = 0; i < n; i++) {
      this.time.next();
      const fb = this.fdbk;
      this.bufL[this.write] = inL[i] + (fb > 0 ? Math.tanh(this.wetL * fb) : 0);
      this.bufR[this.write] = inR[i] + (fb > 0 ? Math.tanh(this.wetR * fb) : 0);
      if (this.cycle >= len) this.cycle -= len;
      let yl = 0;
      let yr = 0;
      for (let k = 0; k < 2; k++) {
        let ph = this.cycle / len + k * 0.5;
        if (ph >= 1) ph -= 1;
        const w = Math.sin(Math.PI * ph);
        const win = w * w;
        const d = 2 * len * ph + 1;
        yl += tap(this.bufL, this.write, d) * win;
        yr += tap(this.bufR, this.write, d) * win;
      }
      let dl = yl;
      let dr = yr;
      for (let a = 0; a < this.smL.length; a++) {
        dl = this.smL[a].process(dl, g);
        dr = this.smR[a].process(dr, g);
      }
      yl += (dl - yl) * 0.4;
      yr += (dr - yr) * 0.4;
      this.wetL = flush(yl);
      this.wetR = flush(yr);
      if (++this.write >= size) this.write = 0;
      this.cycle++;
      wetL[i] = yl;
      wetR[i] = yr;
    }
  }
}

// ------------------------------------------------------------------------------ VERB

/** Freeverb comb whose length follows SIZE (fractional, smoothed). */
class Comb {
  private readonly buf: Float32Array;
  private i = 0;
  private store = 0;
  constructor(len: number) { this.buf = new Float32Array(len); }
  reset(): void { this.buf.fill(0); this.store = 0; }
  process(x: number, delay: number, feedback: number, damp: number): number {
    const y = tap(this.buf, this.i, delay);
    this.store = flush(y * (1 - damp) + this.store * damp);
    this.buf[this.i] = x + this.store * feedback;
    if (++this.i === this.buf.length) this.i = 0;
    return y;
  }

  /** The same at a whole-sample delay (SIZE at rest: no interpolation). */
  processInt(x: number, delay: number, feedback: number, damp: number): number {
    let rp = this.i - delay;
    if (rp < 0) rp += this.buf.length;
    const y = this.buf[rp];
    this.store = flush(y * (1 - damp) + this.store * damp);
    this.buf[this.i] = x + this.store * feedback;
    if (++this.i === this.buf.length) this.i = 0;
    return y;
  }

  /** processInt() over a block: adds each output to acc[j] (state in locals). */
  blockInt(x: Float64Array, acc: Float64Array, n: number, delay: number, feedback: number, damp: number): void {
    const buf = this.buf, len = buf.length;
    let i = this.i, store = this.store;
    for (let j = 0; j < n; j++) {
      let rp = i - delay;
      if (rp < 0) rp += len;
      const y = buf[rp];
      store = flush(y * (1 - damp) + store * damp);
      buf[i] = x[j] + store * feedback;
      if (++i === len) i = 0;
      acc[j] += y;
    }
    this.i = i;
    this.store = store;
  }
}

// Freeverb tunings (samples at 44.1 kHz), and the most SIZE can stretch them.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;
const MAX_STRETCH = 1.4;
/** PLATE input diffusers (samples at 29.8 kHz, Dattorro). */
const PLATE_DIFFUSE = [142, 107, 379, 277];
/** EARLY reflections: tap positions (share of SIZE's span) and stereo offsets. */
const EARLY_TAPS = [0.043, 0.097, 0.131, 0.197, 0.263, 0.331, 0.419, 0.523, 0.661, 0.787, 0.883, 1];
/** SPRING dispersion stages (samples at 48 kHz). */
const SPRING_DISPERSE = [37, 53, 71, 89, 113, 131];
const SHIMMER_WINDOW = 2048;

/**
 * VERB. SIZE = how big the space is (longer delays, more pre-delay), LENGTH = how long it
 * rings.
 *  ROOM     a small, damped room.
 *  HALL     a big hall with pre-delay.
 *  PLATE    bright and dense from the first moment (diffused input, little damping).
 *  EARLY    early reflections only: a sense of space with no tail (SIZE = the span,
 *           LENGTH = how slowly the reflections die away).
 *  SHIMMER  a hall whose tail is fed back an octave up: rising, glassy halos.
 *  SPRING   a spring tank: dispersed, metallic "boing" in a feedback loop.
 */
export class VerbFx implements FxUnit {
  private readonly sr: number;
  private readonly combsL: Comb[] = [];
  private readonly combsR: Comb[] = [];
  private readonly apL: Allpass[] = [];
  private readonly apR: Allpass[] = [];
  private readonly diffL: Allpass[] = [];
  private readonly diffR: Allpass[] = [];
  private readonly pre: Float32Array;
  private preWrite = 0;
  private readonly stretch: Smoother;
  /** renderBlock()'s block: the diffused inputs and the left / right sums. */
  private readonly bxL = new Float64Array(FX_BLOCK);
  private readonly bxR = new Float64Array(FX_BLOCK);
  private readonly bl = new Float64Array(FX_BLOCK);
  private readonly br = new Float64Array(FX_BLOCK);
  private mode = 0;
  private size = 0.5;
  private length = 0.5;
  // EARLY: its own tap line.
  private readonly early: Float32Array;
  private earlyWrite = 0;
  // SHIMMER: octave-up pitch shifter on the tail.
  private readonly shimBuf: Float32Array;
  private shimWrite = 0;
  private shimPhase = 0;
  private shimL = 0; private shimR = 0;
  // SPRING
  private readonly springL: Float32Array;
  private readonly springR: Float32Array;
  private springWrite = 0;
  private readonly dispL: Allpass[];
  private readonly dispR: Allpass[];
  private springLpL = 0; private springLpR = 0;
  /** Comb delays in whole samples at the SIZE being settled on. */
  private readonly intL = new Int32Array(COMBS.length);
  private readonly intR = new Int32Array(COMBS.length);
  /** Every allpass above (reset without allocating). */
  private readonly allpasses: Allpass[];

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    const scale = sampleRate / 44100;
    for (const c of COMBS) {
      this.combsL.push(new Comb(Math.ceil(c * scale * MAX_STRETCH) + 4));
      this.combsR.push(new Comb(Math.ceil((c + SPREAD) * scale * MAX_STRETCH) + 4));
    }
    for (const a of ALLPASSES) {
      this.apL.push(new Allpass(Math.round(a * scale)));
      this.apR.push(new Allpass(Math.round((a + SPREAD) * scale)));
    }
    const ps = sampleRate / 29761;
    for (const d of PLATE_DIFFUSE) {
      this.diffL.push(new Allpass(Math.round(d * ps)));
      this.diffR.push(new Allpass(Math.round(d * ps * 1.05)));
    }
    this.pre = new Float32Array(Math.ceil(0.06 * sampleRate));
    this.early = new Float32Array(Math.ceil(0.1 * sampleRate));
    this.shimBuf = new Float32Array(SHIMMER_WINDOW * 2);
    this.springL = new Float32Array(Math.ceil(0.09 * sampleRate));
    this.springR = new Float32Array(Math.ceil(0.09 * sampleRate));
    const s48 = sampleRate / 48000;
    this.dispL = SPRING_DISPERSE.map((d) => new Allpass(Math.round(d * s48)));
    this.dispR = SPRING_DISPERSE.map((d) => new Allpass(Math.round(d * s48 * 1.13)));
    this.stretch = new Smoother(1, 0.08, sampleRate);
    this.allpasses = [...this.apL, ...this.apR, ...this.diffL, ...this.diffR, ...this.dispL, ...this.dispR];
  }

  setMode(name: string): void {
    this.mode = Math.max(0, VERB_MODES.indexOf(name as (typeof VERB_MODES)[number]));
    this.stretch.setImmediate(this.stretchTarget());
  }

  set(id: string, v: number): void {
    if (id === 'vrb_size') { this.size = v; this.stretch.setTarget(this.stretchTarget()); }
    else if (id === 'vrb_len') this.length = v;
  }

  setTempo(): void { /* not tempo-synced */ }

  private stretchTarget(): number {
    const s = this.size;
    switch (this.mode) {
      case 0: return 0.3 + 0.45 * s;
      case 1: case 4: return 0.75 + 0.6 * s;
      case 2: return 0.45 + 0.5 * s;
      default: return 1;
    }
  }

  reset(): void {
    for (const c of this.combsL) c.reset();
    for (const c of this.combsR) c.reset();
    for (const a of this.allpasses) a.reset();
    this.pre.fill(0);
    this.early.fill(0);
    this.shimBuf.fill(0);
    this.shimL = this.shimR = 0;
    this.springL.fill(0);
    this.springR.fill(0);
    this.springLpL = this.springLpR = 0;
  }

  render(inL: Float32Array, inR: Float32Array, wetL: Float32Array, wetR: Float32Array, n: number): void {
    if (this.mode === 3) { this.renderEarly(inL, inR, wetL, wetR, n); return; }
    if (this.mode === 5) { this.renderSpring(inL, inR, wetL, wetR, n); return; }
    const m = this.mode;
    const sr = this.sr;
    const scale = sr / 44100;
    const len = this.length;
    const feedback = m === 0 ? 0.55 + 0.35 * len : m === 2 ? 0.75 + 0.23 * len : 0.78 + 0.2 * len;
    const damp = m === 0 ? 0.45 : m === 2 ? 0.08 : 0.3;
    const preDelay = Math.round((m === 0 ? 2 : m === 2 ? 1 : 8 + 40 * this.size) * sr / 1000);
    const shimmer = m === 4 ? 0.3 + 0.35 * len : 0;
    const preLen = this.pre.length;
    const stEnd = this.stretchTarget();
    for (let k = 0; k < 8; k++) {
      this.intL[k] = Math.round(COMBS[k] * scale * stEnd);
      this.intR[k] = Math.round((COMBS[k] + SPREAD) * scale * stEnd);
    }
    if (shimmer === 0 && this.stretch.settled && this.stretch.value === stEnd) {
      this.renderBlock(inL, inR, wetL, wetR, n, feedback, damp, preDelay);
      return;
    }
    for (let i = 0; i < n; i++) {
      const st = this.stretch.next();
      this.pre[this.preWrite] = (inL[i] + inR[i]) * 0.015;
      let rp = this.preWrite - Math.min(preDelay, preLen - 1);
      if (rp < 0) rp += preLen;
      let xl = this.pre[rp];
      if (++this.preWrite === preLen) this.preWrite = 0;
      let xr = xl;
      if (m === 2) {
        for (let k = 0; k < this.diffL.length; k++) {
          xl = this.diffL[k].process(xl, k < 2 ? 0.75 : 0.625);
          xr = this.diffR[k].process(xr, k < 2 ? 0.75 : 0.625);
        }
      }
      if (shimmer > 0) { xl += this.shimL * shimmer * 0.015; xr += this.shimR * shimmer * 0.015; }
      let l = 0;
      let r = 0;
      if (st === stEnd) {
        // SIZE at rest: whole-sample delays (cheaper; moving, they glide fractionally).
        for (let k = 0; k < 8; k++) {
          l += this.combsL[k].processInt(xl, this.intL[k], feedback, damp);
          r += this.combsR[k].processInt(xr, this.intR[k], feedback, damp);
        }
      } else {
        for (let k = 0; k < 8; k++) {
          l += this.combsL[k].process(xl, COMBS[k] * scale * st, feedback, damp);
          r += this.combsR[k].process(xr, (COMBS[k] + SPREAD) * scale * st, feedback, damp);
        }
      }
      for (let k = 0; k < 4; k++) {
        l = this.apL[k].process(l, 0.5);
        r = this.apR[k].process(r, 0.5);
      }
      if (shimmer > 0) this.shimmerStep(l, r);
      wetL[i] = l * 3;
      wetR[i] = r * 3;
    }
  }

  /**
   * SIZE at rest, no SHIMMER (which feeds each sample's output back): the same as the loop
   * above, but each diffuser, comb and allpass runs over the whole block in turn (the same
   * sums in the same order).
   */
  private renderBlock(inL: Float32Array, inR: Float32Array, wetL: Float32Array, wetR: Float32Array, n: number, feedback: number, damp: number, preDelay: number): void {
    const preLen = this.pre.length;
    const xl = this.bxL, xr = this.bxR, l = this.bl, r = this.br;
    for (let i = 0; i < n; i++) {
      this.pre[this.preWrite] = (inL[i] + inR[i]) * 0.015;
      let rp = this.preWrite - Math.min(preDelay, preLen - 1);
      if (rp < 0) rp += preLen;
      xl[i] = this.pre[rp];
      xr[i] = xl[i];
      if (++this.preWrite === preLen) this.preWrite = 0;
      l[i] = 0;
      r[i] = 0;
    }
    if (this.mode === 2) {
      for (let k = 0; k < this.diffL.length; k++) {
        this.diffL[k].block(xl, n, k < 2 ? 0.75 : 0.625);
        this.diffR[k].block(xr, n, k < 2 ? 0.75 : 0.625);
      }
    }
    for (let k = 0; k < 8; k++) {
      this.combsL[k].blockInt(xl, l, n, this.intL[k], feedback, damp);
      this.combsR[k].blockInt(xr, r, n, this.intR[k], feedback, damp);
    }
    for (let k = 0; k < 4; k++) {
      this.apL[k].block(l, n, 0.5);
      this.apR[k].block(r, n, 0.5);
    }
    for (let i = 0; i < n; i++) {
      wetL[i] = l[i] * 3;
      wetR[i] = r[i] * 3;
    }
  }

  /** Octave-up shifter: two read heads sweep a window at twice the speed, crossfaded. */
  private shimmerStep(l: number, r: number): void {
    const buf = this.shimBuf;
    const W = SHIMMER_WINDOW;
    buf[this.shimWrite] = (l + r) * 0.5;
    this.shimPhase += 1 / W;
    if (this.shimPhase >= 1) this.shimPhase -= 1;
    let y = 0;
    for (let k = 0; k < 2; k++) {
      let ph = this.shimPhase + k * 0.5;
      if (ph >= 1) ph -= 1;
      const w = Math.sin(Math.PI * ph);
      y += tap(buf, this.shimWrite, W * (1 - ph) + 1) * w * w;
    }
    if (++this.shimWrite === buf.length) this.shimWrite = 0;
    this.shimL = flush(y);
    this.shimR = flush(y);
  }

  private renderEarly(inL: Float32Array, inR: Float32Array, wetL: Float32Array, wetR: Float32Array, n: number): void {
    const span = (10 + 80 * this.size) * this.sr / 1000;
    const steep = 1 + 3 * (1 - this.length);
    const len = this.early.length;
    for (let i = 0; i < n; i++) {
      this.early[this.earlyWrite] = (inL[i] + inR[i]) * 0.5;
      let l = 0;
      let r = 0;
      for (let k = 0; k < EARLY_TAPS.length; k++) {
        const g = Math.pow(1 - k / EARLY_TAPS.length, steep) * (k % 2 ? -0.55 : 0.6);
        l += tap(this.early, this.earlyWrite, Math.min(len - 2, EARLY_TAPS[k] * span + 1)) * g;
        r += tap(this.early, this.earlyWrite, Math.min(len - 2, EARLY_TAPS[(k + 3) % EARLY_TAPS.length] * span * 0.93 + 1)) * g;
      }
      if (++this.earlyWrite === len) this.earlyWrite = 0;
      wetL[i] = l;
      wetR[i] = r;
    }
  }

  private renderSpring(inL: Float32Array, inR: Float32Array, wetL: Float32Array, wetR: Float32Array, n: number): void {
    const len = this.springL.length;
    const d = (30 + 50 * this.size) * this.sr / 1000;
    const fb = 0.5 + 0.45 * this.length;
    const lp = onePole(4500, this.sr);
    for (let i = 0; i < n; i++) {
      let l = tap(this.springL, this.springWrite, Math.min(len - 2, d));
      let r = tap(this.springR, this.springWrite, Math.min(len - 2, d * 0.87));
      for (let k = 0; k < this.dispL.length; k++) {
        l = this.dispL[k].process(l, 0.65);
        r = this.dispR[k].process(r, 0.65);
      }
      this.springLpL = flush(this.springLpL + (l - this.springLpL) * lp);
      this.springLpR = flush(this.springLpR + (r - this.springLpR) * lp);
      const x = (inL[i] + inR[i]) * 0.3;
      this.springL[this.springWrite] = x + Math.tanh(this.springLpL * fb);
      this.springR[this.springWrite] = x + Math.tanh(this.springLpR * fb);
      if (++this.springWrite === len) this.springWrite = 0;
      wetL[i] = this.springLpL;
      wetR[i] = this.springLpR;
    }
  }
}

// ----------------------------------------------------------------------------- DIST

/**
 * DIST (in parallel: VOLUME = how much of the distorted signal returns). DRIVE = how hard,
 * TONE = a low-pass after it.
 *  TUBE  warm, asymmetric (even harmonics).
 *  FUZZ  hard and square.
 *  BIT   bit and sample-rate reduction.
 */
export class DriveFx implements FxUnit {
  private readonly sr: number;
  private mode = 0;
  private drive = 0.4;
  private lp = 0.5;
  private lpL = 0; private lpR = 0;
  private dcXL = 0; private dcYL = 0; private dcXR = 0; private dcYR = 0;
  private hold = 0; private heldL = 0; private heldR = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
  }

  setMode(name: string): void {
    this.mode = Math.max(0, DRIVE_MODES.indexOf(name as (typeof DRIVE_MODES)[number]));
  }

  set(id: string, v: number): void {
    if (id === 'drv_drive') this.drive = v;
    else if (id === 'drv_tone') this.lp = onePole(v, this.sr);
  }

  setTempo(): void { /* not tempo-synced */ }

  reset(): void {
    this.lpL = this.lpR = 0;
    this.dcXL = this.dcYL = this.dcXR = this.dcYR = 0;
    this.hold = 0;
  }

  render(inL: Float32Array, inR: Float32Array, wetL: Float32Array, wetR: Float32Array, n: number): void {
    const d = this.drive;
    const dc = 1 - (TAU * 10) / this.sr;
    const g = this.mode === 1 ? 1 + 200 * d * d : 1 + 30 * d * d;
    const bias = 0.2;
    const tb = Math.tanh(bias);
    const levels = Math.pow(2, 16 - 13 * d);
    const holdN = 1 + Math.floor(d * d * 30);
    for (let i = 0; i < n; i++) {
      let l = inL[i];
      let r = inR[i];
      if (this.mode === 0) {
        l = (Math.tanh(l * g + bias) - tb) * 0.8;
        r = (Math.tanh(r * g + bias) - tb) * 0.8;
        // Remove the bias's DC.
        const yl = l - this.dcXL + dc * this.dcYL; this.dcXL = l; this.dcYL = flush(yl); l = yl;
        const yr = r - this.dcXR + dc * this.dcYR; this.dcXR = r; this.dcYR = flush(yr); r = yr;
      } else if (this.mode === 1) {
        l = Math.max(-1, Math.min(1, Math.tanh(l * g) * 1.5)) * 0.6;
        r = Math.max(-1, Math.min(1, Math.tanh(r * g) * 1.5)) * 0.6;
      } else {
        if (this.hold <= 0) {
          this.heldL = Math.round(l * levels) / levels;
          this.heldR = Math.round(r * levels) / levels;
          this.hold = holdN;
        }
        this.hold--;
        l = this.heldL;
        r = this.heldR;
      }
      this.lpL += (l - this.lpL) * this.lp;
      this.lpR += (r - this.lpR) * this.lp;
      wetL[i] = this.lpL;
      wetR[i] = this.lpR;
    }
    this.lpL = flush(this.lpL);
    this.lpR = flush(this.lpR);
  }
}
