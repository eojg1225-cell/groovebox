import type { Instrument, Preset } from './Instrument';
import { choice, type ParamSpec } from '../engine/params';
import { decayMul, midiToHz, polyBlep, Svf } from './dsp';

/**
 * Polyphonic virtual-analog synth (6 voices) for basses, reeses, stabs, pads and chords.
 * Per voice: two detunable oscillators + sine sub -> resonant low-pass with its own decay
 * envelope -> amp ADSR -> drive. MONO mode uses one voice with glide.
 */

const WAVES = ['SAW', 'SQR', 'TRI', 'SINE'] as const;
const VOICE_MODES = ['POLY', 'MONO'] as const;
const OCTAVES = ['-2', '-1', '0', '+1', '+2'] as const;
const MAX_VOICES = 6;
const FILTER_UPDATE = 16;

export const SYNTH_PARAMS: readonly ParamSpec[] = [
  choice('wave', 'WAVE', WAVES),
  { id: 'detune', name: 'DETUNE', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'sub', name: 'SUB', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  choice('octave', 'OCTAVE', OCTAVES, 2),
  choice('voice', 'VOICES', VOICE_MODES),
  { id: 'glide', name: 'GLIDE', min: 0, max: 0.5, defaultValue: 0, unit: 'S', curve: 'linear' },
  { id: 'cutoff', name: 'CUTOFF', min: 40, max: 12000, defaultValue: 1200, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'reso', name: 'RESO', min: 0, max: 0.95, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'fenv', name: 'FLT ENV', min: 0, max: 1, defaultValue: 0.4, unit: '', curve: 'linear' },
  { id: 'fdecay', name: 'FLT DEC', min: 0.01, max: 3, defaultValue: 0.3, unit: 'S', curve: 'exp' },
  { id: 'drive', name: 'DRIVE', min: 1, max: 10, defaultValue: 1, unit: 'X', curve: 'exp', decimals: 1 },
  { id: 'level', name: 'LEVEL', min: 0, max: 1, defaultValue: 0.7, unit: '', curve: 'linear' },
  { id: 'attack', name: 'ATTACK', min: 0.001, max: 3, defaultValue: 0.003, unit: 'S', curve: 'exp', decimals: 3 },
  { id: 'decay', name: 'DECAY', min: 0.01, max: 4, defaultValue: 0.4, unit: 'S', curve: 'exp' },
  { id: 'sustain', name: 'SUSTAIN', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'release', name: 'RELEASE', min: 0.01, max: 4, defaultValue: 0.15, unit: 'S', curve: 'exp' },
];

export const SYNTH_PAGES = [
  { name: 'OSC+FILTER', ids: ['wave', 'detune', 'sub', 'octave', 'voice', 'glide', 'cutoff', 'reso', 'fenv', 'fdecay', 'drive', 'level'] },
  { name: 'ENVELOPE', ids: ['attack', 'decay', 'sustain', 'release'] },
];

export const SYNTH_PRESETS: readonly Preset[] = [
  { name: 'BASS', live: ['cutoff', 'fenv'],
    values: { wave: 0, sub: 0.35, voice: 1, octave: 2, cutoff: 380, reso: 0.55, fenv: 0.5, fdecay: 0.25, attack: 0.002, decay: 0.3, sustain: 0.2, release: 0.06, level: 0.75 } },
  { name: 'REESE', live: ['cutoff', 'detune'],
    values: { wave: 0, detune: 0.7, sub: 0.5, voice: 1, glide: 0.04, cutoff: 650, reso: 0.2, fenv: 0.1, fdecay: 0.5, attack: 0.005, decay: 1, sustain: 1, release: 0.12, drive: 2, level: 0.7 } },
  { name: 'SUB', live: ['decay', 'drive'],
    values: { wave: 3, voice: 1, cutoff: 2000, reso: 0, fenv: 0, attack: 0.003, decay: 0.6, sustain: 0.8, release: 0.1, level: 0.85 } },
  { name: 'STAB', live: ['cutoff', 'decay'],
    values: { wave: 0, detune: 0.3, voice: 0, octave: 2, cutoff: 1500, reso: 0.3, fenv: 0.45, fdecay: 0.18, attack: 0.002, decay: 0.35, sustain: 0.15, release: 0.25, level: 0.55 } },
  { name: 'PAD', live: ['cutoff', 'release'],
    values: { wave: 0, detune: 0.5, voice: 0, cutoff: 1100, reso: 0.15, fenv: 0.1, fdecay: 1, attack: 0.45, decay: 1.2, sustain: 0.8, release: 1.2, level: 0.5 } },
];

const STAGE_OFF = 0, STAGE_ATTACK = 1, STAGE_DECAY = 2, STAGE_SUSTAIN = 3, STAGE_RELEASE = 4;

class Voice {
  note = 0;
  group = -1;
  freq = 110;
  targetFreq = 110;
  velocity = 1;
  p1 = 0; p2 = 0; p3 = 0;
  stage = STAGE_OFF;
  amp = 0;
  fenv = 0;
  age = 0;
  counter = 0;
  readonly filter = new Svf();
}

export class Synth implements Instrument {
  readonly params = SYNTH_PARAMS;
  private readonly sr: number;
  private readonly voices: Voice[] = [];
  private wave = 0; private detune = 0; private sub = 0; private octave = 0; private mono = false;
  private glideCoeff = 1;
  private cutoff = 1200; private reso = 0.3; private fenvAmt = 0.4; private fdecayMul = 0;
  private drive = 1; private level = 0.7;
  private attackInc = 1; private decayMul = 0; private sustain = 0.5; private releaseMul = 0;
  private ageCounter = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    for (const p of SYNTH_PARAMS) this.setParam(p.id, p.defaultValue);
  }

  noteOn(note: number, velocity: number, group: number): void {
    const n = note + this.octave * 12;
    const freq = midiToHz(n);
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
    v.velocity = velocity;
    v.stage = STAGE_ATTACK;
    v.fenv = 1;
    v.age = ++this.ageCounter;
    v.counter = 0;
  }

  noteOff(group: number): void {
    for (const v of this.voices) {
      if (v.stage !== STAGE_OFF && v.stage !== STAGE_RELEASE && (group < 0 || v.group === group)) v.stage = STAGE_RELEASE;
    }
  }

  setParam(id: string, value: number): void {
    const sr = this.sr;
    switch (id) {
      case 'wave': this.wave = Math.round(value); break;
      case 'detune': this.detune = value; break;
      case 'sub': this.sub = value; break;
      case 'octave': this.octave = Math.round(value) - 2; break;
      case 'voice':
        this.mono = Math.round(value) === 1;
        if (this.mono) for (let i = 1; i < MAX_VOICES; i++) this.voices[i].stage = STAGE_OFF;
        break;
      case 'glide': this.glideCoeff = value <= 0.001 ? 1 : 1 - Math.exp(-1 / (value * sr)); break;
      case 'cutoff': this.cutoff = value; break;
      case 'reso': this.reso = value; break;
      case 'fenv': this.fenvAmt = value; break;
      case 'fdecay': this.fdecayMul = decayMul(value, sr); break;
      case 'drive': this.drive = value; break;
      case 'level': this.level = value; break;
      case 'attack': this.attackInc = 1 / (value * sr); break;
      case 'decay': this.decayMul = decayMul(value, sr); break;
      case 'sustain': this.sustain = value; break;
      case 'release': this.releaseMul = decayMul(value, sr); break;
    }
  }

  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    const sr = this.sr;
    const det = Math.pow(2, (this.detune * 0.35) / 12); // up to ~35 cents apart
    const driveNorm = this.drive > 1 ? 1 / Math.tanh(Math.min(this.drive, 3)) : 1;
    const count = this.mono ? 1 : MAX_VOICES;
    for (let vi = 0; vi < count; vi++) {
      const v = this.voices[vi];
      if (v.stage === STAGE_OFF) continue;
      for (let i = start; i < end; i++) {
        if (v.freq !== v.targetFreq) v.freq += (v.targetFreq - v.freq) * this.glideCoeff;
        const dt1 = v.freq / sr;
        const dt2 = dt1 * det;
        v.p1 += dt1; if (v.p1 >= 1) v.p1 -= 1;
        v.p2 += dt2; if (v.p2 >= 1) v.p2 -= 1;
        v.p3 += dt1 * 0.5; if (v.p3 >= 1) v.p3 -= 1;
        let osc = this.osc(v.p1, dt1);
        if (this.detune > 0) osc = (osc + this.osc(v.p2, dt2)) * 0.6;
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

  private osc(phase: number, dt: number): number {
    switch (this.wave) {
      case 1: {
        let p2 = phase + 0.5; if (p2 >= 1) p2 -= 1;
        return (phase < 0.5 ? 1 : -1) + polyBlep(phase, dt) - polyBlep(p2, dt);
      }
      case 2: return 4 * Math.abs(phase - 0.5) - 1;
      case 3: return Math.sin(2 * Math.PI * phase);
      default: return 2 * phase - 1 - polyBlep(phase, dt);
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
