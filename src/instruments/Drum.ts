import type { Instrument, Preset } from './Instrument';
import { choice, type ParamSpec } from '../engine/params';
import { decayMul, Noise, polyBlep, Svf } from './dsp';
import { INTENSITY, TIMBRE } from './macroParams';
import { MACROS } from './macros';

/**
 * Drum voice built from layers. Each drum type uses two of them (its two "elements"):
 *   KICK  = TONE + CLICK      SNARE = TONE + METAL      HAT = CLICK + METAL
 *   PERC  = TONE + CLICK (+ METAL for bells): toms, congas, cowbell, clave; pitched from the
 *           sequencer (step entry on the keyboard)
 *  TONE   pitched oscillator with an exponential pitch sweep
 *  CLICK  very short transient (impulse/noise blend) through a resonant band-pass
 *  METAL  six inharmonic oscillators (square bank, ring-mod pairs or FM) blended with
 *         noise (snare wires, hat sizzle), through a high-pass
 * HAT only: the metal starts as its HEAD sound (a hat, or a ride bell at the far left of
 * TIMBRE) and morphs over HEAD time into its tail (the M ... settings), so short hits
 * stay hats and the tail decides the cymbal.
 * RING (the sequencer's sustain) stretches each layer's own decay x RING_STRETCH and adds
 * RING LEN seconds (tone and metal; the click only stretches), so ring tails follow the
 * DECAY knobs.
 * Each layer has its own ATTACK and DECAY. Then a resonant low-pass FILTER with its own
 * envelope (ATTACK, DECAY, ENV amount), DRIVE (tanh) and CRUSH (bit + sample-rate
 * reduction). Ranges go far past "sensible" on purpose.
 * The played note tunes the pitched layers (36 = as designed), so drums play chromatically.
 */

const T_WAVES = ['SINE', 'TRI', 'SAW', 'SQR'];
const ATTACK = { min: 0.0005, max: 2, defaultValue: 0.0005, unit: 'S', curve: 'exp', decimals: 4 } as const;

/**
 * ROLL DIV: hits per step of a ROLL step (the SLIDE button is ROLL on drum tracks), named
 * as note values at 16th-note steps.
 */
export const ROLL_DIVS = [
  { name: '1/32', hits: 2 }, { name: '1/32T', hits: 3 }, { name: '1/64', hits: 4 }, { name: '1/64T', hits: 6 }, { name: '1/128', hits: 8 },
] as const;

