import type { Instrument, Preset } from './Instrument';
import { choice, FDECAY_POWER, type ParamSpec } from '../engine/params';
import { decayMul, midiToHz, polyBlep, Svf } from './dsp';
import { INTENSITY, TIMBRE, midFreq } from './macroParams';
import { MACROS } from './macros';
import { driveCompGain } from './driveComp';
import { DELAY_DIVISIONS, Delay } from '../fx/Delay';
import { Reverb } from '../fx/Reverb';

/**
 * Polyphonic synth (6 voices) for basses, pads and leads.
 * Per voice two elements, OSC 1 and OSC 2 (OSC 2 detuned by DETUNE), each with a
 * continuous SHAPE (sine -> triangle -> saw -> square) blended by FM with an FM pair (sine
 * carrier, sine modulator at FM RATIO, index following the filter envelope), and each
 * with its own ATTACK / DECAY / SUSTAIN / RELEASE; a sine sub joins OSC 1. UNISON
 * adds four more detuned copies (two per element, spread by DETUNE) for supersaws. Then a
 * resonant low-pass with its own envelope (ATTACK, DECAY, ENV amount) -> drive, then CRUSH
 * on the summed output. MONO uses one voice with glide. Ranges go far past "sensible" on
 * purpose.
 */

/** Legacy stepped wave (saves before SHAPE): SAW, SQR, TRI, SINE -> shape position. */
const LEGACY_WAVE_TO_SHAPE = [2, 3, 1, 0];
const VOICE_MODES = ['POLY', 'MONO'] as const;
/**
 * ARP: how the held chord (over ARP OCT octaves) is stepped through. CASCADE goes up (or down)
 * in overlapping skips: 1 5 3 7 5 9 ... (or from the top: 11 7 9 5 7 3 ...).
 */
export const ARP_MODES = ['OFF', 'UP', 'DOWN', 'UP/DN', 'CASC UP', 'CASC DN', 'RANDOM'] as const;
/** ARP speeds in 16th steps. */
export const ARP_RATES = [
  { name: '1/4', steps: 4 }, { name: '1/8', steps: 2 }, { name: '1/8T', steps: 4 / 3 },
  { name: '1/16', steps: 1 }, { name: '1/16T', steps: 2 / 3 }, { name: '1/32', steps: 0.5 },
] as const;
const OCTAVES = ['-2', '-1', '0', '+1', '+2'] as const;
const MAX_VOICES = 6;
/** SLIDE time of the sounds without a SLIDE knob (pad, pluck), and the default. */
const SLIDE_SECONDS = 0.06;
/**
 * A slide is one held note: from a SLIDE note to the note it lands on, the envelopes hold at
 * full level (no decay) until that last note is released.
 */
const SLIDE_SUSTAIN = 1;
/** A held note's level follows a new velocity (slide, mono retrigger) over about this long, s. */
const VEL_SMOOTH = 0.004;
/**
 * 3 CARRIER modulation index from FM (0..1) on a DX7-like level curve: like an operator's
 * OUTPUT LEVEL (FM 1 = 99), about 6 dB per 8 levels, so most of the knob is subtle (FM 0.6
 * = level 60, index ~0.45) and the last part goes from tasteful to brutal (index ~13).
 */
const DX7_MAX_INDEX = 13;
export function dx7Index(fm: number): number {
  return fm <= 0 ? 0 : DX7_MAX_INDEX * Math.pow(2, ((fm - 1) * 99) / 8);
}
/** Feedback at FEEDBACK 1 (DX7 feedback 7: just short of noise). */
const MAX_FEEDBACK = 1.6;
/**
 * Carrier 1's feedback at CAR FB 1: a sine carrier ends as a bright saw-like edge, short of
 * the DX7 fizz. On saw / square waves (already bright) only a fifth of it applies.
 */
const MAX_CARRIER_FEEDBACK = 1.3;

/** Phase into 0..1 (modulated phases can leave it by a few cycles). */
function wrap(p: number): number {
  return p - Math.floor(p);
}

/** UNISON copies relative to OSC 1 (x the spread), and their start phases. */
const UNISON_SPREAD = [-1, -0.4, 0.4, 1];
const UNISON_PHASE = [0.13, 0.61, 0.37, 0.89];
const FILTER_UPDATE = 16;

