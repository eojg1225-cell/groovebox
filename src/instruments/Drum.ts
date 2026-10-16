import type { Instrument, Preset } from './Instrument';
import { choice, type ParamSpec } from '../engine/params';
import { decayMul, Noise, polyBlep, Svf } from './dsp';
import { INTENSITY, TIMBRE } from './macroParams';
import { MACROS } from './macros';

/**
 * Drum voice built from layers. Each drum type uses two of them:
 *   KICK  = TONE + CLICK      SNARE = TONE + METAL      HAT = CLICK + METAL
 *  TONE   pitched oscillator with an exponential pitch sweep
 *  CLICK  very short transient (impulse/noise blend) through a resonant band-pass
 *  METAL  six inharmonic oscillators (square bank, ring-mod pairs or FM) blended with
 *         noise (snare wires, hat sizzle), through a high-pass
 * Every drum has DRIVE (tanh) and CRUSH (bit + sample-rate reduction) for industrial sounds.
 * The played note tunes the pitched layers (36 = as designed), so drums play chromatically.
 */

const T_WAVES = ['SINE', 'TRI', 'SAW', 'SQR'];

/** Every drum parameter; each drum type exposes a subset with its own defaults. */
const ALL: Record<string, ParamSpec> = Object.fromEntries(([
  TIMBRE,
  INTENSITY,
  { id: 't_level', name: 'TONE', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 't_pitch', name: 'PITCH', min: 20, max: 2000, defaultValue: 50, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 't_sweep', name: 'SWEEP', min: 0, max: 48, defaultValue: 24, unit: 'ST', curve: 'linear', decimals: 0 },
  { id: 't_stime', name: 'SWP TIME', min: 0.003, max: 0.5, defaultValue: 0.04, unit: 'S', curve: 'exp' },
  { id: 't_decay', name: 'DECAY', min: 0.01, max: 3, defaultValue: 0.45, unit: 'S', curve: 'exp' },
  choice('t_wave', 'WAVE', T_WAVES),
  { id: 'c_level', name: 'CLICK', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'c_tone', name: 'CLK TONE', min: 300, max: 16000, defaultValue: 4000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'c_len', name: 'CLK LEN', min: 0.0005, max: 0.05, defaultValue: 0.004, unit: 'S', curve: 'exp', decimals: 3 },
  { id: 'c_reso', name: 'CLK RESO', min: 0, max: 0.95, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'c_noise', name: 'CLK NOISE', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
  { id: 'm_level', name: 'METAL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'm_pitch', name: 'M PITCH', min: 40, max: 4000, defaultValue: 400, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'm_spread', name: 'SPREAD', min: 0, max: 1, defaultValue: 1, unit: '', curve: 'linear' },
  { id: 'm_noise', name: 'NOISE', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'm_tone', name: 'M TONE', min: 100, max: 14000, defaultValue: 6000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'm_decay', name: 'M DECAY', min: 0.01, max: 3, defaultValue: 0.2, unit: 'S', curve: 'exp' },
  // Continuous: 0 = square bank, 1 = ring-mod pairs, 2 = FM (blends in between).
  { id: 'm_mode', name: 'M MODE', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'm_fm', name: 'M FM', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'drive', name: 'DRIVE', min: 1, max: 30, defaultValue: 1, unit: 'X', curve: 'exp', decimals: 1 },
  { id: 'crush', name: 'CRUSH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
] as ParamSpec[]).map((p) => [p.id, p]));

/** Build a drum type's parameter list (in knob order) with per-type defaults. */
function drumParams(ids: string[], defaults: Record<string, number>): ParamSpec[] {
  return ids.map((id) => ({ ...ALL[id], defaultValue: defaults[id] ?? ALL[id].defaultValue }));
}

/*
 * Each drum type: its parameters (all stored, set by TIMBRE / INTENSITY and presets)
 * and its sound page (4 sound knobs per row; the registry adds the LFO knobs):
 * TIMBRE and INTENSITY first, then the most useful details, ending in DRIVE / CRUSH.
 */
export const KICK_PARAMS = drumParams(
  ['timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_stime', 't_decay', 't_wave', 'c_level', 'c_tone', 'c_reso', 'c_len', 'c_noise', 'drive', 'crush'],
  { t_level: 0.95, t_pitch: 48, t_sweep: 30, t_stime: 0.035, t_decay: 0.5, c_level: 0.25, c_tone: 3500, c_len: 0.003 },
);
export const KICK_LAYOUT = [['timbre', 'intensity', 't_pitch', 't_decay'], ['c_level', 't_sweep', 'drive', 'crush']];

export const SNARE_PARAMS = drumParams(
  ['timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_decay', 't_wave', 'm_level', 'm_pitch', 'm_noise', 'm_tone', 'm_decay', 'm_spread', 'm_mode', 'm_fm', 'drive', 'crush'],
  { t_level: 0.55, t_pitch: 190, t_sweep: 7, t_decay: 0.14, m_level: 0.8, m_noise: 0.85, m_pitch: 330, m_tone: 1800, m_decay: 0.2 },
);
export const SNARE_LAYOUT = [['timbre', 'intensity', 't_pitch', 't_decay'], ['m_level', 'm_decay', 'drive', 'crush']];

export const HAT_PARAMS = drumParams(
  ['timbre', 'intensity', 'c_level', 'c_tone', 'c_reso', 'c_len', 'c_noise', 'm_level', 'm_pitch', 'm_spread', 'm_noise', 'm_tone', 'm_decay', 'm_mode', 'm_fm', 'drive', 'crush'],
  { c_level: 0.2, c_tone: 9000, c_len: 0.002, m_level: 0.6, m_pitch: 420, m_spread: 1, m_noise: 0.3, m_tone: 8500, m_decay: 0.05 },
);
export const HAT_LAYOUT = [['timbre', 'intensity', 'm_pitch', 'm_decay'], ['c_level', 'm_tone', 'drive', 'crush']];

/** Presets = the named TIMBRE points (intensity in the middle). */
function anchorPresets(kind: 'kick' | 'snare' | 'hat'): Preset[] {
  const anchors = MACROS[kind].anchors;
  return anchors.map((a, i) => ({ name: a.name, values: { timbre: i / (anchors.length - 1), intensity: 0.5 } }));
}
export const KICK_PRESETS: readonly Preset[] = anchorPresets('kick');
export const SNARE_PRESETS: readonly Preset[] = anchorPresets('snare');
export const HAT_PRESETS: readonly Preset[] = anchorPresets('hat');

/** 808 cymbal oscillator ratios (relative to the lowest). */
const METAL_RATIOS = [1, 1.4471, 1.617, 1.9265, 2.5028, 2.6637];
const TWO_PI = Math.PI * 2;
/** RING multiplies the tone and metal decay times (closed hat 0.05 s -> open ~0.4 s). */
const RING_FACTOR = 8;
/** A ringing drum is choked (by the next hit or a rest) with this fade. */
const CHOKE_SECONDS = 0.012;

export class Drum implements Instrument {
  private readonly sr: number;
  private readonly noise = new Noise(0x5eed);
  private readonly mFilter = new Svf();
  private readonly cFilter = new Svf();

  // Parameter values (all layers silent unless the drum type sets them)
  private tLevel = 0; private tPitch = 50; private tSweep = 24; private tWave = 0;
  private cLevel = 0; private cTone = 4000; private cReso = 0.3; private cNoise = 0.6;
  private drive = 1; private crush = 0;
  private mLevel = 0; private mPitch = 400; private mSpread = 1; private mNoise = 0.3; private mMode = 0; private mFm = 0.5;
  private fmC = 0; private fmM = 0;
  private tDecayMul = 0; private sweepMul = 0; private mDecayMul = 0; private cDecayMul = 0;
  private tRingMul = 0; private mRingMul = 0;
  private readonly chokeMul: number;
  /** Decay multipliers in use for the current hit (normal, ring or choke). */
  private tMul = 0; private mMul = 0;
  private ringing = false;

  // Voice state
  private tune = 1;
  private pitchMod = 1;
  private tPhase = 0; private tEnv = 0; private sweepEnv = 0;
  private readonly mPhase = new Float64Array(6);
  private mEnv = 0; private cEnv = 0;
  private velocity = 1;
  private holdCount = 0; private held = 0;

  constructor(sampleRate: number, readonly params: readonly ParamSpec[]) {
    this.sr = sampleRate;
    this.chokeMul = decayMul(CHOKE_SECONDS, sampleRate);
    for (const p of Object.values(ALL)) this.setParam(p.id, p.defaultValue);
    this.tLevel = 0; this.cLevel = 0; this.mLevel = 0;
    for (const p of params) this.setParam(p.id, p.defaultValue);
  }

  noteOn(note: number, velocity: number, _group: number, ring = false): void {
    this.ringing = ring;
    this.tMul = ring ? this.tRingMul : this.tDecayMul;
    this.mMul = ring ? this.mRingMul : this.mDecayMul;
    this.tune = Math.pow(2, (note - 36) / 12);
    this.velocity = velocity;
    this.tPhase = 0;
    this.tEnv = 1;
    this.sweepEnv = 1;
    this.mEnv = 1;
    this.cEnv = 1;
  }

  /** Only a ringing hit responds: it is choked (closed off quickly). */
  noteOff(_group: number): void {
    if (!this.ringing) return;
    this.ringing = false;
    this.tMul = this.chokeMul;
    this.mMul = this.chokeMul;
  }

  setPitchMod(semitones: number): void {
    this.pitchMod = semitones === 0 ? 1 : Math.pow(2, semitones / 12);
  }

  setParam(id: string, v: number): void {
    const sr = this.sr;
    switch (id) {
      case 't_level': this.tLevel = v; break;
      case 't_pitch': this.tPitch = v; break;
      case 't_sweep': this.tSweep = v; break;
      case 't_stime': this.sweepMul = decayMul(v, sr); break;
      case 't_decay': this.tDecayMul = decayMul(v, sr); this.tRingMul = decayMul(Math.min(6, v * RING_FACTOR), sr); break;
      case 't_wave': this.tWave = Math.round(v); break;
      case 'c_level': this.cLevel = v; break;
      case 'c_tone': this.cTone = v; this.cFilter.setup(this.cTone, this.cReso, sr); break;
      case 'c_reso': this.cReso = v; this.cFilter.setup(this.cTone, this.cReso, sr); break;
      case 'c_noise': this.cNoise = v; break;
      case 'c_len': this.cDecayMul = decayMul(v, sr); break;
      case 'drive': this.drive = v; break;
      case 'crush': this.crush = v; break;
      case 'm_level': this.mLevel = v; break;
      case 'm_pitch': this.mPitch = v; break;
      case 'm_spread': this.mSpread = v; break;
      case 'm_noise': this.mNoise = v; break;
      case 'm_tone': this.mFilter.setup(v, 0.3, sr); break;
      case 'm_decay': this.mDecayMul = decayMul(v, sr); this.mRingMul = decayMul(Math.min(6, v * RING_FACTOR), sr); break;
      case 'm_mode': this.mMode = Math.min(2, Math.max(0, v)); break;
      case 'm_fm': this.mFm = v; break;
    }
  }

  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    if (this.tEnv + this.mEnv + this.cEnv === 0) return;
    const dtBase = 1 / this.sr;
    const hold = 1 + Math.floor(this.crush * this.crush * 24);
    const levels = Math.pow(2, 16 - this.crush * 12);
    const driveNorm = this.drive > 1 ? 1 / Math.tanh(Math.min(this.drive, 3)) : 1;
    const tPitch = this.tPitch * this.tune * this.pitchMod;
    const mPitch = this.mPitch * this.tune * this.pitchMod;

    for (let i = start; i < end; i++) {
      let sum = 0;

      // TONE
      if (this.tEnv > 0) {
        const f = tPitch * Math.pow(2, (this.tSweep * this.sweepEnv) / 12);
        const dt = f * dtBase;
        this.tPhase += dt;
        if (this.tPhase >= 1) this.tPhase -= 1;
        const ph = this.tPhase;
        let osc: number;
        switch (this.tWave) {
          case 1: osc = 4 * Math.abs(ph - 0.5) - 1; break;
          case 2: osc = 2 * ph - 1 - polyBlep(ph, dt); break;
          case 3: {
            let p2 = ph + 0.5; if (p2 >= 1) p2 -= 1;
            osc = (ph < 0.5 ? 1 : -1) + polyBlep(ph, dt) - polyBlep(p2, dt);
            break;
          }
          default: osc = Math.sin(TWO_PI * ph);
        }
        sum += osc * this.tEnv * this.tLevel;
        this.tEnv *= this.tMul;
        this.sweepEnv *= this.sweepMul;
        if (this.tEnv < 1e-5) this.tEnv = 0;
      }

      // METAL (+ noise blend). M MODE crossfades square bank -> ring-mod -> FM.
      if (this.mEnv > 0) {
        const spread = this.mSpread * 2;
        const mode = this.mMode;
        const wSq = Math.max(0, 1 - mode);
        const wRing = Math.max(0, 1 - Math.abs(mode - 1));
        const wFm = Math.max(0, mode - 1);
        let m = 0;
        if (wSq > 0 || wRing > 0) {
          const ph = this.mPhase;
          for (let k = 0; k < 6; k++) {
            ph[k] += mPitch * (1 + (METAL_RATIOS[k] - 1) * spread) * dtBase;
            if (ph[k] >= 1) ph[k] -= 1;
          }
          const s0 = ph[0] < 0.5 ? 1 : -1, s1 = ph[1] < 0.5 ? 1 : -1, s2 = ph[2] < 0.5 ? 1 : -1;
          const s3 = ph[3] < 0.5 ? 1 : -1, s4 = ph[4] < 0.5 ? 1 : -1, s5 = ph[5] < 0.5 ? 1 : -1;
          if (wSq > 0) m += wSq * (s0 + s1 + s2 + s3 + s4 + s5) / 6;
          if (wRing > 0) m += wRing * (s0 * s1 + s2 * s3 + s4 * s5) / 3;
        }
        if (wFm > 0) {
          // FM: carrier at pitch, modulator at an inharmonic ratio; index = M FM x envelope.
          this.fmC += mPitch * dtBase; if (this.fmC >= 1) this.fmC -= 1;
          this.fmM += mPitch * (1 + (METAL_RATIOS[3] - 1) * spread) * dtBase; if (this.fmM >= 1) this.fmM -= 1;
          const index = (0.5 + 9 * this.mFm) * (0.3 + 0.7 * this.mEnv);
          m += wFm * Math.sin(TWO_PI * this.fmC + index * Math.sin(TWO_PI * this.fmM));
        }
        m = m * (1 - this.mNoise) + this.noise.next() * this.mNoise;
        this.mFilter.process(m);
        sum += this.mFilter.high * this.mEnv * this.mLevel;
        this.mEnv *= this.mMul;
        if (this.mEnv < 1e-5) this.mEnv = 0;
      }

      // CLICK
      if (this.cEnv > 0) {
        // Impulse (a "knock" that rings at CLK TONE with RESO) blended with a noise burst.
        this.cFilter.process(this.noise.next() * this.cNoise + (this.cEnv === 1 ? 4 * (1 - this.cNoise * 0.5) : 0));
        sum += this.cFilter.band * this.cEnv * this.cLevel * 2;
        this.cEnv *= this.cDecayMul;
        if (this.cEnv < 1e-5) this.cEnv = 0;
      }

      // DRIVE then CRUSH
      let out = sum * this.velocity;
      if (this.drive > 1) out = Math.tanh(out * this.drive) * driveNorm * 0.8;
      if (this.crush > 0) {
        if (this.holdCount <= 0) {
          this.held = Math.round(out * levels) / levels;
          this.holdCount = hold;
        }
        this.holdCount--;
        out = this.held;
      }
      outL[i] += out;
      outR[i] += out;
    }
  }
}
