import { CUT_FADE, type Instrument, type Preset } from './Instrument';
import { choice, type ParamSpec } from '../engine/params';
import { decayMul, IdleGate, Noise, polyBlep, Svf } from './dsp';
import { exp2, sinRad, sinTurn, tanh } from './math';
import { INTENSITY, TIMBRE, midFreq } from './macroParams';
import { MACROS } from './macros';
import { DRIVE_RISE, driveCompGain } from './driveComp';
import { AirRoom } from './airRoom';

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
 * the type's fixed ring extension (tone and metal; the click only stretches), so ring
 * tails follow the DECAY knobs.
 * Each layer has its own ATTACK and DECAY; BALANCE trades the type's two elements against
 * each other (centre = as designed). Then DRIVE (tanh) and CRUSH (bit + sample-rate
 * reduction). No filter per drum: the kit's filter is FX 1's FILTER (the LFO's filter
 * destination still sweeps a low-pass here). Ranges go far past "sensible" on purpose.
 * The played note tunes the pitched layers (36 = as designed), so drums play chromatically.
 * PERC (relative tuning): the metal sits INTERVAL semitones above the tone, the click's
 * resonance follows the note too, and DETUNE moves both (up to a semitone) off the tone,
 * which always stays on the step's note.
 */

const T_WAVES = ['SINE', 'TRI', 'SAW', 'SQR'];
const ATTACK = { min: 0.0005, max: 2, defaultValue: 0.0005, unit: 'S', curve: 'exp', decimals: 4 } as const;

/** ROLL RATE: hits per step (1:n) of a ROLL run (ids 'rolldiv'; before v30 the list began at 1:2). */
export const ROLL_DIVS = [
  { name: '1:1', hits: 1 }, { name: '1:2', hits: 2 }, { name: '1:3', hits: 3 }, { name: '1:4', hits: 4 }, { name: '1:6', hits: 6 }, { name: '1:8', hits: 8 },
] as const;
/** ROLL RATE 1:4: a plain ROLL sounds like a roll, not a double. */
const DEFAULT_ROLL_RATE = 3;