export const SYNTH_PARAMS: readonly ParamSpec[] = [
  TIMBRE,
  INTENSITY,
  { id: 'shape', name: 'SHAPE', min: 0, max: 3, defaultValue: 2, unit: '', curve: 'linear' },
  { id: 'fm', name: 'FM LVL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'fmratio', name: 'FM RATIO', min: 0.25, max: 16, defaultValue: 2, unit: '', curve: 'exp', decimals: 2 },
  { id: 'detune', name: 'DETUNE', min: 0, max: 4, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'sub', name: 'SUB', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'unison', name: 'UNISON', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  // 3 CARRIER algorithm (LEAD): carriers 2 and 3's ratios to carrier 1, and the modulator's
  // self-feedback (FM RATIO is the modulator's ratio). Set by TIMBRE.
  { id: 'ratio2', name: 'RATIO 2', min: 0.25, max: 8, defaultValue: 1, unit: '', curve: 'exp', decimals: 2 },
  { id: 'ratio3', name: 'RATIO 3', min: 0.25, max: 8, defaultValue: 1, unit: '', curve: 'exp', decimals: 2 },
  { id: 'feedback', name: 'FEEDBACK', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // Carrier 1's own feedback (DX7-style: a sine turns saw-like as it rises). Set by INT.
  { id: 'cfeedback', name: 'CAR FB', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // Level of carriers 2 and 3 against carrier 1 (0 = one clear note, 1 = the full stack).
  { id: 'carriers', name: 'CARRIERS', min: 0, max: 1, defaultValue: 0.35, unit: '', curve: 'linear' },
  // ARP (played by the engine, which reads these two): chord / octave notes in turn while held.
  choice('arp', 'ARP', ARP_MODES),
  choice('arprate', 'ARP RATE', ARP_RATES.map((r) => r.name), 3),
  choice('arpoct', 'ARP OCT', ['1 OCT', '2 OCT', '3 OCT']),
  choice('octave', 'OCTAVE', OCTAVES, 2),
  choice('voice', 'VOICES', VOICE_MODES),
  // SLIDE (id "glide" for old projects): how long a SLIDE note takes to glide into the next;
  // fully left = an instant jump. Only slides glide; other notes start on pitch.
  { id: 'glide', name: 'SLIDE', min: 0, max: 3, defaultValue: SLIDE_SECONDS, unit: 'S', curve: 'square', decimals: 3 },
  { id: 'cutoff', name: 'CUTOFF', min: 20, max: 20000, defaultValue: 1200, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'reso', name: 'RESO', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'fenv', name: 'FLT ENV', min: 0, max: 2, defaultValue: 0.4, unit: '', curve: 'linear' },
  { id: 'fattack', name: 'FLT ATK', min: 0.0005, max: 10, defaultValue: 0.0005, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'fdecay', name: 'FLT DEC', min: 0.002, max: 10, defaultValue: 0.3, unit: 'S', curve: 'power', power: FDECAY_POWER },
  { id: 'drive', name: 'DRIVE', min: 1, max: 100, defaultValue: 1, unit: 'X', curve: 'exp', decimals: 1 },
  { id: 'crush', name: 'CRUSH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'level', name: 'LEVEL', min: 0, max: 1.5, defaultValue: 0.7, unit: '', curve: 'linear' },
  { id: 'attack', name: 'OSC1 ATK', min: 0.0005, max: 10, defaultValue: 0.003, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'decay', name: 'OSC1 DEC', min: 0.005, max: 20, defaultValue: 0.4, unit: 'S', curve: 'exp' },
  { id: 'attack2', name: 'OSC2 ATK', min: 0.0005, max: 10, defaultValue: 0.003, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'decay2', name: 'OSC2 DEC', min: 0.005, max: 20, defaultValue: 0.4, unit: 'S', curve: 'exp' },
  // Each oscillator has its own SUSTAIN / RELEASE ("sustain" / "release" = OSC 1).
  { id: 'sustain', name: 'OSC1 SUS', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'release', name: 'OSC1 REL', min: 0.005, max: 20, defaultValue: 0.15, unit: 'S', curve: 'exp' },
  { id: 'sustain2', name: 'OSC2 SUS', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'release2', name: 'OSC2 REL', min: 0.005, max: 20, defaultValue: 0.15, unit: 'S', curve: 'exp' },
  // One envelope for both oscillators (BASS, PLUCK): OSC 2's DECAY is OSC 1's x this (set
  // by TIMBRE: each pluck's shorter OSC 2 tail is part of its character).
  { id: 'dratio', name: 'OSC2 DEC x', min: 0.25, max: 2, defaultValue: 1, unit: '', curve: 'linear', decimals: 2 },
  // BASS envelope filter: the amp envelope opens the filter, decaying this much faster
  // (filter decay = DECAY x this; set by TIMBRE, so ACID still snaps).
  { id: 'fratio', name: 'FLT/AMP', min: 0.1, max: 2, defaultValue: 0.5, unit: '', curve: 'linear', decimals: 2 },
  // SIDECHAIN (BASS): each KICK hit ducks the sound by DUCK, recovering over DUCK REL.
  { id: 'duck', name: 'DUCK', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'duckrel', name: 'DUCK REL', min: 0.02, max: 1, defaultValue: 0.2, unit: 'S', curve: 'exp', decimals: 3 },
  // Onboard FX (PLUCK): a tempo-synced delay, then a short room.
  midFreq(1000),
  choice('dtime', 'DLY TIME', DELAY_DIVISIONS.map((d) => d.name), 2),
  { id: 'dfdbk', name: 'DLY FDBK', min: 0, max: 0.95, defaultValue: 0.35, unit: '', curve: 'linear' },
  { id: 'dmix', name: 'DLY MIX', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'verb', name: 'VERB', min: 0, max: 1, defaultValue: 0.25, unit: '', curve: 'linear' },
];

const BY_ID: Record<string, ParamSpec> = Object.fromEntries(SYNTH_PARAMS.map((p) => [p.id, p]));

function synthParams(ids: string[], defaults: Record<string, number>, names: Record<string, string> = {}): ParamSpec[] {
  return ids.map((id) => ({ ...BY_ID[id], defaultValue: defaults[id] ?? BY_ID[id].defaultValue, name: names[id] ?? BY_ID[id].name }));
}
/** One envelope for both oscillators: plain names. */
const SHARED_NAMES = { attack: 'ATTACK', decay: 'DECAY', sustain: 'SUSTAIN', release: 'RELEASE' };

/**
 * The synth tracks share the engine with different controls: BASS (mono, glide, envelope
 * filter, sidechain), PAD (kind "pad": polyphonic chords), LEAD (mono, glide) and PLUCK
 * (onboard delay + room). PAD and LEAD keep their amp envelopes (both oscillators) as the
 * type's own; BASS and PLUCK sounds bring theirs, one envelope for both oscillators.
 * Settings outside the list are fixed (*_FIXED).
 */
const MORPHED = ['timbre', 'intensity', 'shape', 'fm', 'fmratio', 'detune', 'unison', 'cutoff', 'reso', 'fattack', 'fenv', 'fdecay', 'drive'];

const ENVELOPE = ['attack', 'decay', 'attack2', 'decay2', 'sustain', 'release', 'crush', 'level', 'sustain2', 'release2'];
/** One envelope for both oscillators (envlink). */
const SHARED_ENVELOPE = ['attack', 'decay', 'sustain', 'release', 'dratio', 'crush', 'level'];
const without = (ids: string[], drop: string[]) => ids.filter((id) => !drop.includes(id));
export const BASS_PARAMS = synthParams([...without(MORPHED, ['fattack', 'fdecay']), 'fratio', 'sub', 'octave', 'glide', ...SHARED_ENVELOPE, 'duck', 'duckrel', 'midfreq'], { attack: 0.002, decay: 0.6, sustain: 0.6, release: 0.06, level: 0.75, midfreq: 350 }, SHARED_NAMES);
export const BASS_FIXED = { voice: 1, envlink: 1, fltlink: 1 };
/** PAD: held chords that fade in and out quickly (PLUCK is the stab engine). */
export const PAD_DEFAULT_ENVELOPE = { attack: 0.03, attack2: 0.03, decay: 0.6, decay2: 0.6, sustain: 0.85, sustain2: 0.85, release: 0.2, release2: 0.2 };
/** PAD's envelope before v27 (a stab), for keeping an untouched one up to date. */
export const PAD_ENVELOPE_V26 = { attack: 0.003, attack2: 0.003, decay: 0.45, decay2: 0.45, sustain: 0, sustain2: 0, release: 0.3, release2: 0.3 };
export const PAD_PARAMS = synthParams([...MORPHED, 'octave', ...ENVELOPE, 'ratio2', 'ratio3', 'feedback', 'carriers', 'cfeedback', 'midfreq'], { ...PAD_DEFAULT_ENVELOPE, level: 0.5, detune: 0.25, midfreq: 500 });
export const PAD_FIXED = { voice: 0, glide: SLIDE_SECONDS, sub: 0, algo: 1 };
/**
 * LEAD: simple waveforms through the 3 CARRIER algorithm (one feedback modulator into three
 * carriers at related ratios): plain mono leads with INTENSITY down, DX7 bite at the top.
 */
export const LEAD_PARAMS = synthParams([...MORPHED, 'octave', 'glide', ...ENVELOPE, 'ratio2', 'ratio3', 'feedback', 'carriers', 'midfreq'], { midfreq: 1000, octave: 3, attack: 0.004, attack2: 0.004, decay: 0.6, decay2: 0.6, sustain: 0.75, sustain2: 0.75, release: 0.2, release2: 0.2, level: 0.55, detune: 0.08 });
/** LEAD: 3 voices, so a note's release rings under the next one (and live chords work). */
export const LEAD_FIXED = { voice: 0, voices: 3, sub: 0, unison: 0, algo: 1 };
/** PLUCK: a polyphonic pluck with an ARP. */
export const PLUCK_PARAMS = synthParams([...MORPHED, 'octave', ...SHARED_ENVELOPE, 'arp', 'arprate', 'arpoct', 'dtime', 'dfdbk', 'dmix', 'verb', 'midfreq'], { midfreq: 800, attack: 0.001, decay: 0.35, sustain: 0, release: 0.08, level: 0.55, detune: 0.15 }, SHARED_NAMES);
export const PLUCK_FIXED = { voice: 0, sub: 0, glide: SLIDE_SECONDS, envlink: 1, onboard: 1 };

/** SIDECHAIN: how fast a KICK hit pulls the level down (no click). */
const DUCK_ATTACK = 0.003;
/** PLUCK's onboard room and delay. */
const ONBOARD_DELAY_SECONDS = 2.5;
const ONBOARD_ROOM = { rev_size: 0.35, rev_damp: 0.55, rev_predelay: 8, rev_width: 1 };
const ONBOARD_VERB_GAIN = 0.7;
const ONBOARD_DLY_TONE = 3500;


/** Presets = the named TIMBRE points (intensity in the middle). */
function anchorPresets(kind: 'bass' | 'pad' | 'lead' | 'pluck'): Preset[] {
  const anchors = MACROS[kind].anchors;
  return anchors.map((a, i) => ({ name: a.name, values: { timbre: i / (anchors.length - 1), intensity: 0.5 } }));
}
export const BASS_PRESETS: readonly Preset[] = anchorPresets('bass');
export const PAD_PRESETS: readonly Preset[] = anchorPresets('pad');
export const LEAD_PRESETS: readonly Preset[] = anchorPresets('lead');
export const PLUCK_PRESETS: readonly Preset[] = anchorPresets('pluck');

const STAGE_OFF = 0, STAGE_ATTACK = 1, STAGE_DECAY = 2, STAGE_SUSTAIN = 3, STAGE_RELEASE = 4;

/** Any element still sounding. */
function sounding(v: Voice): boolean {
  return v.stage[0] !== STAGE_OFF || v.stage[1] !== STAGE_OFF;
}

/** Key still down (some element not yet released). */
function held(v: Voice): boolean {
  const a = v.stage[0], b = v.stage[1];
  return (a !== STAGE_OFF && a !== STAGE_RELEASE) || (b !== STAGE_OFF && b !== STAGE_RELEASE);
}

class Voice {
  note = 0;
  group = -1;
  freq = 110;
  targetFreq = 110;
  velocity = 1;
  /** The level in use: follows velocity over VEL_SMOOTH (no click when a held note changes dynamic). */
  vel = 1;
  /** Pitch glide coefficient in use (1 = on pitch; the SLIDE time while sliding). */
  glide = 1;
  /** Part of a slide: its envelopes hold at full level (SLIDE_SUSTAIN) until released. */
  hold = false;
  p1 = 0; p2 = 0; p3 = 0; p4 = 0;
  /** 3 CARRIER: carriers 2 / 3 phases and the modulator's last two outputs (feedback). */
  p5 = 0; p6 = 0; fb1 = 0; fb2 = 0; cf1 = 0; cf2 = 0;
  /** UNISON copies' phases. */
  readonly u = new Float64Array(4);
  /** Envelope stage and level per element (OSC 1, OSC 2). */
  readonly stage = new Uint8Array(2);
  readonly amp = new Float64Array(2);
  fenv = 0;
  fattacking = false;
  age = 0;
  counter = 0;
  readonly filter = new Svf();
}

export class Synth implements Instrument {
  private readonly sr: number;
  private readonly velK: number;
  private readonly voices: Voice[] = [];
  private shape = 2; private fm = 0; private fmRatio = 2;
  /**
   * 0 = FM PAIR (crossfaded with the waves), 1 = 3 CARRIER (one feedback modulator into three
   * carriers), 2 = 2 STACKS (two modulator -> carrier pairs).
   */
  private algo = 0; private ratio2 = 1; private ratio3 = 1; private feedback = 0; private fmIndex = 0; private carriers = 0.35;
  private fmMod = 0; private fmEff = 0; private detune = 0; private sub = 0; private octave = 0; private mono = false;
  private unison = 0;
  private polyLimit = MAX_VOICES; private voiceCount = MAX_VOICES;
  private cFeedback = 0;
  /** UNISON copies' pitch ratios (around OSC 1: two below, two above). */
  private readonly uRatio = new Float64Array(4);
  private slideCoeff = 1;
  private cutoff = 1200; private reso = 0.3; private fenvAmt = 0.4; private fdecayMul = 0; private fattackInc = 0;
  private filterMod = 0;
  private drive = 1; private crush = 0; private level = 0.7; private driveComp = 1;
  private crushPhase = 1; private held = 0;
  /** Per element (OSC 1, OSC 2). */
  private readonly attackInc = new Float64Array([1, 1]);
  private readonly decayMul = new Float64Array(2);
  /** Per element: SUSTAIN and the RELEASE multiplier. */
  private readonly sustain = new Float64Array([0.5, 0.5]);
  private readonly releaseMul = new Float64Array(2);
  private ageCounter = 0;
  private pitchMod = 1;
  /** envlink: OSC 2 follows OSC 1's envelope (DECAY x dratio). fltlink: the filter envelope follows it too. */
  private envLink = false; private fltLink = false;
  private attack1 = 0.003; private decay1 = 0.4; private dRatio = 1; private fRatio = 0.5;
  /** SIDECHAIN: 0 idle, 1 pulling down, 2 recovering; progress and shape (0..1) of the duck. */
  private duckDepth = 0; private duckRelInc = 0; private duckStage = 0; private duckX = 0; private duckFrom = 0; private duckShape = 0;
  private readonly duckAttackInc: number;
  private readonly delay: Delay | null = null;
  private readonly room: Reverb | null = null;

  /** driveRise: the type's DRIVE level compensation curve (driveComp.ts). */
  constructor(sampleRate: number, readonly params: readonly ParamSpec[], fixed: Record<string, number>, private readonly driveRise?: readonly number[]) {
    this.sr = sampleRate;
    this.velK = 1 - Math.exp(-1 / (VEL_SMOOTH * sampleRate));
    this.duckAttackInc = 1 / (DUCK_ATTACK * sampleRate);
    if (fixed.onboard) {
      this.delay = new Delay(sampleRate, ONBOARD_DELAY_SECONDS);
      this.delay.setParam('dly_tone', ONBOARD_DLY_TONE);
      this.room = new Reverb(sampleRate);
      for (const id in ONBOARD_ROOM) this.room.setParam(id, ONBOARD_ROOM[id as keyof typeof ONBOARD_ROOM]);
    }
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    for (const p of SYNTH_PARAMS) this.setParam(p.id, p.defaultValue);
    for (const id in fixed) this.setParam(id, fixed[id]);
    for (const p of params) this.setParam(p.id, p.defaultValue);
  }

  noteOn(note: number, velocity: number, group: number, _ring = false, slideFrom = -1, slide = false): void {
    const n = note + this.octave * 12;
    const freq = midiToHz(n);
    if (slideFrom >= 0) {
      // Legato: the oldest still-held voice of that group glides here, envelopes untouched.
      let s: Voice | null = null;
      const count = this.voiceCount;
      for (let i = 0; i < count; i++) {
        const c = this.voices[i];
        if (c.group === slideFrom && held(c) && (!s || c.age < s.age)) s = c;
      }
      if (s) {
        s.note = note;
        s.group = group;
        s.targetFreq = freq;
        s.glide = this.slideCoeff;
        s.velocity = velocity;
        // The slide has landed: the note stays held at full level until it is released.
        s.hold = true;
        return;
      }
    }
    let v: Voice;
    if (this.mono) {
      v = this.voices[0];
      if (!sounding(v)) v.freq = freq;
    } else {
      v = this.allocate();
      v.freq = freq;
    }
    v.note = note;
    v.group = group;
    v.targetFreq = freq;
    v.glide = 1;
    v.hold = slide;
    v.velocity = velocity;
    if (!sounding(v)) {
      v.vel = velocity;
      for (let k = 0; k < 4; k++) v.u[k] = UNISON_PHASE[k];
      v.fb1 = v.fb2 = 0;
      v.cf1 = v.cf2 = 0;
    }
    v.stage[0] = STAGE_ATTACK;
    v.stage[1] = STAGE_ATTACK;
    v.fattacking = this.fattackInc > 0;
    v.fenv = v.fattacking ? 0 : 1;
    v.age = ++this.ageCounter;
    v.counter = 0;
  }

  setPitchMod(semitones: number): void {
    this.pitchMod = semitones === 0 ? 1 : Math.pow(2, semitones / 12);
  }

  setFilterMod(octaves: number): void {
    this.filterMod = octaves;
  }

  setFmMod(amount: number): void {
    this.fmMod = amount;
    this.updateFm();
  }

  /** FM in use: the set level plus the LFO's push, clamped. */
  private updateFm(): void {
    const f = this.fm + this.fmMod;
    this.fmEff = f < 0 ? 0 : f > 1 ? 1 : f;
    this.fmIndex = dx7Index(this.fmEff);
  }

  noteOff(group: number): void {
    for (const v of this.voices) {
      if (!held(v) || (group >= 0 && v.group !== group)) continue;
      for (let k = 0; k < 2; k++) if (v.stage[k] !== STAGE_OFF) v.stage[k] = STAGE_RELEASE;
    }
  }

  setParam(id: string, value: number): void {
    const sr = this.sr;
    switch (id) {
      case 'shape': this.shape = Math.min(3, Math.max(0, value)); break;
      case 'wave': this.shape = LEGACY_WAVE_TO_SHAPE[Math.round(value)] ?? 2; break; // old saves
      case 'fmratio': this.fmRatio = value; break;
      case 'fm': this.fm = value; this.updateFm(); break;
      case 'ratio2': this.ratio2 = value; break;
      case 'ratio3': this.ratio3 = value; break;
      case 'feedback': this.feedback = value; break;
      case 'cfeedback': this.cFeedback = value; break;
      case 'carriers': this.carriers = value; break;
      case 'algo': this.algo = Math.round(value); break;
      case 'detune': this.detune = value; break;
      case 'sub': this.sub = value; break;
      case 'unison': this.unison = value; break;
      case 'octave': this.octave = Math.round(value) - 2; break;
      case 'voice':
        this.mono = Math.round(value) === 1;
        this.updateVoiceCount();
        break;
      case 'voices': this.polyLimit = Math.max(1, Math.min(MAX_VOICES, Math.round(value))); this.updateVoiceCount(); break;
      case 'glide':
        this.slideCoeff = value <= 0.0005 ? 1 : 1 - Math.exp(-1 / (value * sr));
        break;
      case 'cutoff': this.cutoff = value; break;
      case 'reso': this.reso = value; break;
      case 'fenv': this.fenvAmt = value; break;
      case 'fdecay': if (!this.fltLink) this.fdecayMul = decayMul(value, sr); break;
      case 'fattack': if (!this.fltLink) this.fattackInc = value <= 0.0006 ? 0 : 1 / (value * sr); break;
      case 'drive': this.drive = value; this.driveComp = driveCompGain(this.driveRise, value); break;
      case 'crush': this.crush = value; break;
      case 'level': this.level = value; break;
      case 'attack':
        this.attack1 = value;
        this.attackInc[0] = 1 / (value * sr);
        if (this.envLink) this.attackInc[1] = this.attackInc[0];
        this.updateFilterLink();
        break;
      case 'decay': this.decay1 = value; this.setDecay(0, value); if (this.envLink) this.setDecay(1, value * this.dRatio); this.updateFilterLink(); break;
      case 'sustain': this.sustain[0] = value; if (this.envLink) this.sustain[1] = value; break;
      case 'release': this.releaseMul[0] = decayMul(value, sr); if (this.envLink) this.releaseMul[1] = this.releaseMul[0]; break;
      // OSC 2's own envelope (PAD, LEAD); linked sounds ignore it.
      case 'attack2': if (!this.envLink) this.attackInc[1] = 1 / (value * sr); break;
      case 'decay2': if (!this.envLink) this.setDecay(1, value); break;
      case 'sustain2': if (!this.envLink) this.sustain[1] = value; break;
      case 'release2': if (!this.envLink) this.releaseMul[1] = decayMul(value, sr); break;
      case 'dratio': this.dRatio = value; if (this.envLink) this.setDecay(1, this.decay1 * value); break;
      case 'fratio': this.fRatio = value; this.updateFilterLink(); break;
      case 'envlink':
        this.envLink = value > 0;
        if (this.envLink) {
          this.attackInc[1] = this.attackInc[0];
          this.sustain[1] = this.sustain[0];
          this.releaseMul[1] = this.releaseMul[0];
          this.setDecay(1, this.decay1 * this.dRatio);
        }
        break;
      case 'fltlink': this.fltLink = value > 0; this.updateFilterLink(); break;
      case 'duck': this.duckDepth = value; break;
      case 'duckrel': this.duckRelInc = 1 / (value * sr); break;
      case 'dtime': this.delay?.setParam('dly_time', value); break;
      case 'dfdbk': this.delay?.setParam('dly_fdbk', value); break;
      case 'dmix': this.delay?.setParam('dly_return', value); break;
      case 'verb': this.room?.setParam('rev_return', value * ONBOARD_VERB_GAIN); break;
    }
  }

  private setDecay(k: number, seconds: number): void {
    this.decayMul[k] = decayMul(seconds, this.sr);
  }

  /** Envelope filter (fltlink): the filter opens with the amp's ATTACK and decays with its DECAY x fratio. */
  private updateFilterLink(): void {
    if (!this.fltLink) return;
    this.fattackInc = this.attack1 <= 0.0006 ? 0 : 1 / (this.attack1 * this.sr);
    this.fdecayMul = decayMul(Math.max(0.002, this.decay1 * this.fRatio), this.sr);
  }

  setTempo(bpm: number): void {
    this.delay?.setTempo(bpm);
  }

  duck(): void {
    if (this.duckDepth <= 0) return;
    this.duckFrom = this.duckShape;
    this.duckStage = 1;
    this.duckX = 0;
  }

  /** PLUCK's delay, then its room (on the track's output, in place). */
  post(l: Float32Array, r: Float32Array, n: number): void {
    if (!this.delay || !this.room) return;
    this.delay.process(l, r, l, r, 0, n);
    this.room.process(l, r, l, r, 0, n);
  }

  /**
   * Renders into outL/outR[start, end). The engine hands each instrument its own zeroed
   * buffer, so CRUSH can work on the summed voices in place.
   */
  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    this.renderVoices(outL, outR, start, end);
    this.renderCrush(outL, outR, start, end);
    if (this.duckStage !== 0) this.renderDuck(outL, outR, start, end);
  }

  /** SIDECHAIN: pull down fast, recover on a smooth S-curve over DUCK REL. */
  private renderDuck(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    for (let i = start; i < end; i++) {
      if (this.duckStage === 1) {
        this.duckX += this.duckAttackInc;
        if (this.duckX >= 1) { this.duckX = 0; this.duckStage = 2; this.duckShape = 1; }
        else this.duckShape = this.duckFrom + (1 - this.duckFrom) * this.duckX;
      } else if (this.duckStage === 2) {
        this.duckX += this.duckRelInc;
        if (this.duckX >= 1) { this.duckStage = 0; this.duckShape = 0; }
        else { const t = this.duckX; this.duckShape = 1 - t * t * (3 - 2 * t); }
      }
      const g = 1 - this.duckDepth * this.duckShape;
      outL[i] *= g;
      outR[i] *= g;
    }
  }

  private renderCrush(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    if (this.crush <= 0) return;
    // Sample-rate reduction: a new sample every 1 + crush^2 x 24 samples, on a fractional
    // clock so the rate falls smoothly (whole-sample holds jumped 48 -> 24 kHz at 0.2).
    const step = 1 / (1 + this.crush * this.crush * 24);
    const levels = Math.pow(2, 16 - this.crush * 12);
    for (let i = start; i < end; i++) {
      this.crushPhase += step;
      if (this.crushPhase >= 1) {
        this.crushPhase -= 1;
        this.held = Math.round(outL[i] * levels) / levels;
      }
      outL[i] = this.held;
      outR[i] = this.held;
    }
  }

  private renderVoices(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    const sr = this.sr;
    const velK = this.velK;
    const det = Math.pow(2, (this.detune * 0.35) / 12); // up to ~35 cents apart
    const driveNorm = this.drive > 1 ? 1 / Math.tanh(Math.min(this.drive, 3)) : 1;
    const count = this.voiceCount;
    const fmod = this.filterMod === 0 ? 1 : Math.pow(2, this.filterMod);
    const uni = this.unison;
    if (uni > 0) {
      // Copies at -1, -0.4, +0.4, +1 x the spread: 12 cents + DETUNE.
      const cents = 12 + 20 * this.detune;
      for (let k = 0; k < 4; k++) this.uRatio[k] = Math.pow(2, (UNISON_SPREAD[k] * cents) / 1200);
    }
    const uniGain = 1 / (1 + uni);
    const cfbAmt = (this.cFeedback * MAX_CARRIER_FEEDBACK * (1 - 0.8 * Math.min(1, Math.max(0, this.shape - 1)))) / (2 * Math.PI);
    for (let vi = 0; vi < count; vi++) {
      const v = this.voices[vi];
      if (!sounding(v)) continue;
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
        let o1: number;
        let o2: number;
        if (this.algo === 1) {
          // 3 CARRIER: one sine modulator with self-feedback (its last two outputs averaged,
          // as on the DX7) phase-modulates three carriers at their own ratios; the carriers
          // play SHAPE's wave, so with no modulation this is a plain lead. Carrier 2 is
          // detuned by DETUNE. CARRIERS sets carriers 2 / 3 against carrier 1 (at 0 one clear
          // note through both envelopes). OSC 1 = carriers 1 + 3, OSC 2 = carrier 2.
          v.p4 += dt1 * this.fmRatio; if (v.p4 >= 1) v.p4 -= 1;
          const fbIn = (v.fb1 + v.fb2) * 0.5 * this.feedback * MAX_FEEDBACK;
          const m = Math.sin(2 * Math.PI * v.p4 + fbIn);
          v.fb2 = v.fb1;
          v.fb1 = m;
          // The modulation follows the filter envelope (a struck attack) but sustains.
          const pm = (m * this.fmIndex * (0.6 + 0.4 * v.fenv)) / (2 * Math.PI);
          const d5 = dt1 * this.ratio2 * det;
          const d6 = dt1 * this.ratio3;
          v.p5 += d5; if (v.p5 >= 1) v.p5 -= 1;
          v.p6 += d6; if (v.p6 >= 1) v.p6 -= 1;
          const c = this.carriers;
          // Carrier 1 into itself (its last two outputs averaged), scaled down on bright waves.
          const cfb = (v.cf1 + v.cf2) * 0.5 * cfbAmt;
          const c1 = this.osc(wrap(v.p1 + pm + cfb), dt1);
          v.cf2 = v.cf1;
          v.cf1 = c1;
          o1 = c1 * (1 - 0.4 * c) + this.osc(wrap(v.p6 + pm), d6) * 0.6 * c;
          o2 = c1 * (1 - c) + this.osc(wrap(v.p5 + pm), d5) * c;
        } else if (this.algo === 2) {
          // 2 STACKS: two modulator -> carrier pairs. Stack 1 = carrier 1 (SHAPE's wave, its
          // own CAR FB) under a sine at FM RATIO with self-feedback; stack 2 = a carrier at
          // RATIO 2 (detuned by DETUNE) under a plain sine at RATIO 3. CARRIERS = stack 2
          // against stack 1. OSC 1 = stack 1, OSC 2 = the blend.
          v.p4 += dt1 * this.fmRatio; if (v.p4 >= 1) v.p4 -= 1;
          const fbIn = (v.fb1 + v.fb2) * 0.5 * this.feedback * MAX_FEEDBACK;
          const m1 = Math.sin(2 * Math.PI * v.p4 + fbIn);
          v.fb2 = v.fb1;
          v.fb1 = m1;
          const d5 = dt1 * this.ratio2 * det;
          v.p5 += d5; if (v.p5 >= 1) v.p5 -= 1;
          v.p6 += dt1 * this.ratio3; if (v.p6 >= 1) v.p6 -= 1;
          const m2 = Math.sin(2 * Math.PI * v.p6);
          const idx = (this.fmIndex * (0.6 + 0.4 * v.fenv)) / (2 * Math.PI);
          const cfb = (v.cf1 + v.cf2) * 0.5 * cfbAmt;
          const c1 = this.osc(wrap(v.p1 + m1 * idx + cfb), dt1);
          v.cf2 = v.cf1;
          v.cf1 = c1;
          const c = this.carriers;
          o1 = c1;
          o2 = c1 * (1 - c) + this.osc(wrap(v.p5 + m2 * idx), d5) * c;
        } else {
          o1 = this.osc(v.p1, dt1);
          o2 = this.osc(v.p2, dt2);
        }
        if (this.fmEff > 0 && this.algo === 0) {
          // FM pair: the index rises with FM and with the filter envelope (a struck clang).
          v.p4 += dt1 * this.fmRatio; if (v.p4 >= 1) v.p4 -= 1;
          const fm = this.fmEff;
          const index = fm * (0.5 + 4.5 * v.fenv);
          const fmOut = Math.sin(2 * Math.PI * v.p1 + index * Math.sin(2 * Math.PI * v.p4));
          o1 = o1 * (1 - fm) + fmOut * fm;
          o2 = o2 * (1 - fm) + fmOut * fm;
        }
        if (uni > 0) {
          // UNISON: two detuned copies join each element.
          const u = v.u;
          let c1 = 0, c2 = 0;
          for (let k = 0; k < 4; k++) {
            const d = dt1 * this.uRatio[k];
            u[k] += d; if (u[k] >= 1) u[k] -= 1;
            if (k & 1) c2 += this.osc(u[k], d); else c1 += this.osc(u[k], d);
          }
          o1 = (o1 + c1 * uni * 0.5) * uniGain * 1.4;
          o2 = (o2 + c2 * uni * 0.5) * uniGain * 1.4;
        }
        o1 += Math.sin(2 * Math.PI * v.p3) * this.sub * 2; // x2: the element mix halves it

        // Each element through its own envelope (its own ADSR).
        let mix = 0;
        for (let k = 0; k < 2; k++) {
          let a = v.amp[k];
          const sus = v.hold ? Math.max(this.sustain[k], SLIDE_SUSTAIN) : this.sustain[k];
          switch (v.stage[k]) {
            case STAGE_ATTACK:
              a += this.attackInc[k];
              if (a >= 1) { a = 1; v.stage[k] = STAGE_DECAY; }
              break;
            case STAGE_DECAY:
              a = sus + (a - sus) * this.decayMul[k];
              if (a - sus < 1e-4) v.stage[k] = STAGE_SUSTAIN;
              break;
            case STAGE_SUSTAIN:
              a = sus;
              break;
            case STAGE_RELEASE:
              a *= this.releaseMul[k];
              if (a < 1e-5) { a = 0; v.stage[k] = STAGE_OFF; }
              break;
          }
          if (v.stage[k] === STAGE_SUSTAIN && sus < 1e-5 && a < 1e-5) { a = 0; v.stage[k] = STAGE_OFF; }
          v.amp[k] = a;
          mix += (k === 0 ? o1 : o2) * a;
        }

        // Filter envelope: attack up, then decay.
        if (v.fattacking) {
          v.fenv += this.fattackInc;
          if (v.fenv >= 1) { v.fenv = 1; v.fattacking = false; }
        } else {
          v.fenv *= this.fdecayMul;
        }
        if (v.counter-- <= 0) {
          v.counter = FILTER_UPDATE;
          v.filter.setup(this.cutoff * fmod * Math.pow(2, this.fenvAmt * 6 * v.fenv), this.reso, sr);
        }
        v.filter.process(mix * 0.5);

        v.vel += (v.velocity - v.vel) * velK;
        let out = v.filter.low * v.vel * this.level;
        if (this.drive > 1) out = Math.tanh(out * this.drive) * driveNorm * this.driveComp;
        outL[i] += out;
        outR[i] += out;
      }
      if (!sounding(v)) {
        v.amp.fill(0);
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

  /** Voices in use: 1 (MONO), else the type's limit (PLUCK / PAD 6, LEAD 3); the rest fall silent. */
  private updateVoiceCount(): void {
    this.voiceCount = this.mono ? 1 : this.polyLimit;
    for (let i = this.voiceCount; i < MAX_VOICES; i++) this.voices[i].stage.fill(STAGE_OFF);
  }

  /** Free voice, else the oldest one (of the voices in use). */
  private allocate(): Voice {
    let oldest = this.voices[0];
    for (let i = 0; i < this.voiceCount; i++) {
      const v = this.voices[i];
      if (!sounding(v)) return v;
      if (v.age < oldest.age) oldest = v;
    }
    return oldest;
  }
}
