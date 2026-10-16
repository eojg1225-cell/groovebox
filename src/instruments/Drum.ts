import type { Instrument, Preset } from './Instrument';
import { choice, type ParamSpec } from '../engine/params';
import { decayMul, Noise, polyBlep, Svf } from './dsp';

/**
 * Layered drum voice. Four layers summed into a drive + crush master:
 *  TONE   pitched oscillator with exponential pitch sweep (kicks, toms, snare bodies)
 *  METAL  six inharmonic oscillators: square bank (808-style), ring-mod pairs, or FM
 *  NOISE  filtered noise (LP/BP/HP) with optional clap-style bursts
 *  CLICK  a very short filtered transient
 * DRIVE (tanh saturation) and CRUSH (bit + sample-rate reduction) push it industrial.
 */

const T_WAVES = ['SINE', 'TRI', 'SAW', 'SQR'] as const;
const M_MODES = ['SQR6', 'RING', 'FM'] as const;
const N_FILTERS = ['LP', 'BP', 'HP'] as const;
const BURSTS = ['1', '2', '3', '4'] as const;

export const DRUM_PARAMS: readonly ParamSpec[] = [
  // TONE layer
  { id: 't_level', name: 'TONE', min: 0, max: 1, defaultValue: 0.9, unit: '', curve: 'linear' },
  { id: 't_pitch', name: 'PITCH', min: 20, max: 2000, defaultValue: 50, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 't_sweep', name: 'SWEEP', min: 0, max: 48, defaultValue: 24, unit: 'ST', curve: 'linear', decimals: 0 },
  { id: 't_stime', name: 'SWP TIME', min: 0.003, max: 0.5, defaultValue: 0.04, unit: 'S', curve: 'exp' },
  { id: 't_decay', name: 'DECAY', min: 0.01, max: 3, defaultValue: 0.45, unit: 'S', curve: 'exp' },
  { id: 't_drive', name: 'T DRIVE', min: 1, max: 20, defaultValue: 1, unit: 'X', curve: 'exp', decimals: 1 },
  choice('t_wave', 'T WAVE', T_WAVES),
  // CLICK layer
  { id: 'c_level', name: 'CLICK', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'c_tone', name: 'CLK TONE', min: 300, max: 16000, defaultValue: 4000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'c_len', name: 'CLK LEN', min: 0.0005, max: 0.03, defaultValue: 0.004, unit: 'S', curve: 'exp', decimals: 3 },
  // Master
  { id: 'drive', name: 'DRIVE', min: 1, max: 30, defaultValue: 1, unit: 'X', curve: 'exp', decimals: 1 },
  { id: 'crush', name: 'CRUSH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // METAL layer
  { id: 'm_level', name: 'METAL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'm_pitch', name: 'M PITCH', min: 40, max: 4000, defaultValue: 400, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'm_spread', name: 'SPREAD', min: 0, max: 1, defaultValue: 1, unit: '', curve: 'linear' },
  { id: 'm_tone', name: 'M TONE', min: 100, max: 14000, defaultValue: 6000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'm_decay', name: 'M DECAY', min: 0.01, max: 3, defaultValue: 0.2, unit: 'S', curve: 'exp' },
  choice('m_mode', 'M MODE', M_MODES),
  // NOISE layer
  { id: 'n_level', name: 'NOISE', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'n_cut', name: 'N CUTOFF', min: 100, max: 16000, defaultValue: 5000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'n_reso', name: 'N RESO', min: 0, max: 0.9, defaultValue: 0.2, unit: '', curve: 'linear' },
  { id: 'n_decay', name: 'N DECAY', min: 0.01, max: 2, defaultValue: 0.15, unit: 'S', curve: 'exp' },
  choice('n_filter', 'N FILTER', N_FILTERS, 1),
  choice('n_burst', 'BURSTS', BURSTS),
];

/** Sound design pages (12 knobs each, 2 rows of 6). */
export const DRUM_PAGES = [
  { name: 'TONE', ids: ['t_level', 't_pitch', 't_sweep', 't_stime', 't_decay', 't_drive', 't_wave', 'c_level', 'c_tone', 'c_len', 'drive', 'crush'] },
  { name: 'METAL+NOISE', ids: ['m_level', 'm_pitch', 'm_spread', 'm_tone', 'm_decay', 'm_mode', 'n_level', 'n_cut', 'n_reso', 'n_decay', 'n_filter', 'n_burst'] },
];

const SILENT = { t_level: 0, c_level: 0, m_level: 0, n_level: 0 };
export const DRUM_PRESETS: readonly Preset[] = [
  { name: 'KICK', live: ['t_decay', 't_pitch'],
    values: { t_level: 0.95, t_pitch: 48, t_sweep: 30, t_stime: 0.035, t_decay: 0.5, c_level: 0.25, c_tone: 3500, c_len: 0.003 } },
  { name: 'SNARE', live: ['n_decay', 't_pitch'],
    values: { ...SILENT, t_level: 0.55, t_pitch: 190, t_sweep: 7, t_stime: 0.02, t_decay: 0.14, n_level: 0.75, n_filter: 1, n_cut: 3200, n_reso: 0.15, n_decay: 0.2, c_level: 0.3, c_tone: 6000 } },
  { name: 'HAT', live: ['n_decay', 'm_tone'],
    values: { ...SILENT, m_level: 0.45, m_pitch: 420, m_spread: 1, m_mode: 0, m_tone: 8500, m_decay: 0.045, n_level: 0.3, n_filter: 2, n_cut: 9000, n_decay: 0.035 } },
  { name: 'OPEN HAT', live: ['m_decay', 'm_tone'],
    values: { ...SILENT, m_level: 0.45, m_pitch: 420, m_spread: 1, m_mode: 0, m_tone: 8000, m_decay: 0.45, n_level: 0.3, n_filter: 2, n_cut: 8000, n_decay: 0.35 } },
  { name: 'CLAP', live: ['n_decay', 'n_cut'],
    values: { ...SILENT, n_level: 0.9, n_filter: 1, n_cut: 1300, n_reso: 0.35, n_decay: 0.22, n_burst: 3, c_level: 0.15, c_tone: 2500 } },
  { name: 'METAL', live: ['m_decay', 'm_pitch'],
    values: { ...SILENT, m_level: 0.7, m_mode: 1, m_pitch: 560, m_spread: 0.8, m_tone: 900, m_decay: 0.4, t_level: 0.3, t_pitch: 210, t_sweep: 5, t_decay: 0.2 } },
  { name: 'IND KICK', live: ['drive', 'crush'],
    values: { t_level: 0.95, t_pitch: 45, t_sweep: 36, t_stime: 0.05, t_decay: 0.6, t_drive: 8, c_level: 0.6, c_tone: 2500, c_len: 0.006,
      n_level: 0.25, n_filter: 0, n_cut: 1800, n_decay: 0.12, drive: 6, crush: 0.25 } },
  { name: 'IND HIT', live: ['crush', 'm_pitch'],
    values: { t_level: 0.5, t_pitch: 90, t_sweep: 24, t_stime: 0.03, t_decay: 0.25, m_level: 0.6, m_mode: 2, m_pitch: 180, m_spread: 1, m_tone: 200, m_decay: 0.3,
      n_level: 0.5, n_filter: 1, n_cut: 800, n_reso: 0.6, n_decay: 0.3, c_level: 0.4, drive: 9, crush: 0.45 } },
];

/** 808 cymbal oscillator ratios (relative to the lowest). */
const METAL_RATIOS = [1, 1.4471, 1.617, 1.9265, 2.5028, 2.6637];
const TWO_PI = Math.PI * 2;
const BURST_GAP = 0.011; // seconds between clap bursts

export class Drum implements Instrument {
  readonly params = DRUM_PARAMS;
  private readonly sr: number;
  private readonly noise = new Noise(0x5eed);
  private readonly mFilter = new Svf();
  private readonly nFilter = new Svf();
  private readonly cFilter = new Svf();

  // Parameter values
  private tLevel = 0.9; private tPitch = 50; private tSweep = 24; private tDrive = 1; private tWave = 0;
  private cLevel = 0.3;
  private drive = 1; private crush = 0;
  private mLevel = 0; private mPitch = 400; private mSpread = 1; private mMode = 0;
  private nLevel = 0; private nCut = 5000; private nReso = 0.2; private nFilterMode = 1; private nBurst = 0;
  private tDecayMul = 0; private sweepMul = 0; private mDecayMul = 0; private nDecayMul = 0; private cDecayMul = 0;

  // Voice state
  private tPhase = 0; private tEnv = 0; private sweepEnv = 0;
  private readonly mPhase = new Float64Array(6);
  private mEnv = 0; private nEnv = 0; private cEnv = 0;
  private velocity = 1;
  private burstLeft = 0; private burstTimer = 0;
  private holdCount = 0; private held = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    for (const p of DRUM_PARAMS) this.setParam(p.id, p.defaultValue);
  }

  noteOn(_note: number, velocity: number, _group: number): void {
    this.velocity = velocity;
    this.tPhase = 0;
    this.tEnv = 1;
    this.sweepEnv = 1;
    this.mEnv = 1;
    this.nEnv = 1;
    this.cEnv = 1;
    this.burstLeft = this.nBurst; // extra bursts after the first
    this.burstTimer = Math.round(BURST_GAP * this.sr);
  }

  noteOff(_group: number): void {}

  setParam(id: string, v: number): void {
    const sr = this.sr;
    switch (id) {
      case 't_level': this.tLevel = v; break;
      case 't_pitch': this.tPitch = v; break;
      case 't_sweep': this.tSweep = v; break;
      case 't_stime': this.sweepMul = decayMul(v, sr); break;
      case 't_decay': this.tDecayMul = decayMul(v, sr); break;
      case 't_drive': this.tDrive = v; break;
      case 't_wave': this.tWave = Math.round(v); break;
      case 'c_level': this.cLevel = v; break;
      case 'c_tone': this.cFilter.setup(v, 0.3, sr); break;
      case 'c_len': this.cDecayMul = decayMul(v, sr); break;
      case 'drive': this.drive = v; break;
      case 'crush': this.crush = v; break;
      case 'm_level': this.mLevel = v; break;
      case 'm_pitch': this.mPitch = v; break;
      case 'm_spread': this.mSpread = v; break;
      case 'm_tone': this.mFilter.setup(v, 0.3, sr); break;
      case 'm_decay': this.mDecayMul = decayMul(v, sr); break;
      case 'm_mode': this.mMode = Math.round(v); break;
      case 'n_level': this.nLevel = v; break;
      case 'n_cut': this.nCut = v; this.nFilter.setup(this.nCut, this.nReso, sr); break;
      case 'n_reso': this.nReso = v; this.nFilter.setup(this.nCut, this.nReso, sr); break;
      case 'n_decay': this.nDecayMul = decayMul(v, sr); break;
      case 'n_filter': this.nFilterMode = Math.round(v); break;
      case 'n_burst': this.nBurst = Math.round(v); break;
    }
  }

  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    if (this.tEnv + this.mEnv + this.nEnv + this.cEnv === 0) return;
    const sr = this.sr;
    const dtBase = 1 / sr;
    // Crush: sample-and-hold length and bit depth.
    const hold = 1 + Math.floor(this.crush * this.crush * 24);
    const levels = Math.pow(2, 16 - this.crush * 12);
    const driveNorm = this.drive > 1 ? 1 / Math.tanh(Math.min(this.drive, 3)) : 1;

    for (let i = start; i < end; i++) {
      let sum = 0;

      // TONE
      if (this.tEnv > 0) {
        const f = this.tPitch * Math.pow(2, (this.tSweep * this.sweepEnv) / 12);
        this.tPhase += f * dtBase;
        if (this.tPhase >= 1) this.tPhase -= 1;
        const ph = this.tPhase;
        const dt = f * dtBase;
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
        if (this.tDrive > 1) osc = Math.tanh(osc * this.tDrive);
        sum += osc * this.tEnv * this.tLevel;
        this.tEnv *= this.tDecayMul;
        this.sweepEnv *= this.sweepMul;
        if (this.tEnv < 1e-5) this.tEnv = 0;
      }

      // METAL
      if (this.mEnv > 0) {
        let m = 0;
        const spread = this.mSpread * 2;
        if (this.mMode === 2) {
          // FM: carrier at pitch, modulator at an inharmonic ratio, index follows the envelope.
          const fc = this.mPitch;
          const fm = this.mPitch * (1 + (METAL_RATIOS[3] - 1) * spread);
          this.mPhase[0] += fc * dtBase; if (this.mPhase[0] >= 1) this.mPhase[0] -= 1;
          this.mPhase[1] += fm * dtBase; if (this.mPhase[1] >= 1) this.mPhase[1] -= 1;
          const index = 2 + 6 * this.mEnv;
          m = Math.sin(TWO_PI * this.mPhase[0] + index * Math.sin(TWO_PI * this.mPhase[1]));
        } else {
          for (let k = 0; k < 6; k++) {
            const f = this.mPitch * (1 + (METAL_RATIOS[k] - 1) * spread);
            this.mPhase[k] += f * dtBase; if (this.mPhase[k] >= 1) this.mPhase[k] -= 1;
          }
          const ph = this.mPhase;
          const s0 = ph[0] < 0.5 ? 1 : -1, s1 = ph[1] < 0.5 ? 1 : -1, s2 = ph[2] < 0.5 ? 1 : -1;
          const s3 = ph[3] < 0.5 ? 1 : -1, s4 = ph[4] < 0.5 ? 1 : -1, s5 = ph[5] < 0.5 ? 1 : -1;
          m = this.mMode === 1
            ? (s0 * s1 + s2 * s3 + s4 * s5) / 3
            : (s0 + s1 + s2 + s3 + s4 + s5) / 6;
        }
        this.mFilter.process(m);
        sum += this.mFilter.high * this.mEnv * this.mLevel;
        this.mEnv *= this.mDecayMul;
        if (this.mEnv < 1e-5) this.mEnv = 0;
      }

      // NOISE
      if (this.nEnv > 0) {
        this.nFilter.process(this.noise.next());
        const n = this.nFilterMode === 0 ? this.nFilter.low : this.nFilterMode === 1 ? this.nFilter.band * 2 : this.nFilter.high;
        sum += n * this.nEnv * this.nLevel;
        this.nEnv *= this.nDecayMul;
        if (this.burstLeft > 0 && --this.burstTimer <= 0) {
          this.nEnv = 1;
          this.burstLeft--;
          this.burstTimer = Math.round(BURST_GAP * sr);
        }
        if (this.nEnv < 1e-5 && this.burstLeft === 0) this.nEnv = 0;
      }

      // CLICK
      if (this.cEnv > 0) {
        this.cFilter.process(this.noise.next() + (this.cEnv === 1 ? 4 : 0));
        sum += this.cFilter.band * this.cEnv * this.cLevel * 2;
        this.cEnv *= this.cDecayMul;
        if (this.cEnv < 1e-5) this.cEnv = 0;
      }

      // Master: drive then crush.
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
