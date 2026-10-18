import { djCutoff, type ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';
import { Svf } from '../instruments/dsp';
import { COMP_PARAMS, Compressor } from './Compressor';

/** REVERSE slice lengths, in 16th steps. */
export const REVERSE_LENGTHS = [
  { name: '1/16', steps: 1 }, { name: '1/8', steps: 2 }, { name: '1/4', steps: 4 }, { name: '1/2', steps: 8 }, { name: '1 BAR', steps: 16 },
] as const;

/**
 * FX 1, the drum bus: tracks routed here pass THROUGH it (nothing is added alongside), so
 * the filter really darkens (or thins) them and the reverse swells sit under the drums themselves.
 * At its defaults it is transparent. Knob order = panel order (top row, then bottom row):
 * two modules per effect.
 */
export const DRUM_BUS_PARAMS: readonly ParamSpec[] = [
  { id: 'rev_mix', name: 'REVERSE', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'rev_len', name: 'REV LEN', min: 0, max: REVERSE_LENGTHS.length - 1, defaultValue: 2, unit: '', curve: 'linear', options: REVERSE_LENGTHS.map((g) => g.name) },
  { id: 'dst_drive', name: 'DRIVE', min: 0, max: 60, defaultValue: 0, unit: 'DB', curve: 'linear', decimals: 0 },
  { id: 'dst_tone', name: 'DST TONE', min: 200, max: 20000, defaultValue: 20000, unit: 'HZ', curve: 'exp', decimals: 0 },
  // FILTER: one knob, left of centre a low-pass, right a high-pass, centre off (DJ style).
  { id: 'flt', name: 'FILTER', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear', display: 'dj' },
  { id: 'lp_reso', name: 'FLT RESO', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'rev_smear', name: 'SMEAR', min: 0, max: 1, defaultValue: 0.4, unit: '', curve: 'linear' },
  { id: 'rev_fdbk', name: 'REV FDBK', min: 0, max: 1.1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'dst_crush', name: 'CRUSH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'dst_level', name: 'DST LEVEL', min: 0, max: 2, defaultValue: 1, unit: 'X', curve: 'linear' },
  { id: 'lp_env', name: 'FLT ENV', min: -1, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'lp_release', name: 'ENV REL', min: 0.005, max: 2, defaultValue: 0.15, unit: 'S', curve: 'exp', decimals: 3 },
  // COMP (series, for an even level): THRESH / RATIO / ATTACK / RELEASE; 1:1 = off.
  ...COMP_PARAMS,
];

/** FX 1 knobs, 2 x 8: REVERSE, DISTORT, FILTER (two modules each), COMP (modules 7-8). */
export const DRUM_BUS_LAYOUT: readonly string[] = [
  'rev_mix', 'rev_len', 'dst_drive', 'dst_tone', 'flt', 'lp_reso', 'cmp_thresh', 'cmp_attack',
  'rev_smear', 'rev_fdbk', 'dst_crush', 'dst_level', 'lp_env', 'lp_release', 'cmp_ratio', 'cmp_release',
];

export function defaultDrumBus(): Record<string, number> {
  return Object.fromEntries(DRUM_BUS_PARAMS.map((p) => [p.id, p.defaultValue]));
}

/** Reverse buffer: two slices of up to 1 bar at 60 BPM. */
const REVERSE_SECONDS = 8.5;
const FILTER_UPDATE = 16;
/** SMEAR diffusers (samples at 48 kHz): short ones blur, long ones wash into a reverb. */
const DIFFUSE = [225, 341, 441, 556, 1100, 1700];

/** One allpass diffuser per channel (preallocated). */
class Allpass {
  private readonly buf: Float32Array;
  private i = 0;
  constructor(len: number) { this.buf = new Float32Array(Math.max(1, len)); }
  process(x: number, g: number): number {
    const d = this.buf[this.i];
    const y = d - g * x;
    this.buf[this.i] = x + g * y;
    if (++this.i >= this.buf.length) this.i = 0;
    return y;
  }
}

/**
 * REVERSE -> DISTORT -> FILTER.
 *  REVERSE  a reverse delay: the drums are recorded in REV LEN slices (tempo-synced) and each
 *           slice is played back backwards while the next one records, through two
 *           overlapping windows (no clicks), so every hit swells in towards where it was.
 *           REV FDBK feeds the reversed sound back in (reverse echoes of reverse echoes);
 *           SMEAR diffuses it into a reverse-reverb wash. REVERSE = how much is mixed in.
 *  DISTORT  DRIVE (dB into tanh), TONE (low-pass after it), CRUSH (bits + sample rate), LEVEL.
 *  FILTER   one knob (DJ style): left of centre a low-pass closing to 30 Hz, right a
 *           high-pass opening to 16 kHz, centre off (see djCutoff). RESO (to self-
 *           oscillation), ENV (an envelope follower raises (+) or lowers (-) the cutoff on
 *           every hit, up to 8 octaves), ENV REL (how fast the follower falls).
 *  COMP     bus compressor in series, for an even level: THRESH / RATIO / ATTACK /
 *           RELEASE with automatic make-up (see Compressor). RATIO 1:1 = off.
 */
export class DrumBus {
  private readonly sr: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  // Reverse
  private readonly mix: Smoother;
  private mixTarget = 0;
  private lenSteps = 4;
  private fdbk = 0.3;
  private smear = 0.4;
  private write = 0;
  private cycle = 0; // samples into the current slice
  private wetL = 0; private wetR = 0; // last reversed sample (feedback)
  private readonly apL: Allpass[];
  private readonly apR: Allpass[];
  private stepInc = 0; // song clock advance per sample (16th steps), from the engine
  // Distortion
  private driveDb = 0;
  private toneCoeff = 1;
  private crush = 0;
  private readonly level: Smoother;
  private levelTarget = 1;
  private toneL = 0; private toneR = 0;
  private holdCount = 0; private heldL = 0; private heldR = 0;
  // Filter: position (smoothed), 0 = off / -1 = low-pass / 1 = high-pass
  private readonly pos: Smoother;
  private posTarget = 0.5;
  private mode = 0;
  private reso = 0;
  private env = 0;
  private releaseMul = 0;
  private follow = 0;
  private counter = 0;
  private resting = false;
  private readonly lpL = new Svf();
  private readonly lpR = new Svf();
  private readonly comp: Compressor;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.bufL = new Float32Array(Math.ceil(sampleRate * REVERSE_SECONDS));
    this.bufR = new Float32Array(Math.ceil(sampleRate * REVERSE_SECONDS));
    const scale = sampleRate / 48000;
    this.apL = DIFFUSE.map((d) => new Allpass(Math.round(d * scale)));
    this.apR = DIFFUSE.map((d) => new Allpass(Math.round(d * scale * 1.07))); // decorrelated
    this.mix = new Smoother(0, 0.01, sampleRate);
    this.level = new Smoother(1, 0.02, sampleRate);
    this.pos = new Smoother(0.5, 0.02, sampleRate);
    this.comp = new Compressor(sampleRate);
    for (const p of DRUM_BUS_PARAMS) this.setParam(p.id, p.defaultValue);
  }

  /** Song position (16th steps) at the start of the next chunk, and its advance per sample. */
  setClock(_clockSteps: number, stepInc: number): void {
    this.stepInc = stepInc;
  }

  setParam(id: string, v: number): void {
    switch (id) {
      case 'rev_mix': this.mixTarget = v; this.mix.setTarget(v); break;
      case 'rev_len': this.lenSteps = REVERSE_LENGTHS[Math.round(v)]?.steps ?? 4; break;
      case 'rev_fdbk': this.fdbk = v; break;
      case 'rev_smear': this.smear = v; break;
      case 'dst_drive': this.driveDb = v; break;
      case 'dst_tone': this.toneCoeff = v >= 19999 ? 1 : 1 - Math.exp((-2 * Math.PI * v) / this.sr); break;
      case 'dst_crush': this.crush = v; break;
      case 'dst_level': this.levelTarget = v; this.level.setTarget(v); break;
      case 'flt': this.posTarget = v; this.pos.setTarget(v); break;
      case 'lp_reso': this.reso = v; this.counter = 0; break;
      case 'lp_env': this.env = v; break;
      case 'cmp_thresh': case 'cmp_ratio': case 'cmp_attack': case 'cmp_release': this.comp.setParam(id, v); break;
      case 'lp_release': this.releaseMul = Math.exp(-1 / (v * this.sr)); break;
    }
  }

  /** Jump to the current settings (project load). */
  settle(): void {
    this.mix.setImmediate(this.mixTarget);
    this.level.setImmediate(this.levelTarget);
    this.pos.setImmediate(this.posTarget);
  }

  /**
   * Every effect at rest (REVERSE off, no DISTORT, FILTER centred, COMP 1:1): the tracks just
   * pass through (the REVERSE buffer still records, so it can reach back when turned up).
   */
  private atRest(): boolean {
    return this.mixTarget === 0 && this.mix.value === 0 && this.driveDb === 0 && this.toneCoeff >= 1 && this.crush === 0
      && this.levelTarget === 1 && this.level.value === 1 && djCutoff(this.posTarget) === 0 && djCutoff(this.pos.value) === 0
      && !this.comp.active;
  }

  /** Reads the bus input and ADDS the processed result into out. */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    if (this.atRest()) {
      const size = this.bufL.length;
      for (let i = 0; i < n; i++) {
        this.bufL[this.write] = inL[i];
        this.bufR[this.write] = inR[i];
        if (++this.write >= size) this.write = 0;
        outL[off + i] += inL[i];
        outR[off + i] += inR[i];
      }
      this.wetL = this.wetR = 0;
      this.resting = true;
      return;
    }
    if (this.resting) {
      // Back from rest: the filter starts from silence instead of stale state.
      this.resting = false;
      this.lpL.reset();
      this.lpR.reset();
      this.counter = 0;
    }
    const gain = Math.pow(10, this.driveDb / 20);
    const shape = Math.min(1, this.driveDb / 6); // blend in the shaper over the first 6 dB
    const hold = 1 + Math.floor(this.crush * this.crush * 40);
    const levels = Math.pow(2, 16 - this.crush * 14);
    // Slice length in samples (tempo-synced), at most half the buffer.
    const stepFrames = this.stepInc > 0 ? 1 / this.stepInc : this.sr / 8;
    const len = Math.max(256, Math.min(Math.floor(this.bufL.length / 2) - 2, Math.round(this.lenSteps * stepFrames)));
    const size = this.bufL.length;
    const g = this.smear > 0 ? 0.45 + 0.3 * this.smear : 0;
    const comp = this.comp.active ? this.comp : null;
    for (let i = 0; i < n; i++) {
      let l = inL[i];
      let r = inR[i];

      // ---- REVERSE: record (with feedback), then read backwards through two windows.
      const fb = this.fdbk;
      this.bufL[this.write] = l + (fb > 0 ? Math.tanh(this.wetL * fb) : 0);
      this.bufR[this.write] = r + (fb > 0 ? Math.tanh(this.wetR * fb) : 0);
      const m = this.mix.next();
      if (this.cycle >= len) this.cycle -= len;
      if (this.mixTarget > 0 || m > 1e-4) {
        let yl = 0;
        let yr = 0;
        for (let tap = 0; tap < 2; tap++) {
          // Each tap's read head runs backwards from "now" across two slices; the window
          // (sin^2, the two taps half a slice apart) sums to 1 and hides the jumps.
          let ph = this.cycle / len + tap * 0.5;
          if (ph >= 1) ph -= 1;
          const d = 2 * len * ph + 1;
          let pos = this.write - d;
          if (pos < 0) pos += size;
          const k = Math.floor(pos);
          const f = pos - k;
          const k2 = k + 1 < size ? k + 1 : 0;
          const w = Math.sin(Math.PI * ph);
          const win = w * w;
          yl += (this.bufL[k] + (this.bufL[k2] - this.bufL[k]) * f) * win;
          yr += (this.bufR[k] + (this.bufR[k2] - this.bufR[k]) * f) * win;
        }
        if (g > 0) {
          // SMEAR: diffuse towards a reverse-reverb wash (blend in by SMEAR).
          let dl = yl;
          let dr = yr;
          for (let a = 0; a < DIFFUSE.length; a++) {
            dl = this.apL[a].process(dl, g);
            dr = this.apR[a].process(dr, g);
          }
          yl += (dl - yl) * this.smear;
          yr += (dr - yr) * this.smear;
        }
        this.wetL = yl;
        this.wetR = yr;
        l += yl * m;
        r += yr * m;
      } else {
        this.wetL = this.wetR = 0;
      }
      if (++this.write >= size) this.write = 0;
      this.cycle++;

      // ---- DISTORT
      if (shape > 0) {
        l += (Math.tanh(l * gain) - l) * shape;
        r += (Math.tanh(r * gain) - r) * shape;
      }
      if (this.toneCoeff < 1) {
        this.toneL += (l - this.toneL) * this.toneCoeff;
        this.toneR += (r - this.toneR) * this.toneCoeff;
        l = this.toneL;
        r = this.toneR;
      }
      if (this.crush > 0) {
        if (this.holdCount <= 0) {
          this.heldL = Math.round(l * levels) / levels;
          this.heldR = Math.round(r * levels) / levels;
          this.holdCount = hold;
        }
        this.holdCount--;
        l = this.heldL;
        r = this.heldR;
      }
      const lv = this.level.next();
      l *= lv;
      r *= lv;

      // ---- LOW-PASS
      const a = (l < 0 ? -l : l) + (r < 0 ? -r : r);
      this.follow = a > this.follow ? a : this.follow * this.releaseMul;
      const pos = this.pos.next();
      if (this.counter-- <= 0) {
        this.counter = FILTER_UPDATE;
        const c = djCutoff(pos);
        this.mode = c < 0 ? -1 : c > 0 ? 1 : 0;
        const base = c < 0 ? -c : c;
        const fc = this.env === 0 ? base : base * Math.pow(2, this.env * 8 * Math.min(1, this.follow));
        this.lpL.setup(fc < 20 ? 20 : fc, this.reso, this.sr);
        this.lpR.setup(fc < 20 ? 20 : fc, this.reso, this.sr);
      }
      this.lpL.process(l);
      this.lpR.process(r);
      // Centred (OFF): transparent.
      if (this.mode < 0) {
        l = this.lpL.low;
        r = this.lpR.low;
      } else if (this.mode > 0) {
        l = this.lpL.high;
        r = this.lpR.high;
      }

      // ---- COMP (series)
      if (comp) {
        const k = comp.gain(l, r);
        l *= k;
        r *= k;
      }

      outL[off + i] += l;
      outR[off + i] += r;
    }
    if (Math.abs(this.toneL) < 1e-15) this.toneL = 0;
    if (Math.abs(this.toneR) < 1e-15) this.toneR = 0;
    if (this.follow < 1e-9) this.follow = 0;
  }
}