/** Every drum parameter; each drum type exposes a subset with its own defaults. */
const ALL: Record<string, ParamSpec> = Object.fromEntries(([
  TIMBRE,
  INTENSITY,
  { id: 't_level', name: 'TONE', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 't_pitch', name: 'PITCH', min: 10, max: 5000, defaultValue: 50, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 't_sweep', name: 'SWEEP', min: 0, max: 96, defaultValue: 24, unit: 'ST', curve: 'linear', decimals: 0 },
  { id: 't_stime', name: 'SWP TIME', min: 0.001, max: 2, defaultValue: 0.04, unit: 'S', curve: 'exp', decimals: 3 },
  { id: 't_attack', name: 'TONE ATK', ...ATTACK },
  { id: 't_decay', name: 'TONE DEC', min: 0.005, max: 20, defaultValue: 0.45, unit: 'S', curve: 'exp' },
  choice('t_wave', 'WAVE', T_WAVES),
  { id: 'c_level', name: 'CLICK', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'c_tone', name: 'CLK TONE', min: 100, max: 20000, defaultValue: 4000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'c_attack', name: 'CLK ATK', ...ATTACK },
  { id: 'c_len', name: 'CLK DEC', min: 0.0002, max: 0.5, defaultValue: 0.004, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'c_reso', name: 'CLK RESO', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'c_noise', name: 'CLK NOISE', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
  { id: 'm_level', name: 'METAL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'm_pitch', name: 'M PITCH', min: 20, max: 12000, defaultValue: 400, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'm_spread', name: 'SPREAD', min: 0, max: 3, defaultValue: 1, unit: '', curve: 'linear' },
  { id: 'm_noise', name: 'NOISE', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'm_tone', name: 'M TONE', min: 30, max: 20000, defaultValue: 6000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'm_attack', name: 'MTL ATK', ...ATTACK },
  { id: 'm_decay', name: 'MTL DEC', min: 0.005, max: 20, defaultValue: 0.2, unit: 'S', curve: 'exp' },
  // Continuous: 0 = square bank, 1 = ring-mod pairs, 2 = FM (blends in between).
  { id: 'm_mode', name: 'M MODE', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'm_fm', name: 'M FM', min: 0, max: 4, defaultValue: 0.5, unit: '', curve: 'linear' },
  // HAT head: what the metal sounds like at the start of the hit, before it becomes the tail.
  { id: 'h_time', name: 'HEAD', min: 0, max: 0.5, defaultValue: 0, unit: 'S', curve: 'linear', decimals: 3 },
  { id: 'h_pitch', name: 'H PITCH', min: 20, max: 12000, defaultValue: 420, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'h_tone', name: 'H TONE', min: 30, max: 20000, defaultValue: 8500, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'h_noise', name: 'H NOISE', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'h_mode', name: 'H MODE', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'h_spread', name: 'H SPREAD', min: 0, max: 3, defaultValue: 1, unit: '', curve: 'linear' },
  // RING (sequencer sustain): seconds added to the decay.
  { id: 'ring', name: 'RING LEN', min: 0, max: 10, defaultValue: 0.6, unit: 'S', curve: 'linear' },
  // Whole drum: these sit on top of TIMBRE / INTENSITY (the macros never move them).
  { id: 'cutoff', name: 'CUTOFF', min: 20, max: 20000, defaultValue: 20000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'reso', name: 'RESO', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'fattack', name: 'FLT ATK', ...ATTACK, max: 10 },
  { id: 'fdecay', name: 'FLT DEC', min: 0.002, max: 10, defaultValue: 0.3, unit: 'S', curve: 'exp' },
  { id: 'fenv', name: 'FLT ENV', min: 0, max: 2, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'drive', name: 'DRIVE', min: 1, max: 200, defaultValue: 1, unit: 'X', curve: 'exp', decimals: 1 },
  { id: 'crush', name: 'CRUSH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // ROLL DIV: how fast a ROLL step repeats (read by the engine; the voice ignores it).
  choice('rolldiv', 'ROLL DIV', ROLL_DIVS.map((r) => r.name), 0),
] as ParamSpec[]).map((p) => [p.id, p]));

/** Build a drum type's parameter list (in knob order) with per-type defaults. */
function drumParams(ids: string[], defaults: Record<string, number>): ParamSpec[] {
  return ids.map((id) => ({ ...ALL[id], defaultValue: defaults[id] ?? ALL[id].defaultValue }));
}

/** Controls every drum has (after its layer parameters). */
const WHOLE = ['ring', 'cutoff', 'reso', 'fattack', 'fdecay', 'fenv', 'drive', 'crush', 'rolldiv'];

/*
 * Each drum type: its parameters (all stored, set by TIMBRE / INTENSITY and presets),
 * and its two elements' ATTACK / DECAY ids (on the SOUND page, see registry). Parameters
 * without a knob are set by TIMBRE / INTENSITY.
 */
export const KICK_PARAMS = drumParams(
  ['timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_stime', 't_attack', 't_decay', 't_wave', 'c_level', 'c_tone', 'c_attack', 'c_len', 'c_reso', 'c_noise', ...WHOLE],
  { t_level: 0.95, t_pitch: 48, t_sweep: 30, t_stime: 0.035, t_decay: 0.5, c_level: 0.25, c_tone: 3500, c_len: 0.003 },
);
export const KICK_ELEMENTS = ['t_attack', 't_decay', 'c_attack', 'c_len'];

export const SNARE_PARAMS = drumParams(
  ['timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_attack', 't_decay', 't_wave', 'm_level', 'm_pitch', 'm_noise', 'm_tone', 'm_attack', 'm_decay', 'm_spread', 'm_mode', 'm_fm', ...WHOLE],
  { t_level: 0.55, t_pitch: 190, t_sweep: 7, t_decay: 0.14, m_level: 0.8, m_noise: 0.85, m_pitch: 330, m_tone: 1800, m_decay: 0.2 },
);
export const SNARE_ELEMENTS = ['t_attack', 't_decay', 'm_attack', 'm_decay'];

export const HAT_PARAMS = drumParams(
  [
    'timbre', 'intensity', 'c_level', 'c_tone', 'c_attack', 'c_len', 'c_reso', 'c_noise', 'm_level', 'm_pitch', 'm_spread', 'm_noise', 'm_tone', 'm_attack', 'm_decay', 'm_mode', 'm_fm',
    'h_time', 'h_pitch', 'h_tone', 'h_noise', 'h_mode', 'h_spread', ...WHOLE,
  ],
  { c_level: 0.2, c_tone: 9000, c_len: 0.002, m_level: 0.6, m_pitch: 420, m_spread: 1, m_noise: 0.3, m_tone: 8500, m_decay: 0.05, h_time: 0.03, ring: 0.5 },
);
export const HAT_ELEMENTS = ['c_attack', 'c_len', 'm_attack', 'm_decay'];

export const PERC_PARAMS = drumParams(
  [
    'timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_stime', 't_attack', 't_decay', 't_wave',
    'c_level', 'c_tone', 'c_attack', 'c_len', 'c_reso', 'c_noise',
    'm_level', 'm_pitch', 'm_spread', 'm_noise', 'm_tone', 'm_attack', 'm_decay', 'm_mode', 'm_fm', ...WHOLE,
  ],
  { t_level: 0.95, t_pitch: 95, t_sweep: 9, t_stime: 0.08, t_decay: 0.5, c_level: 0.3, c_tone: 2200, c_len: 0.004 },
);
export const PERC_ELEMENTS = ['t_attack', 't_decay', 'c_attack', 'c_len'];

/** Presets = the named TIMBRE points (intensity in the middle). */
function anchorPresets(kind: 'kick' | 'snare' | 'hat' | 'perc'): Preset[] {
  const anchors = MACROS[kind].anchors;
  return anchors.map((a, i) => ({ name: a.name, values: { timbre: i / (anchors.length - 1), intensity: 0.5 } }));
}
export const KICK_PRESETS: readonly Preset[] = anchorPresets('kick');
export const SNARE_PRESETS: readonly Preset[] = anchorPresets('snare');
export const HAT_PRESETS: readonly Preset[] = anchorPresets('hat');
export const PERC_PRESETS: readonly Preset[] = anchorPresets('perc');

/** 808 cymbal oscillator ratios (relative to the lowest). */
const METAL_RATIOS = [1, 1.4471, 1.617, 1.9265, 2.5028, 2.6637];
const TWO_PI = Math.PI * 2;
/** RING: each layer's decay x this (plus RING LEN), so longer DECAY knobs mean longer rings. */
const RING_STRETCH = 3;
/** A ringing drum is choked (by the next hit or a rest) with this fade. */
const CHOKE_SECONDS = 0.012;
const FILTER_UPDATE = 16;
const OFF = 0, ATTACKING = 1, DECAYING = 2;

/** Attack increment per sample (0 = instant). */
function attackInc(seconds: number, sr: number): number {
  return seconds <= 0.0006 ? 0 : 1 / (seconds * sr);
}

export class Drum implements Instrument {
  private readonly sr: number;
  private readonly noise = new Noise(0x5eed);
  private readonly mFilter = new Svf();
  private readonly cFilter = new Svf();
  private readonly filter = new Svf();

  // Parameter values (all layers silent unless the drum type sets them)
  private tLevel = 0; private tPitch = 50; private tSweep = 24; private tWave = 0;
  private cLevel = 0; private cTone = 4000; private cReso = 0.3; private cNoise = 0.6;
  private drive = 1; private crush = 0;
  private mLevel = 0; private mPitch = 400; private mSpread = 1; private mNoise = 0.3; private mMode = 0; private mFm = 0.5;
  private fmC = 0; private fmM = 0;
  private tDecayMul = 0; private sweepMul = 0; private mDecayMul = 0; private cDecayMul = 0;
  private tRingMul = 0; private mRingMul = 0; private cRingMul = 0;
  private tDecay = 0.45; private mDecay = 0.2; private cLen = 0.004; private ringLen = 0.6;
  // HAT head -> tail morph: head values, the tail's own tone, and how fast it morphs.
  private hTime = 0; private hMul = 0; private hPitch = 420; private hTone = 8500; private hNoise = 0.3;
  private hMode = 0; private hSpread = 1; private mTone = 6000;
  private hEnv = 0; private hCounter = 0;
  private tAtk = 0; private cAtk = 0; private mAtk = 0;
  private cutoff = 20000; private reso = 0; private filterOn = false;
  private fAtk = 0; private fDecayMul = 0; private fAmount = 0.5;
  private filterMod = 0;
  private readonly chokeMul: number;
  /** Decay multipliers in use for the current hit (normal, ring or choke). */
  private tMul = 0; private mMul = 0; private cMul = 0;
  private ringing = false;

  // Voice state: per layer an envelope value and stage (OFF / ATTACKING / DECAYING).
  private tune = 1;
  private pitchMod = 1;
  private tPhase = 0; private sweepEnv = 0;
  private readonly mPhase = new Float64Array(6);
  private tEnv = 0; private tStage = OFF;
  private mEnv = 0; private mStage = OFF;
  private cEnv = 0; private cStage = OFF;
  private impulse = false;
  private fEnv = 0; private fStage = OFF;
  private fCounter = 0;
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
    this.cMul = ring ? this.cRingMul : this.cDecayMul;
    this.tune = Math.pow(2, (note - 36) / 12);
    this.velocity = velocity;
    this.tPhase = 0;
    this.sweepEnv = 1;
    this.impulse = true;
    // Each layer starts its attack (or at full level when the attack is instant).
    this.tEnv = this.tAtk > 0 ? 0 : 1; this.tStage = this.tAtk > 0 ? ATTACKING : DECAYING;
    this.mEnv = this.mAtk > 0 ? 0 : 1; this.mStage = this.mAtk > 0 ? ATTACKING : DECAYING;
    this.cEnv = this.cAtk > 0 ? 0 : 1; this.cStage = this.cAtk > 0 ? ATTACKING : DECAYING;
    this.fEnv = this.fAtk > 0 ? 0 : 1; this.fStage = this.fAtk > 0 ? ATTACKING : DECAYING;
    this.fCounter = 0;
    this.hEnv = this.hTime > 0 ? 1 : 0;
    this.hCounter = 0;
  }

  /** Only a ringing hit responds: it is choked (closed off quickly). */
  noteOff(_group: number): void {
    if (!this.ringing) return;
    this.ringing = false;
    this.tMul = this.chokeMul;
    this.mMul = this.chokeMul;
    this.cMul = this.chokeMul;
    if (this.tStage === ATTACKING) this.tStage = DECAYING;
    if (this.mStage === ATTACKING) this.mStage = DECAYING;
    if (this.cStage === ATTACKING) this.cStage = DECAYING;
  }

  setPitchMod(semitones: number): void {
    this.pitchMod = semitones === 0 ? 1 : Math.pow(2, semitones / 12);
  }

  setFmMod(_amount: number): void {
    // Drums have no FM level to modulate.
  }

  setFilterMod(octaves: number): void {
    this.filterMod = octaves;
    this.filterOn = this.cutoff < 19990 || this.reso > 0 || octaves !== 0;
  }

  setParam(id: string, v: number): void {
    const sr = this.sr;
    switch (id) {
      case 't_level': this.tLevel = v; break;
      case 't_pitch': this.tPitch = v; break;
      case 't_sweep': this.tSweep = v; break;
      case 't_stime': this.sweepMul = decayMul(v, sr); break;
      case 't_attack': this.tAtk = attackInc(v, sr); break;
      case 't_decay': this.tDecay = v; this.updateDecays(); break;
      case 't_wave': this.tWave = Math.round(v); break;
      case 'c_level': this.cLevel = v; break;
      case 'c_tone': this.cTone = v; this.cFilter.setup(this.cTone, this.cReso, sr); break;
      case 'c_reso': this.cReso = v; this.cFilter.setup(this.cTone, this.cReso, sr); break;
      case 'c_noise': this.cNoise = v; break;
      case 'c_attack': this.cAtk = attackInc(v, sr); break;
      case 'c_len': this.cLen = v; this.updateDecays(); break;
      case 'm_level': this.mLevel = v; break;
      case 'm_pitch': this.mPitch = v; break;
      case 'm_spread': this.mSpread = v; break;
      case 'm_noise': this.mNoise = v; break;
      case 'm_tone': this.mTone = v; this.mFilter.setup(v, 0.3, sr); break;
      case 'm_attack': this.mAtk = attackInc(v, sr); break;
      case 'm_decay': this.mDecay = v; this.updateDecays(); break;
      case 'ring': this.ringLen = v; this.updateDecays(); break;
      case 'h_time': this.hTime = v; this.hMul = v > 0 ? Math.exp(-1 / (v * sr)) : 0; break;
      case 'h_pitch': this.hPitch = v; break;
      case 'h_tone': this.hTone = v; break;
      case 'h_noise': this.hNoise = v; break;
      case 'h_mode': this.hMode = v; break;
      case 'h_spread': this.hSpread = v; break;
      case 'm_mode': this.mMode = Math.min(2, Math.max(0, v)); break;
      case 'm_fm': this.mFm = v; break;
      case 'cutoff': this.cutoff = v; this.setFilterMod(this.filterMod); this.fCounter = 0; break;
      case 'reso': this.reso = v; this.setFilterMod(this.filterMod); this.fCounter = 0; break;
      case 'fattack': this.fAtk = attackInc(v, sr); break;
      case 'fdecay': this.fDecayMul = decayMul(v, sr); break;
      case 'fenv': this.fAmount = v; break;
      case 'drive': this.drive = v; break;
      case 'crush': this.crush = v; break;
    }
  }

  /** Normal decays, and RING ones (decay x RING_STRETCH + RING LEN). */
  private updateDecays(): void {
    const sr = this.sr;
    this.tDecayMul = decayMul(this.tDecay, sr);
    this.mDecayMul = decayMul(this.mDecay, sr);
    this.cDecayMul = decayMul(this.cLen, sr);
    this.tRingMul = decayMul(this.tDecay * RING_STRETCH + this.ringLen, sr);
    this.mRingMul = decayMul(this.mDecay * RING_STRETCH + this.ringLen, sr);
    this.cRingMul = decayMul(this.cLen * RING_STRETCH, sr);
  }

  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    if (this.tStage === OFF && this.mStage === OFF && this.cStage === OFF) return;
    const dtBase = 1 / this.sr;
    const hold = 1 + Math.floor(this.crush * this.crush * 24);
    const levels = Math.pow(2, 16 - this.crush * 12);
    const driveNorm = this.drive > 1 ? 1 / Math.tanh(Math.min(this.drive, 3)) : 1;
    const tPitch = this.tPitch * this.tune * this.pitchMod;
    const tune = this.tune * this.pitchMod;
    // Metal settings in use: the tail's, or (HAT) morphing from the head's.
    let mPitch = this.mPitch * tune;
    let mNoise = this.mNoise;
    let mMode = this.mMode;
    let mSpread = this.mSpread;
    this.hCounter = 0; // refresh the head blend on the first sample

    for (let i = start; i < end; i++) {
      let sum = 0;

      // TONE
      if (this.tStage !== OFF) {
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
        this.sweepEnv *= this.sweepMul;
        if (this.tStage === ATTACKING) {
          this.tEnv += this.tAtk;
          if (this.tEnv >= 1) { this.tEnv = 1; this.tStage = DECAYING; }
        } else {
          this.tEnv *= this.tMul;
          if (this.tEnv < 1e-5) { this.tEnv = 0; this.tStage = OFF; }
        }
      }

      // METAL (+ noise blend). M MODE crossfades square bank -> ring-mod -> FM.
      if (this.mStage !== OFF) {
        if (this.hEnv > 0) {
          this.hEnv *= this.hMul;
          if (this.hEnv < 1e-3) {
            // Head over: the tail's own settings.
            this.hEnv = 0;
            mPitch = this.mPitch * tune; mNoise = this.mNoise; mMode = this.mMode; mSpread = this.mSpread;
            this.mFilter.setup(this.mTone, 0.3, this.sr);
          } else if (this.hCounter-- <= 0) {
            // Head -> tail, refreshed every 16 samples (frequencies blend in log).
            this.hCounter = FILTER_UPDATE;
            const h = this.hEnv;
            mPitch = this.mPitch * Math.pow(this.hPitch / this.mPitch, h) * tune;
            mNoise = this.mNoise + (this.hNoise - this.mNoise) * h;
            mMode = this.mMode + (this.hMode - this.mMode) * h;
            mSpread = this.mSpread + (this.hSpread - this.mSpread) * h;
            this.mFilter.setup(this.mTone * Math.pow(this.hTone / this.mTone, h), 0.3, this.sr);
          }
        }
        const spread = mSpread * 2;
        const mode = mMode;
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
          const index = (0.5 + 9 * this.mFm) * (0.3 + 0.7 * this.mEnv); // M FM 4 = index ~37
          m += wFm * Math.sin(TWO_PI * this.fmC + index * Math.sin(TWO_PI * this.fmM));
        }
        m = m * (1 - mNoise) + this.noise.next() * mNoise;
        this.mFilter.process(m);
        sum += this.mFilter.high * this.mEnv * this.mLevel;
        if (this.mStage === ATTACKING) {
          this.mEnv += this.mAtk;
          if (this.mEnv >= 1) { this.mEnv = 1; this.mStage = DECAYING; }
        } else {
          this.mEnv *= this.mMul;
          if (this.mEnv < 1e-5) { this.mEnv = 0; this.mStage = OFF; }
        }
      }

      // CLICK
      if (this.cStage !== OFF) {
        // Impulse (a "knock" that rings at CLK TONE with RESO) blended with a noise burst.
        this.cFilter.process(this.noise.next() * this.cNoise + (this.impulse ? 4 * (1 - this.cNoise * 0.5) : 0));
        this.impulse = false;
        sum += this.cFilter.band * this.cEnv * this.cLevel * 2;
        if (this.cStage === ATTACKING) {
          this.cEnv += this.cAtk;
          if (this.cEnv >= 1) { this.cEnv = 1; this.cStage = DECAYING; }
        } else {
          this.cEnv *= this.cMul;
          if (this.cEnv < 1e-5) { this.cEnv = 0; this.cStage = OFF; }
        }
      }

      // FILTER (with its envelope), DRIVE, CRUSH
      let out = sum * this.velocity;
      if (this.fStage === ATTACKING) {
        this.fEnv += this.fAtk;
        if (this.fEnv >= 1) { this.fEnv = 1; this.fStage = DECAYING; }
      } else if (this.fStage === DECAYING) {
        this.fEnv *= this.fDecayMul;
        if (this.fEnv < 1e-5) { this.fEnv = 0; this.fStage = OFF; }
      }
      if (this.filterOn) {
        if (this.fCounter-- <= 0) {
          this.fCounter = FILTER_UPDATE;
          const fc = this.cutoff * Math.pow(2, this.fAmount * 6 * this.fEnv + this.filterMod);
          this.filter.setup(fc < 20 ? 20 : fc, this.reso, this.sr);
        }
        this.filter.process(out);
        out = this.filter.low;
      }
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
