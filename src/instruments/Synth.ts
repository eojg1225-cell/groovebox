import type { Instrument, Preset } from './Instrument';
import { choice, type ParamSpec } from '../engine/params';
import { decayMul, midiToHz, polyBlep, Svf } from './dsp';
import { INTENSITY, TIMBRE } from './macroParams';
import { MACROS } from './macros';

/**
 * Polyphonic synth (6 voices) for basses, pads and leads.
 * Per voice: two detunable oscillators with a continuous SHAPE (sine -> triangle -> saw
 * -> square), an FM pair (sine carrier, sine modulator at FM RATIO, index following the
 * filter envelope) blended in by FM, a sine sub -> resonant low-pass with its own decay
 * envelope -> amp ADSR -> drive, then CRUSH on the summed output. MONO uses one voice
 * with glide. Ranges go far past "sensible" on purpose.
 */

/** Legacy stepped wave (saves before SHAPE): SAW, SQR, TRI, SINE -> shape position. */
const LEGACY_WAVE_TO_SHAPE = [2, 3, 1, 0];
const VOICE_MODES = ['POLY', 'MONO'] as const;
const OCTAVES = ['-2', '-1', '0', '+1', '+2'] as const;
const MAX_VOICES = 6;
/** Glide time of a SLIDE when the sound's own GLIDE is (near) zero. */
const SLIDE_SECONDS = 0.06;
const FILTER_UPDATE = 16;