/** Every drum parameter; each drum type exposes a subset with its own defaults. */
const ALL: Record<string, ParamSpec> = Object.fromEntries(([
  TIMBRE,
  INTENSITY,
  { id: 't_level', name: 'BD LEVEL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 't_pitch', name: 'BD PITCH', min: 10, max: 5000, defaultValue: 50, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 't_sweep', name: 'SWEEP', min: 0, max: 120, defaultValue: 24, unit: 'ST', curve: 'linear', decimals: 0 },
  { id: 't_stime', name: 'SWP TIME', min: 0.001, max: 2, defaultValue: 0.04, unit: 'S', curve: 'exp', decimals: 3 },
  { id: 't_attack', name: 'BD ATK', ...ATTACK },
  { id: 't_decay', name: 'BD DEC', min: 0.005, max: 20, defaultValue: 0.45, unit: 'S', curve: 'exp' },
  choice('t_wave', 'BD WAVE', T_WAVES),
  { id: 'c_level', name: 'CLK LEVEL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'c_tone', name: 'CLK PITCH', min: 100, max: 20000, defaultValue: 4000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'c_attack', name: 'CLK ATK', ...ATTACK },
  { id: 'c_len', name: 'CLK DEC', min: 0.0002, max: 0.5, defaultValue: 0.004, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'c_reso', name: 'CLK RESO', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'c_noise', name: 'CLK NOISE', min: 0, max: 1, defaultValue: 0.6, unit: '', curve: 'linear' },
  { id: 'm_level', name: 'MTL LEVEL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'm_pitch', name: 'MTL PITCH', min: 20, max: 12000, defaultValue: 400, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'm_spread', name: 'SPREAD', min: 0, max: 3, defaultValue: 1, unit: '', curve: 'linear' },
  { id: 'm_noise', name: 'MTL NOISE', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'm_tone', name: 'MTL TONE', min: 30, max: 20000, defaultValue: 6000, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'm_attack', name: 'MTL ATK', ...ATTACK },
  { id: 'm_decay', name: 'MTL DEC', min: 0.005, max: 20, defaultValue: 0.2, unit: 'S', curve: 'exp' },
  // Continuous: 0 = square bank, 1 = ring-mod pairs, 2 = FM (blends in between).
  { id: 'm_mode', name: 'M MODE', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'm_fm', name: 'M FM', min: 0, max: 4, defaultValue: 0.5, unit: '', curve: 'linear' },
  // HAT head: what the metal sounds like at the start of the hit, before it becomes the tail.
  // HAT: a bell's sine partials over the metal, and the jingles' rattle at the start of a hit.
  { id: 'm_bell', name: 'BELL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'h_rattle', name: 'RATTLE', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'h_time', name: 'HEAD', min: 0, max: 0.5, defaultValue: 0, unit: 'S', curve: 'linear', decimals: 3 },
  { id: 'h_pitch', name: 'H PITCH', min: 20, max: 12000, defaultValue: 420, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'h_tone', name: 'H TONE', min: 30, max: 20000, defaultValue: 8500, unit: 'HZ', curve: 'exp', decimals: 0 },
  { id: 'h_noise', name: 'H NOISE', min: 0, max: 1, defaultValue: 0.3, unit: '', curve: 'linear' },
  { id: 'h_mode', name: 'H MODE', min: 0, max: 2, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'h_spread', name: 'H SPREAD', min: 0, max: 3, defaultValue: 1, unit: '', curve: 'linear' },
  // PERC: the metal's interval above the tone (whole semitones) and DETUNE of metal + click.
  { id: 'm_interval', name: 'INTVL', min: -12, max: 36, defaultValue: 12, unit: 'ST', curve: 'linear', decimals: 0 },
  { id: 'detune', name: 'DETUNE', min: -1, max: 1, defaultValue: 0, unit: 'ST', curve: 'linear', decimals: 2 },
  // Whole drum: these sit on top of TIMBRE / INTENSITY (the macros never move BALANCE).
  { id: 'balance', name: 'BALANCE', min: 0, max: 1, defaultValue: 0.5, unit: '', curve: 'linear' },
  { id: 'drive', name: 'DRIVE', min: 1, max: 200, defaultValue: 1, unit: 'X', curve: 'exp', decimals: 1 },
  { id: 'crush', name: 'CRUSH', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  // Output gain after DRIVE / CRUSH (set by TIMBRE, no knob): every sound equally loud by default.
  { id: 'ogain', name: 'OUT GAIN', min: 0.05, max: 16, defaultValue: 1, unit: '', curve: 'exp', decimals: 2 },
  // ROLL DIV: how fast a ROLL step repeats (read by the engine; the voice ignores it).
  choice('rolldiv', 'ROLL RATE', ROLL_DIVS.map((r) => r.name), DEFAULT_ROLL_RATE),
  // AIR (KICK, SNARE): a small room on the drum's own output, its tail through the type's fixed EQ.
  { id: 'air', name: 'AIR LVL', min: 0, max: 1, defaultValue: 0, unit: '', curve: 'linear' },
  { id: 'airsize', name: 'AIR SIZE', min: 0, max: 1, defaultValue: 0.4, unit: '', curve: 'linear' },
  midFreq(1000),
] as ParamSpec[]).map((p) => [p.id, p]));

/** Build a drum type's parameter list (in knob order) with per-type defaults. */
function drumParams(ids: string[], defaults: Record<string, number>): ParamSpec[] {
  return ids.map((id) => ({ ...ALL[id], defaultValue: defaults[id] ?? ALL[id].defaultValue }));
}

/** Controls every drum has (after its layer parameters). */
const WHOLE = ['balance', 'drive', 'crush', 'ogain', 'rolldiv', 'midfreq'];
/** AIR: KICK and SNARE (DrumVoice.air sets each one's EQ). */
const AIR = ['air', 'airsize'];

/*
 * Each drum type: its parameters (set by TIMBRE / INTENSITY and presets, except the tail
 * lengths - layer decays and the ring extension - which are the type's own, the same for every
 * TIMBRE, so sounds can be swapped without changing how long they ring; the KICK's BD DEC is
 * the exception: TIMBRE's, 0.5 s on every sound, shortened by TECHNO's INT extreme),
 * and its two elements' ATTACK / DECAY ids (on the SOUND page, see registry). Parameters
 * without a knob are set by TIMBRE / INTENSITY.
 */
export const KICK_PARAMS = drumParams(
  ['timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_stime', 't_attack', 't_decay', 't_wave', 'c_level', 'c_tone', 'c_attack', 'c_len', 'c_reso', 'c_noise', ...WHOLE, ...AIR],
  { t_level: 0.95, t_pitch: 48, t_sweep: 30, t_stime: 0.035, t_decay: 0.5, c_level: 0.25, c_tone: 3500, c_len: 0.003, midfreq: 350 },
);
export const KICK_ELEMENTS = ['t_attack', 't_decay', 'c_attack', 'c_len'];

export const SNARE_PARAMS = drumParams(
  ['timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_stime', 't_attack', 't_decay', 't_wave', 'm_level', 'm_pitch', 'm_noise', 'm_tone', 'm_attack', 'm_decay', 'm_spread', 'm_mode', 'm_fm', ...WHOLE, ...AIR],
  { t_level: 0.55, t_pitch: 190, t_sweep: 7, t_decay: 0.14, m_level: 0.8, m_noise: 0.85, m_pitch: 330, m_tone: 1800, m_decay: 0.2, midfreq: 500 },
);
export const SNARE_ELEMENTS = ['t_attack', 't_decay', 'm_attack', 'm_decay'];

export const HAT_PARAMS = drumParams(
  [
    'timbre', 'intensity', 'c_level', 'c_tone', 'c_attack', 'c_len', 'c_reso', 'c_noise', 'm_level', 'm_pitch', 'm_spread', 'm_noise', 'm_tone', 'm_attack', 'm_decay', 'm_mode', 'm_fm',
    'h_time', 'h_pitch', 'h_tone', 'h_noise', 'h_mode', 'h_spread', 'm_bell', 'h_rattle', ...WHOLE,
  ],
  { c_level: 0.2, c_tone: 9000, c_len: 0.002, m_level: 0.6, m_pitch: 420, m_spread: 1, m_noise: 0.3, m_tone: 8500, m_decay: 0.1, h_time: 0.03, midfreq: 2000 },
);
export const HAT_ELEMENTS = ['c_attack', 'c_len', 'm_attack', 'm_decay'];

export const PERC_PARAMS = drumParams(
  [
    'timbre', 'intensity', 't_level', 't_pitch', 't_sweep', 't_stime', 't_attack', 't_decay', 't_wave',
    'c_level', 'c_tone', 'c_attack', 'c_len', 'c_reso', 'c_noise',
    'm_level', 'm_interval', 'detune', 'm_spread', 'm_noise', 'm_tone', 'm_mode', 'm_fm', ...WHOLE,
  ],
  { t_level: 0.95, t_pitch: 95, t_sweep: 9, t_stime: 0.08, t_decay: 0.3, c_level: 0.3, c_tone: 2200, c_len: 0.004, midfreq: 450 },
);
export const PERC_ELEMENTS = ['t_attack', 't_decay', 'c_attack', 'c_len'];

/** Per type voice settings: which layers BALANCE trades, the fixed ring extension, PERC tuning. */
interface DrumVoice {
  /**
   * The layers on each side of BALANCE (left = side 1 only, right = side 2 only), e.g.
   * PERC's body against click + metal.
   */
  balance: readonly [string, string];
  /** Seconds a RING step adds to the stretched decay (was the RING LEN knob's default). */
  ringExtra: number;
  /**
   * PERC: metal + click tuned from the tone (INTERVAL, DETUNE, the note) instead of in Hz,
   * and the metal's attack / decay halfway (in time) between the body's and the click's.
   */
  relative?: boolean;
  /** DRIVE level compensation curve (driveComp.ts). */
  driveRise?: readonly number[];
  /**
   * AIR's fixed pre-EQ (Hz, before its mono room, airRoom.ts): high-passes so it never
   * muddies the low end, a low-pass so it stays soft; and its level (x AIR_GAIN). No AIR on
   * the type without it.
   */
  air?: { highPass: number; lowPass: number; gain: number };
}
/** AIR's level per type: at the default AIR SIZE, the KICK's first 100 ms as loud as the old stereo room's, the SNARE's 3 dB under it. */
const KICK_AIR_GAIN = 3.45;
const SNARE_AIR_GAIN = 2;
// KICK's air keeps clear of the sub and the body, and has no treble (only its knock rings);
// SNARE's is cut higher so it never gets muddy or swamps the hit, and stops short of the fizz.
export const KICK_VOICE: DrumVoice = { balance: ['t', 'c'], ringExtra: 0.6, driveRise: DRIVE_RISE.kick, air: { highPass: 300, lowPass: 1400, gain: KICK_AIR_GAIN } };
export const SNARE_VOICE: DrumVoice = { balance: ['t', 'm'], ringExtra: 0.6, driveRise: DRIVE_RISE.snare, air: { highPass: 600, lowPass: 5000, gain: SNARE_AIR_GAIN } };
export const HAT_VOICE: DrumVoice = { balance: ['c', 'm'], ringExtra: 0.6, driveRise: DRIVE_RISE.hat };
export const PERC_VOICE: DrumVoice = { balance: ['t', 'cm'], ringExtra: 0.6, relative: true, driveRise: DRIVE_RISE.perc };

/** Presets = the named TIMBRE points (intensity in the middle). */
function anchorPresets(kind: 'kick' | 'snare' | 'hat' | 'perc'): Preset[] {
  const anchors = MACROS[kind].anchors;
  return anchors.map((a, i) => ({ name: a.name, values: { timbre: i / (anchors.length - 1), intensity: 0.5 } }));
}
export const KICK_PRESETS: readonly Preset[] = anchorPresets('kick');
export const SNARE_PRESETS: readonly Preset[] = anchorPresets('snare');
export const HAT_PRESETS: readonly Preset[] = anchorPresets('hat');
export const PERC_PRESETS: readonly Preset[] = anchorPresets('perc');

/**
 * BELL: a cymbal bell's partials (inharmonic; 2.546 / 2.63 beat against each other), their
 * levels, how much faster each fades than the metal (the low ones ring longest) and the
 * bank's level against the metal.
 */
const BELL_RATIOS = [1, 1.483, 1.932, 2.546, 2.63, 3.159, 3.799, 4.556] as const;
const BELL_LEVELS = [1, 0.7, 0.55, 0.5, 0.45, 0.35, 0.3, 0.25] as const;
const BELL_FADES = [1, 1.2, 1.4, 1.6, 1.6, 2, 2.4, 2.8] as const;
const BELL_PARTIALS = BELL_RATIOS.length;
const BELL_GAIN = 0.12;
/** RATTLE: re-hits after the first, about this far apart (s, jittered), each pulse's fall and the gate's release after the last. */
const RATTLE_HITS = 4;
const RATTLE_GAP = 0.011;
const RATTLE_PULSE = 0.004;
const RATTLE_RELEASE = 0.03;

/** 808 cymbal oscillator ratios (relative to the lowest). */
const METAL_RATIOS = [1, 1.4471, 1.617, 1.9265, 2.5028, 2.6637];
const TWO_PI = Math.PI * 2;
/** RING: each layer's decay x this (plus RING LEN), so longer DECAY knobs mean longer rings. */
const RING_STRETCH = 3;
/**
 * A drum hit again while still sounding (rolls, fast repeats) would cut the old hit off
 * dead - a click. The old hit's last output fades out over this long instead, under the new one.
 */
/** A ringing drum is choked (by the next hit or a rest) with this fade. */
const CHOKE_SECONDS = 0.012;
const FILTER_UPDATE = 16;
const OFF = 0, ATTACKING = 1, DECAYING = 2;

/** Attack increment per sample (0 = instant). */
function attackInc(seconds: number, sr: number): number {
  return seconds <= 0.0006 ? 0 : 1 / (seconds * sr);
}

/**
 * AIR: the level at full AIR LVL (on a square law: fine at the low end), x each type's gain
 * (they keep AIR LVL's range as it was with the stereo room).
 */
const AIR_GAIN = 0.8;
/** AIR LVL glides over this long (s); the room runs in chunks of AIR_CHUNK samples. */
const AIR_SMOOTH = 0.02;
/** AIR is skipped after this long of silence in and (nearly) out: longer than its longest tail. */
const AIR_IDLE_SECONDS = 4;
const AIR_CHUNK = 128;

export class Drum implements Instrument {
  private readonly sr: number;
  private readonly noise = new Noise(0x5eed);
  private readonly mFilter = new Svf();
  private readonly cFilter = new Svf();
  private readonly filter = new Svf();

  // Parameter values (all layers silent unless the drum type sets them)
  private tLevel = 0; private tPitch = 50; private tSweep = 24; private tWave = 0;
  private cLevel = 0; private cTone = 4000; private cReso = 0.3; private cNoise = 0.6;
  private drive = 1; private crush = 0; private driveComp = 1;
  private mLevel = 0; private mPitch = 400; private mSpread = 1; private mNoise = 0.3; private mMode = 0; private mFm = 0.5;
  private fmC = 0; private fmM = 0;
  // HAT BELL (level, partial phases / fades / fade rates) and RATTLE (amount; per hit: re-hits
  // left, samples to the next, the gate's pulse and depth, and their rates).
  private mBell = 0;
  private readonly bPhase = new Float64Array(BELL_PARTIALS);
  private readonly bEnv = new Float64Array(BELL_PARTIALS);
  private readonly bMul = new Float64Array(BELL_PARTIALS);
  private rattle = 0; private rLeft = 0; private rNext = 0; private rPulse = 0; private rDepth = 0;
  private readonly rGap: number; private readonly rPulseMul: number; private readonly rRelease: number;
  private tDecayMul = 0; private sweepMul = 0; private mDecayMul = 0; private cDecayMul = 0;
  private tRingMul = 0; private mRingMul = 0; private cRingMul = 0;
  private tDecay = 0.45; private mDecay = 0.2; private cLen = 0.004;
  // BALANCE gains per layer; PERC tuning (INTERVAL, DETUNE as frequency ratios).
  private gT = 1; private gC = 1; private gM = 1;
  private intervalMul = 2; private detuneMul = 1;
  // HAT head -> tail morph: head values, the tail's own tone, and how fast it morphs.
  private hTime = 0; private hMul = 0; private hPitch = 420; private hTone = 8500; private hNoise = 0.3;
  private hMode = 0; private hSpread = 1; private mTone = 6000;
  private hEnv = 0; private hCounter = 0;
  private tAtk = 0; private cAtk = 0; private mAtk = 0;
  /** Attack times in seconds (PERC derives the metal's from them). */
  private tAtkS = 0.0005; private cAtkS = 0.0005;
  // The LFO's filter destination: a low-pass from 20 kHz, only while it modulates.
  private filterOn = false; private filterMod = 0;
  private readonly chokeMul: number;
  /** The body's sweep never goes above this (Hz): 18 kHz, or below Nyquist at low rates. */
  private readonly sweepTop: number;
  // AIR: the mono room (its pre-EQ inside), scratch buffer, the level.
  private readonly room: AirRoom | null = null;
  private readonly airMono = new Float32Array(AIR_CHUNK);
  private airTarget = 0; private airGain = 0; private airIdle = true;
  /** AIR on but died away: skipped until the drum sounds again. */
  private readonly airGate: IdleGate;
  private readonly airK: number;
  /** Decay multipliers in use for the current hit (normal, ring or choke). */
  private tMul = 0; private mMul = 0; private cMul = 0;
  private ringing = false;
  /** The track's RING: RING decays x this. */
  private ringScale = 1;

  // Voice state: per layer an envelope value and stage (OFF / ATTACKING / DECAYING).
  private tune = 1;
  private pitchMod = 1;
  private tPhase = 0; private sweepEnv = 0;
  /** The sweep has died away to nothing (its 2^x is exactly 1) until the next hit or SWEEP change. */
  private sweepFlat = false;
  private readonly mPhase = new Float64Array(6);
  private tEnv = 0; private tStage = OFF;
  private mEnv = 0; private mStage = OFF;
  private cEnv = 0; private cStage = OFF;
  private impulse = false;
  private fCounter = 0;
  private velocity = 1;
  private crushPhase = 1; private held = 0;

  constructor(sampleRate: number, readonly params: readonly ParamSpec[], private readonly voice: DrumVoice) {
    this.sr = sampleRate;
    this.fadeLen = Math.max(1, Math.round(CUT_FADE * sampleRate));
    this.chokeMul = decayMul(CHOKE_SECONDS, sampleRate);
    this.sweepTop = Math.min(18000, 0.4 * sampleRate);
    this.rGap = RATTLE_GAP * sampleRate;
    this.rPulseMul = Math.exp(-1 / (RATTLE_PULSE * sampleRate));
    this.rRelease = Math.exp(-1 / (RATTLE_RELEASE * sampleRate));
    this.airK = 1 - Math.exp(-1 / (AIR_SMOOTH * sampleRate));
    this.airGate = new IdleGate(AIR_IDLE_SECONDS, sampleRate);
    if (voice.air) this.room = new AirRoom(sampleRate, voice.air.highPass, voice.air.lowPass);
    for (const p of Object.values(ALL)) this.setParam(p.id, p.defaultValue);
    this.tLevel = 0; this.cLevel = 0; this.mLevel = 0;
    for (const p of params) this.setParam(p.id, p.defaultValue);
  }

  /** The last sample out, and the retrigger fade: the value fading out and samples left. */
  private lastOut = 0;
  /** Output gain after DRIVE / CRUSH (evens the sounds out). */
  private oGain = 1;
  private fadeFrom = 0;
  private fadeLeft = 0;
  private fadeLen = 1;

  noteOn(note: number, velocity: number, _group: number, ring = false): void {
    // Still sounding: hand its last output to the retrigger fade.
    const sounding = this.tStage !== OFF || this.mStage !== OFF || this.cStage !== OFF;
    this.fadeFrom = sounding ? this.lastOut : 0;
    this.fadeLeft = sounding ? this.fadeLen : 0;
    this.ringing = ring;
    this.tMul = ring ? this.tRingMul : this.tDecayMul;
    this.mMul = ring ? this.mRingMul : this.mDecayMul;
    this.cMul = ring ? this.cRingMul : this.cDecayMul;
    this.tune = Math.pow(2, (note - 36) / 12);
    if (this.voice.relative) this.setupClick();
    this.velocity = velocity;
    this.tPhase = 0;
    this.sweepEnv = 1;
    this.sweepFlat = false;
    this.impulse = true;
    // Each layer starts its attack (or at full level when the attack is instant).
    this.tEnv = this.tAtk > 0 ? 0 : 1; this.tStage = this.tAtk > 0 ? ATTACKING : DECAYING;
    this.mEnv = this.mAtk > 0 ? 0 : 1; this.mStage = this.mAtk > 0 ? ATTACKING : DECAYING;
    this.cEnv = this.cAtk > 0 ? 0 : 1; this.cStage = this.cAtk > 0 ? ATTACKING : DECAYING;
    this.fCounter = 0;
    this.hEnv = this.hTime > 0 ? 1 : 0;
    this.hCounter = 0;
    if (this.mBell > 0) {
      for (let k = 0; k < BELL_PARTIALS; k++) {
        this.bPhase[k] = 0;
        this.bEnv[k] = 1;
        this.bMul[k] = Math.pow(this.mMul, BELL_FADES[k] - 1);
      }
    }
    this.rDepth = this.rattle > 0 ? 1 : 0;
    this.rLeft = RATTLE_HITS;
    this.rNext = Math.round(this.rGap);
    this.rPulse = 1;
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
    this.filterOn = octaves !== 0;
    this.fCounter = 0;
  }

  setParam(id: string, v: number): void {
    const sr = this.sr;
    switch (id) {
      case 't_level': this.tLevel = v; break;
      case 't_pitch': this.tPitch = v; this.updateMetal(); break;
      case 't_sweep': this.tSweep = v; this.sweepFlat = false; break;
      case 't_stime': this.sweepMul = decayMul(v, sr); break;
      case 't_attack': this.tAtkS = v; this.tAtk = attackInc(v, sr); this.updateMetalEnv(); break;
      case 't_decay': this.tDecay = v; this.updateMetalEnv(); this.updateDecays(); break;
      case 't_wave': this.tWave = Math.round(v); break;
      case 'c_level': this.cLevel = v; break;
      case 'c_tone': this.cTone = v; this.setupClick(); break;
      case 'c_reso': this.cReso = v; this.setupClick(); break;
      case 'c_noise': this.cNoise = v; break;
      case 'c_attack': this.cAtkS = v; this.cAtk = attackInc(v, sr); this.updateMetalEnv(); break;
      case 'c_len': this.cLen = v; this.updateMetalEnv(); this.updateDecays(); break;
      case 'm_level': this.mLevel = v; break;
      case 'm_pitch': if (!this.voice.relative) this.mPitch = v; break;
      case 'm_interval': this.intervalMul = Math.pow(2, Math.round(v) / 12); this.updateMetal(); break;
      case 'detune': this.detuneMul = Math.pow(2, v / 12); this.updateMetal(); this.setupClick(); break;
      case 'm_spread': this.mSpread = v; break;
      case 'm_noise': this.mNoise = v; break;
      case 'm_tone': this.mTone = v; this.mFilter.setup(v, 0.3, sr); break;
      case 'm_attack': if (!this.voice.relative) this.mAtk = attackInc(v, sr); break;
      case 'm_decay': if (!this.voice.relative) { this.mDecay = v; this.updateDecays(); } break;
      case 'm_bell': this.mBell = v; break;
      case 'h_rattle': this.rattle = v; break;
      case 'h_time': this.hTime = v; this.hMul = v > 0 ? Math.exp(-1 / (v * sr)) : 0; break;
      case 'h_pitch': this.hPitch = v; break;
      case 'h_tone': this.hTone = v; break;
      case 'h_noise': this.hNoise = v; break;
      case 'h_mode': this.hMode = v; break;
      case 'h_spread': this.hSpread = v; break;
      case 'm_mode': this.mMode = Math.min(2, Math.max(0, v)); break;
      case 'm_fm': this.mFm = v; break;
      case 'balance': {
        const g1 = Math.min(1, 2 * (1 - v)), g2 = Math.min(1, 2 * v);
        const [l1, l2] = this.voice.balance;
        const gain = (layer: string) => (l1.includes(layer) ? g1 : l2.includes(layer) ? g2 : 1);
        this.gT = gain('t'); this.gC = gain('c'); this.gM = gain('m');
        break;
      }
      case 'drive': this.drive = v; this.driveComp = driveCompGain(this.voice.driveRise, v); break;
      case 'crush': this.crush = v; break;
      case 'ogain': this.oGain = v; break;
      case 'air': this.airTarget = v * v * AIR_GAIN * (this.voice.air?.gain ?? 0); break;
      case 'airsize': this.room?.setSize(v); break;
    }
  }

  /** PERC: the metal's attack and decay sit halfway (in time) between the body's and the click's. */
  private updateMetalEnv(): void {
    if (!this.voice.relative) return;
    this.mAtk = attackInc((this.tAtkS + this.cAtkS) / 2, this.sr);
    this.mDecay = (this.tDecay + this.cLen) / 2;
  }

  /** PERC: the metal sits INTERVAL above the tone, detuned. */
  private updateMetal(): void {
    if (this.voice.relative) this.mPitch = this.tPitch * this.intervalMul * this.detuneMul;
  }

  /** The click's resonance (PERC: follows the note and DETUNE). */
  private setupClick(): void {
    const f = this.voice.relative ? this.cTone * this.tune * this.detuneMul : this.cTone;
    this.cFilter.setup(f, this.cReso, this.sr);
  }

  setRingLength(scale: number): void {
    if (scale === this.ringScale) return;
    this.ringScale = scale;
    this.updateDecays();
  }

  /** Normal decays, and RING ones ((decay x RING_STRETCH + the type's ring extension) x the track's RING). */
  private updateDecays(): void {
    const sr = this.sr;
    const extra = this.voice.ringExtra;
    const k = this.ringScale;
    this.tDecayMul = decayMul(this.tDecay, sr);
    this.mDecayMul = decayMul(this.mDecay, sr);
    this.cDecayMul = decayMul(this.cLen, sr);
    this.tRingMul = decayMul((this.tDecay * RING_STRETCH + extra) * k, sr);
    this.mRingMul = decayMul((this.mDecay * RING_STRETCH + extra) * k, sr);
    this.cRingMul = decayMul(this.cLen * RING_STRETCH * k, sr);
  }

  /**
   * AIR: the room on the track's output (in place), its tail through the type's fixed EQ.
   * Idle (and cleared) once AIR LVL is down at 0.
   */
  post(l: Float32Array, r: Float32Array, n: number): void {
    const room = this.room;
    if (!room) return;
    if (this.airTarget === 0 && this.airGain < 1e-5) {
      if (!this.airIdle) {
        room.reset();
        this.airGain = 0;
        this.airIdle = true;
      }
      return;
    }
    this.airIdle = false;
    if (this.airGate.skip(l, r, n)) return;
    const mono = this.airMono;
    for (let off = 0; off < n; off += AIR_CHUNK) {
      const m = Math.min(AIR_CHUNK, n - off);
      for (let i = 0; i < m; i++) mono[i] = (l[off + i] + r[off + i]) * 0.5;
      room.process(mono, mono, m);
      // Mono: the same tail on both sides (the track's PAN places it with the hit).
      for (let i = 0; i < m; i++) {
        this.airGain += (this.airTarget - this.airGain) * this.airK;
        const w = mono[i] * this.airGain;
        l[off + i] += w;
        r[off + i] += w;
      }
    }
    this.airGate.done(l, r, n);
  }

  cut(): void {
    if (this.tStage === OFF && this.mStage === OFF && this.cStage === OFF) return;
    // As a retrigger without the new hit: the last value fades out.
    this.fadeFrom = this.lastOut;
    this.fadeLeft = this.fadeLen;
    this.tStage = OFF; this.mStage = OFF; this.cStage = OFF;
    this.tEnv = 0; this.mEnv = 0; this.cEnv = 0;
    this.ringing = false;
  }

  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void {
    if (this.tStage === OFF && this.mStage === OFF && this.cStage === OFF && this.fadeLeft === 0) {
      this.lastOut = 0;
      return;
    }
    const dtBase = 1 / this.sr;
    // Sample-rate reduction: a new sample every 1 + crush^2 x 24 samples, on a fractional
    // clock so the rate falls smoothly (whole-sample holds jumped 48 -> 24 kHz at 0.2).
    const step = 1 / (1 + this.crush * this.crush * 24);
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
        // Held below the top of the hearing range (a long sweep from a high start). The sweep
        // only falls, so once 2^x is exactly 1 it stays 1: skip the pow from then on.
        let sweep = 1;
        if (!this.sweepFlat) {
          sweep = exp2((this.tSweep * this.sweepEnv) / 12);
          if (sweep === 1) this.sweepFlat = true;
        }
        const f = Math.min(tPitch * sweep, this.sweepTop);
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
          default: osc = sinTurn(ph);
        }
        sum += osc * this.tEnv * this.tLevel * this.gT;
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
          m += wFm * sinRad(TWO_PI * this.fmC + index * sinTurn(this.fmM));
        }
        m = m * (1 - mNoise) + this.noise.next() * mNoise;
        this.mFilter.process(m);
        let metal = this.mFilter.high * this.mLevel;
        // BELL: sine partials at a cymbal bell's ratios, past the high-pass, each fading at its own rate.
        if (this.mBell > 0) {
          let b = 0;
          const bp = this.bPhase, be = this.bEnv;
          for (let k = 0; k < BELL_PARTIALS; k++) {
            bp[k] += mPitch * BELL_RATIOS[k] * dtBase;
            if (bp[k] >= 1) bp[k] -= 1;
            b += sinTurn(bp[k]) * BELL_LEVELS[k] * be[k];
            be[k] *= this.bMul[k];
          }
          metal += b * this.mBell * BELL_GAIN;
        }
        // RATTLE: the jingles' quick re-hits (a gate that snaps open at each and closes fast).
        if (this.rDepth > 0) {
          if (--this.rNext <= 0 && this.rLeft > 0) {
            this.rLeft--;
            this.rPulse = 1;
            this.rNext = Math.round(this.rGap * (0.7 + 0.6 * Math.abs(this.noise.next())));
          }
          if (this.rLeft === 0) this.rDepth *= this.rRelease;
          metal *= 1 - this.rattle * this.rDepth * (1 - this.rPulse);
          this.rPulse *= this.rPulseMul;
        }
        sum += metal * this.mEnv * this.gM;
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
        sum += this.cFilter.band * this.cEnv * this.cLevel * 2 * this.gC;
        if (this.cStage === ATTACKING) {
          this.cEnv += this.cAtk;
          if (this.cEnv >= 1) { this.cEnv = 1; this.cStage = DECAYING; }
        } else {
          this.cEnv *= this.cMul;
          if (this.cEnv < 1e-5) { this.cEnv = 0; this.cStage = OFF; }
        }
      }

      // LFO FILTER (only while modulating), DRIVE, CRUSH
      let out = sum * this.velocity;
      if (this.filterOn) {
        if (this.fCounter-- <= 0) {
          this.fCounter = FILTER_UPDATE;
          const fc = 20000 * Math.pow(2, this.filterMod);
          this.filter.setup(fc < 20 ? 20 : fc, 0, this.sr);
        }
        this.filter.process(out);
        out = this.filter.low;
      }
      if (this.drive > 1) out = tanh(out * this.drive) * driveNorm * 0.8 * this.driveComp;
      if (this.crush > 0) {
        this.crushPhase += step;
        if (this.crushPhase >= 1) {
          this.crushPhase -= 1;
          this.held = Math.round(out * levels) / levels;
        }
        out = this.held;
      }
      if (this.fadeLeft > 0) {
        // The cut-off hit's last value, faded out on a half cosine.
        out += this.fadeFrom * (0.5 - 0.5 * Math.cos((Math.PI * this.fadeLeft) / this.fadeLen));
        this.fadeLeft--;
      }
      this.lastOut = out;
      outL[i] += out * this.oGain;
      outR[i] += out * this.oGain;
    }
  }
}
