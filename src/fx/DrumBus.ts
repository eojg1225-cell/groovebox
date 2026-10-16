import type { ParamSpec } from '../engine/params';
import { Smoother } from '../engine/smoother';
import { Svf } from '../instruments/dsp';

/** STUTTER repeat lengths, in 16th steps. */
export const STUTTER_GRIDS = [
  { name: '1/2', steps: 8 }, { name: '1/4', steps: 4 }, { name: '1/8', steps: 2 }, { name: '1/8T', steps: 4 / 3 },
  { name: '1/16', steps: 1 }, { name: '1/16T', steps: 2 / 3 }, { name: '1/32', steps: 0.5 }, { name: '1/64', steps: 0.25 },
] as const;

/**
 * FX 1, the drum bus: tracks routed here pass THROUGH it (100% wet, nothing is added
 * alongside), so the stutter replaces the drums and the low-pass really darkens them.
 * At its defaults it is transparent. Knob order = panel order (top row, then bottom row):
 * two modules per effect.
 */
export const DRUM_BUS_PARAMS: readonly ParamSpec[] = [
  { id: 'stt_mix', name: 'STUTTER', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'stt_grid', name: 'STT GRID', min: 0, max: STUTTER_GRIDS.length - 1, defaultValue: 4, unit: '', curve: 'linear', options: STUTTER_GRIDS.map((g) => g.name) },
  { id: 'dst_drive', name: 'DRIVE', min: 0, max: 60, defaultValue: 0, unit: 'DB', curve: 'linear', decimals: 0 },
  { id: 'dst_tone', name: 'DST TONE', min: 200, max: 20000, defaultValue: 20000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'lp_cutoff', name: 'LP CUTOFF', min: 30, max: 20000, defaultValue: 20000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'lp_reso', name: 'LP RESO', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'stt_fade', name: 'STT FADE', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'stt_pitch', name: 'STT PITCH', min: -12, max: 12, defaultValue: 0, unit: 'ST', curve: 'linear', decimals: 1 },
  { id: 'dst_crush', name: 'CRUSH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'dst_level', name: 'DST LEVEL', min: 0, max: 2, defaultValue: 1, unit: 'X', curve: 'linear' },
  { id: 'lp_env', name: 'LP ENV', min: -1, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'lp_release', name: 'LP REL', min: 0.005, max: 2, defaultValue: 0.15, unit: 'S', curve: 'exp', decimals: 3 },
];

export function defaultDrumBus(): Record<string, number> {
  return Object.fromEntries(DRUM_BUS_PARAMS.map((p) => [p.id, p.defaultValue]));
}

/** Longest stutter repeat (1/2 bar at 40 BPM is 3 s). */
const STUTTER_SECONDS = 4;
const FILTER_UPDATE = 16;

/**
 * STUTTER -> DISTORT -> LOW-PASS.
 *  STUTTER  turning STUTTER up arms it; on the next GRID line it captures one GRID length
 *           and repeats it (MIX crossfades dry -> repeats). FADE lowers each repeat, PITCH
 *           shifts each repeat further (+/- semitones per repeat). Back to 0 = released.
 *           Changing GRID while it runs re-captures on the next line (a roll).
 *  DISTORT  DRIVE (dB into tanh), TONE (low-pass after it), CRUSH (bits + sample rate), LEVEL.
 *  LOW-PASS CUTOFF, RESO (to self-oscillation), ENV (an envelope follower opens (+) or
 *           closes (-) it on every hit, up to 8 octaves), REL (how fast the follower falls).
 */
export class DrumBus {
  private readonly sr: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  // Stutter
  private readonly mix: Smoother;
  private mixTarget = 0;
  private gridSteps = 1;
  private fade = 0;
  private pitch = 0;
  private latched = false;
  private t = 0; // samples since capture began
  private len = 1; // repeat length in samples
  private cell = -1; // last grid cell index seen (for detecting a grid line)
  private clock = 0; // song clock at the chunk start, in 16th steps
  private stepInc = 0; // clock advance per sample
  // Distortion
  private driveDb = 0;
  private toneCoeff = 1;
  private crush = 0;
  private readonly level: Smoother;
  private levelTarget = 1;
  private toneL = 0; private toneR = 0;
  private holdCount = 0; private heldL = 0; private heldR = 0;
  // Low-pass
  private readonly cutoff: Smoother;
  private cutoffTarget = 20000;
  private reso = 0;
  private env = 0;
  private releaseMul = 0;
  private follow = 0;
  private counter = 0;
  private readonly lpL = new Svf();
  private readonly lpR = new Svf();

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.bufL = new Float32Array(Math.ceil(sampleRate * STUTTER_SECONDS));
    this.bufR = new Float32Array(Math.ceil(sampleRate * STUTTER_SECONDS));
    this.mix = new Smoother(0, 0.01, sampleRate);
    this.level = new Smoother(1, 0.02, sampleRate);
    this.cutoff = new Smoother(20000, 0.02, sampleRate);
    for (const p of DRUM_BUS_PARAMS) this.setParam(p.id, p.defaultValue);
  }

  /** Song position (16th steps) at the start of the next chunk, and its advance per sample. */
  setClock(clockSteps: number, stepInc: number): void {
    this.clock = clockSteps;
    this.stepInc = stepInc;
  }

  setParam(id: string, v: number): void {
    switch (id) {
      case 'stt_mix': this.mixTarget = v; this.mix.setTarget(v); break;
      case 'stt_grid': {
        const steps = STUTTER_GRIDS[Math.round(v)]?.steps ?? 1;
        if (steps !== this.gridSteps) {
          this.gridSteps = steps;
          this.latched = false; // re-capture on the next line of the new grid
          this.cell = -1;
        }
        break;
      }
      case 'stt_fade': this.fade = v; break;
      case 'stt_pitch': this.pitch = v; break;
      case 'dst_drive': this.driveDb = v; break;
      case 'dst_tone': this.toneCoeff = v >= 19999 ? 1 : 1 - Math.exp((-2 * Math.PI * v) / this.sr); break;
      case 'dst_crush': this.crush = v; break;
      case 'dst_level': this.levelTarget = v; this.level.setTarget(v); break;
      case 'lp_cutoff': this.cutoffTarget = v; this.cutoff.setTarget(v); break;
      case 'lp_reso': this.reso = v; this.counter = 0; break;
      case 'lp_env': this.env = v; break;
      case 'lp_release': this.releaseMul = Math.exp(-1 / (v * this.sr)); break;
    }
  }

  /** Jump to the current settings (project load). */
  settle(): void {
    this.mix.setImmediate(this.mixTarget);
    this.level.setImmediate(this.levelTarget);
    this.cutoff.setImmediate(this.cutoffTarget);
  }

  /** Reads the bus input and ADDS the processed result into out. */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    const gain = Math.pow(10, this.driveDb / 20);
    const shape = Math.min(1, this.driveDb / 6); // blend in the shaper over the first 6 dB
    const hold = 1 + Math.floor(this.crush * this.crush * 40);
    const levels = Math.pow(2, 16 - this.crush * 14);
    const grid = this.gridSteps;
    const fadeN = 64;
    for (let i = 0; i < n; i++) {
      let l = inL[i];
      let r = inR[i];

      // ---- STUTTER
      const m = this.mix.next();
      if (this.mixTarget > 0 || m > 1e-4) {
        const c = Math.floor((this.clock + i * this.stepInc) / grid);
        if (!this.latched && this.mixTarget > 0 && this.cell >= 0 && c !== this.cell) {
          this.latched = true;
          this.t = 0;
          this.len = Math.max(16, Math.min(this.bufL.length, Math.round(grid / this.stepInc)));
        }
        this.cell = c;
        if (this.latched) {
          const len = this.len;
          let yl: number;
          let yr: number;
          let phase: number;
          if (this.t < len) {
            // First pass: the live signal, captured as it goes.
            this.bufL[this.t] = l;
            this.bufR[this.t] = r;
            yl = l;
            yr = r;
            phase = this.t;
          } else {
            const rep = Math.floor(this.t / len);
            phase = this.t - rep * len;
            let st = this.pitch * rep;
            st = st > 48 ? 48 : st < -48 ? -48 : st;
            const rate = st === 0 ? 1 : Math.pow(2, st / 12);
            let p = phase * rate;
            p -= Math.floor(p / len) * len;
            const k = Math.floor(p);
            const f = p - k;
            const k2 = k + 1 < len ? k + 1 : 0;
            const g = Math.pow(1 - this.fade, rep);
            yl = (this.bufL[k] + (this.bufL[k2] - this.bufL[k]) * f) * g;
            yr = (this.bufR[k] + (this.bufR[k2] - this.bufR[k]) * f) * g;
            // Short fades at the loop points so repeats don't click.
            if (phase < fadeN) { yl *= phase / fadeN; yr *= phase / fadeN; }
          }
          if (len - phase < fadeN) { const w = (len - phase) / fadeN; yl *= w; yr *= w; }
          this.t++;
          l += (yl - l) * m;
          r += (yr - r) * m;
        }
        if (this.mixTarget === 0 && m <= 1e-4) {
          this.latched = false;
          this.cell = -1;
        }
      }

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
      const base = this.cutoff.next();
      if (this.counter-- <= 0) {
        this.counter = FILTER_UPDATE;
        const fc = this.env === 0 ? base : base * Math.pow(2, this.env * 8 * Math.min(1, this.follow));
        this.lpL.setup(fc < 20 ? 20 : fc, this.reso, this.sr);
        this.lpR.setup(fc < 20 ? 20 : fc, this.reso, this.sr);
      }
      this.lpL.process(l);
      this.lpR.process(r);
      // Wide open with no resonance or envelope: transparent.
      if (base < 19990 || this.reso > 0 || this.env !== 0) {
        l = this.lpL.low;
        r = this.lpR.low;
      }

      outL[off + i] += l;
      outR[off + i] += r;
    }
    if (Math.abs(this.toneL) < 1e-15) this.toneL = 0;
    if (Math.abs(this.toneR) < 1e-15) this.toneR = 0;
    if (this.follow < 1e-9) this.follow = 0;
  }
}