export const SYNTH_PARAMS: readonly ParamSpec[] = [
  TIMBRE,
  INTENSITY,
  { id: 'shape', name: 'SHAPE', min: 0, max: 3, defaultValue: 2, unit: '', curve: 'linear' },
  { id: 'fm', name: 'FM', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'fmratio', name: 'FM RATIO', min: 0.25, max: 16, defaultValue: 2, unit: '', curve: 'exp', decimals: 2 },
  { id: 'detune', name: 'DETUNE', min: 0, max: 4, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'sub', name: 'SUB', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  choice('octave', 'OCTAVE', OCTAVES, 2),
  choice('voice', 'VOICES', VOICE_MODES),
  { id: 'glide', name: 'GLIDE', min: 0, max: 3, defaultValue: 0, unit: 'S', curve: 'linear' },
  { id: 'cutoff', name: 'FILTER', min: 20, max: 20000, defaultValue: 1200, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'reso', name: 'RESO', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'fenv', name: 'FLT ENV', min: 0, max: 2, defaultValue: 0.4, unit: '', curve: 'linear' },
  { id: 'fdecay', name: 'FLT DEC', min: 0.002, max: 10, defaultValue: 0.3, unit: 'S', curve: 'exp' },
  { id: 'drive', name: 'DRIVE', min: 1, max: 100, defaultValue: 1, unit: 'X', curve: 'exp', decimals: 1 },
  { id: 'crush', name: 'CRUSH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'level', name: 'LEVEL', min: 0, max: 1.5, defaultValue: 0.7, unit: '', curve: 'linear' },
  { id: 'attack', name: 'ATTACK', min: 0.0005, max: 10, defaultValue: 0.003, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'decay', name: 'DECAY', min: 0.005, max: 20, defaultValue: 0.4, unit: 'S', curve: 'exp' },
  { id: 'sustain', name: 'SUSTAIN', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'release', name: 'RELEASE', min: 0.005, max: 20, defaultValue: 0.15, unit: 'S', curve: 'exp' },
];

const BY_ID: Record<string, ParamSpec> = Object.fromEntries(SYNTH_PARAMS.map((p) => [p.id, p]));

function synthParams(ids: string[], defaults: Record<string, number>): ParamSpec[] {
  return ids.map((id) => ({ ...BY_ID[id], defaultValue: defaults[id] ?? BY_ID[id].defaultValue }));
}

/**
 * Three synth tracks share the engine with different controls: BASS (mono, glide),
 * PAD (polyphonic, chords) and LEAD (mono, glide). Each type's parameters are all set by
 * TIMBRE / INTENSITY; settings outside the list are fixed (*_FIXED).
 */
const MORPHED = ['timbre', 'intensity', 'shape', 'fm', 'fmratio', 'detune', 'cutoff', 'reso', 'fenv', 'fdecay', 'drive'];

const ENVELOPE = ['attack', 'decay', 'sustain', 'release', 'crush', 'level'];
export const BASS_PARAMS = synthParams([...MORPHED, 'sub', 'octave', 'glide', ...ENVELOPE], { attack: 0.002, release: 0.06, level: 0.75 });
export const BASS_FIXED = { voice: 1 };
export const PAD_PARAMS = synthParams([...MORPHED, 'octave', ...ENVELOPE], { attack: 0.45, release: 1.2, level: 0.5 });
export const PAD_FIXED = { voice: 0, glide: 0, sub: 0 };
export const LEAD_PARAMS = synthParams([...MORPHED, 'octave', 'glide', ...ENVELOPE], { octave: 3, level: 0.55 });
export const LEAD_FIXED = { voice: 1, sub: 0 };

/**
 * Second sound pages (12 slots, top row then bottom row): oscillators on top, then glide /
 * filter envelope / the rest of the amp envelope / level. The pad has CHORD instead of
 * glide ("track:chord" is a track setting).
 */
export const BASS_DETAIL = ['shape', 'fm', 'fmratio', 'detune', 'sub', 'octave', 'glide', 'fenv', 'fdecay', 'sustain', 'release', 'level'];
export const PAD_DETAIL = ['shape', 'fm', 'fmratio', 'detune', null, 'octave', 'track:chord', 'fenv', 'fdecay', 'sustain', 'release', 'level'];
export const LEAD_DETAIL = ['shape', 'fm', 'fmratio', 'detune', null, 'octave', 'glide', 'fenv', 'fdecay', 'sustain', 'release', 'level'];

/** Presets = the named TIMBRE points (intensity in the middle). */
function anchorPresets(kind: 'bass' | 'pad' | 'lead'): Preset[] {
  const anchors = MACROS[kind].anchors;
  return anchors.map((a, i) => ({ name: a.name, values: { timbre: i / (anchors.length - 1), intensity: 0.5 } }));
}
export const BASS_PRESETS: readonly Preset[] = anchorPresets('bass');
export const PAD_PRESETS: readonly Preset[] = anchorPresets('pad');
export const LEAD_PRESETS: readonly Preset[] = anchorPresets('lead');

const STAGE_OFF = 0, STAGE_ATTACK = 1, STAGE_DECAY = 2, STAGE_SUSTAIN = 3, STAGE_RELEASE = 4;

class Voice {
  note = 0;
  group = -1;
  freq = 110;
  targetFreq = 110;
  velocity = 1;
  /** Pitch glide coefficient in use (GLIDE for mono notes, the slide time for slides). */
  glide = 1;
  p1 = 0; p2 = 0; p3 = 0; p4 = 0;
  stage = STAGE_OFF;
  amp = 0;
  fenv = 0;
  age = 0;
  counter = 0;
  readonly filter = new Svf();
}

export class Synth implements Instrument {
  private readonly sr: number;
  private readonly voices: Voice[] = [];
  private shape = 2; private fm = 0; private fmRatio = 2; private detune = 0; private sub = 0; private octave = 0; private mono = false;
  private glideCoeff = 1;
  private slideCoeff = 1;
  private cutoff = 1200; private reso = 0.3; private fenvAmt = 0.4; private fdecayMul = 0;
  private drive = 1; private crush = 0; private level = 0.7;
  private holdCount = 0; private held = 0;
  private attackInc = 1; private decayMul = 0; private sustain = 0.5; private releaseMul = 0;
  private ageCounter = 0;
  private pitchMod = 1;

  constructor(sampleRate: number, readonly params: readonly ParamSpec[], fixed: Record<string, number>) {
    this.sr = sampleRate;
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    for (const p of SYNTH_PARAMS) this.setParam(p.id, p.defaultValue);
    for (const id in fixed) this.setParam(id, fixed[id]);
    for (const p of params) this.setParam(p.id, p.defaultValue);
  }

  noteOn(note: number, velocity: number, group: number, _ring = false, slideFrom = -1): void {
    const n = note + this.octave * 12;
    const freq = midiToHz(n);
    if (slideFrom >= 0) {
      // Legato: the oldest still-held voice of that group glides here, envelopes untouched.
      let s: Voice | null = null;
      const count = this.mono ? 1 : MAX_VOICES;
      for (let i = 0; i < count; i++) {
        const c = this.voices[i];
        if (c.group === slideFrom && c.stage !== STAGE_OFF && c.stage !== STAGE_RELEASE && (!s || c.age < s.age)) s = c;
      }
      if (s) {
        s.note = note;
        s.group = group;
        s.targetFreq = freq;
        s.glide = this.slideCoeff;
        s.velocity = velocity;
        return;
      }
    }
    let v: Voice;
    if (this.mono) {
      v = this.voices[0];
      if (v.stage === STAGE_OFF) v.freq = freq;
    } else {
      v = this.allocate();
      v.freq = freq;
    }
    v.note = note;
    v.group = group;
    v.targetFreq = freq;
    v.glide = this.glideCoeff;
    v.velocity = velocity;
    v.stage = STAGE_ATTACK;
    v.fenv = 1;
    v.age = ++this.ageCounter;
    v.counter = 0;
  }

  setPitchMod(semitones: number): void {
    this.pitchMod = semitones === 0 ? 1 : Math.pow(2, semitones / 12);
  }

  noteOff(group: number): void {
    for (const v of this.voices) {
      if (v.stage !== STAGE_OFF && v.stage !== STAGE_RELEASE && (group < 0 || v.group === group)) v.stage = STAGE_RELEASE;
    }
  }

  setParam(id: string, value: number): void {
    const sr = this.sr;
    switch (id) {
      case 'shape': this.shape = Math.min(3, Math.max(0, value)); break;
      case 'wave': this.shape = LEGACY_WAVE_TO_SHAPE[Math.round(value)] ?? 2; break; // old saves
      case 'fm': this.fm = value; break;
      case 'fmratio': this.fmRatio = value; break;
      case 'detune': this.detune = value; break;
      case 'sub': this.sub = value; break;
      case 'octave': this.octave = Math.round(value) - 2; break;
      case 'voice':
        this.mono = Math.round(value) === 1;
        if (this.mono) for (let i = 1; i < MAX_VOICES; i++) this.voices[i].stage = STAGE_OFF;
        break;
      case 'glide':
        this.glideCoeff = value <= 0.001 ? 1 : 1 - Math.exp(-1 / (value * sr));
        this.slideCoeff = 1 - Math.exp(-1 / (Math.max(value, SLIDE_SECONDS) * sr));
        break;
      case 'cutoff': this.cutoff = value; break;
      case 'reso': this.reso = value; break;
      case 'fenv': this.fenvAmt = value; break;
      case 'fdecay': this.fdecayMul = decayMul(value, sr); break;
      case 'drive': this.drive = value; break;
      case 'crush': this.crush = value; break;
      case 'level': this.level = value; break;
      case 'attack': this.attackInc = 1 / (value * sr); break;
      case 'decay': this.decayMul = decayMul(value, sr); break;
      case 'sustain': this.sustain = value; break;
      case 'release': this.releaseMul = decayMul(value, sr); break;
    }
  }

  /**
   * Renders into outL/outR[start, end). The engine hands each instrument its own zeroed
   * buffer, so CRUSH can work on the summed voices in place.
   */
  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    this.renderVoices(outL, outR, start, end);
    if (this.crush <= 0) return;
    const hold = 1 + Math.floor(this.crush * this.crush * 24);
    const levels = Math.pow(2, 16 - this.crush * 12);
    for (let i = start; i < end; i++) {
      if (this.holdCount <= 0) {
        this.held = Math.round(outL[i] * levels) / levels;
        this.holdCount = hold;
      }
      this.holdCount--;
      outL[i] = this.held;
      outR[i] = this.held;
    }
  }

  private renderVoices(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    const sr = this.sr;
    const det = Math.pow(2, (this.detune * 0.35) / 12); // up to ~35 cents apart
    const driveNorm = this.drive > 1 ? 1 / Math.tanh(Math.min(this.drive, 3)) : 1;
    const count = this.mono ? 1 : MAX_VOICES;
    for (let vi = 0; vi < count; vi++) {
      const v = this.voices[vi];
      if (v.stage === STAGE_OFF) continue;
      for (let i = start; i < end; i++) {
        if (v.freq !== v.targetFreq) {
          v.freq += (v.targetFreq - v.freq) * v.glide;
          if (Math.abs(v.targetFreq - v.freq) < 1e-3) v.freq = v.targetFreq;
        }
        const dt1 = (v.freq * this.pitchMod) / sr;
        const dt2 = dt1 * det;
        v.p1 += dt1; if (v.p1 >= 1) v.p1 -= 1;
        v.p2 += dt2; if (v.p2 >= 1) v.p2 -= 1;
        v.p3 += dt1 * 0.5; if (v.p3 >= 1) v.p3 -= 1;
        let osc = this.osc(v.p1, dt1);
        if (this.detune > 0) osc = (osc + this.osc(v.p2, dt2)) * 0.6;
        if (this.fm > 0) {
          // FM pair: the index rises with FM and with the filter envelope (a struck clang).
          v.p4 += dt1 * this.fmRatio; if (v.p4 >= 1) v.p4 -= 1;
          const index = this.fm * (0.5 + 4.5 * v.fenv);
          const fmOut = Math.sin(2 * Math.PI * v.p1 + index * Math.sin(2 * Math.PI * v.p4));
          osc = osc * (1 - this.fm) + fmOut * this.fm;
        }
        osc += Math.sin(2 * Math.PI * v.p3) * this.sub;

        if (v.counter-- <= 0) {
          v.counter = FILTER_UPDATE;
          v.filter.setup(this.cutoff * Math.pow(2, this.fenvAmt * 6 * v.fenv), this.reso, sr);
        }
        v.filter.process(osc);

        // Amp ADSR
        switch (v.stage) {
          case STAGE_ATTACK:
            v.amp += this.attackInc;
            if (v.amp >= 1) { v.amp = 1; v.stage = STAGE_DECAY; }
            break;
          case STAGE_DECAY:
            v.amp = this.sustain + (v.amp - this.sustain) * this.decayMul;
            if (v.amp - this.sustain < 1e-4) v.stage = STAGE_SUSTAIN;
            break;
          case STAGE_SUSTAIN:
            v.amp = this.sustain;
            break;
          case STAGE_RELEASE:
            v.amp *= this.releaseMul;
            break;
        }
        v.fenv *= this.fdecayMul;

        let out = v.filter.low * v.amp * v.velocity * this.level;
        if (this.drive > 1) out = Math.tanh(out * this.drive) * driveNorm;
        outL[i] += out;
        outR[i] += out;
      }
      if ((v.stage === STAGE_RELEASE || (v.stage === STAGE_SUSTAIN && this.sustain === 0)) && v.amp < 1e-5) {
        v.stage = STAGE_OFF;
        v.amp = 0;
        v.filter.reset();
      }
    }
  }

  /** Continuous shape: crossfade between the two neighbouring waves. */
  private osc(phase: number, dt: number): number {
    const s = this.shape;
    const i = Math.min(2, Math.floor(s));
    const f = s - i;
    const a = this.wave(i, phase, dt);
    return f > 0 ? a + (this.wave(i + 1, phase, dt) - a) * f : a;
  }

  /** 0 sine, 1 triangle, 2 saw, 3 square (band-limited saw/square). */
  private wave(w: number, phase: number, dt: number): number {
    switch (w) {
      case 0: return Math.sin(2 * Math.PI * phase);
      case 1: return 4 * Math.abs(phase - 0.5) - 1;
      case 2: return 2 * phase - 1 - polyBlep(phase, dt);
      default: {
        let p2 = phase + 0.5; if (p2 >= 1) p2 -= 1;
        return (phase < 0.5 ? 1 : -1) + polyBlep(phase, dt) - polyBlep(p2, dt);
      }
    }
  }

  /** Free voice, else the oldest one. */
  private allocate(): Voice {
    let oldest = this.voices[0];
    for (const v of this.voices) {
      if (v.stage === STAGE_OFF) return v;
      if (v.age < oldest.age) oldest = v;
    }
    return oldest;
  }
}
