import { MIX_PARAMS, dynVelocity } from './mixParams';
import { CELLS_PER_BAR, parseAutoKey, valueAt, type AutoKind } from './automation';
import type { ParamSpec } from './params';
import type { MainToWorklet, WorkletToMain } from './protocol';
import { Smoother } from './smoother';
import {
  DYNAMIC_VELOCITY, MAX_STEPS, NUM_CHANNELS, NUM_PATTERNS, SONG_MAX_ROWS, STEP_NOTES, type Song,
  type InstrumentKind, type Project, type Step, patchOf,
} from './project';
import { MAX_CHORD_NOTES, chordVoicing } from './chords';
import type { Instrument } from '../instruments/Instrument';
import { INSTRUMENTS, SOUND_KINDS, linkedParams, liveContribution, liveTargets, playsChords } from '../instruments/registry';
import { toNorm, toValue } from './params';
import { ARP_PARAMS, ARP_RATES, defaultArp, type ArpId } from './arp';
import { ROLL_DIVS } from '../instruments/Drum';
import { Noise, Svf, silent } from '../instruments/dsp';
import { LFO_PARAMS, LFO_RATES, lfoValue, type LfoId } from './lfo';
import { FxBus } from '../fx/FxBus';
import { Limiter } from '../fx/Limiter';
import { Click } from '../instruments/Click';
import { BUS_PARAMS, NUM_BUSES } from '../fx/buses';
import { TrackCut } from '../fx/TrackCut';
import type { MixParam } from './protocol';
import { METERS, NUM_SENDS, meterLength, meterPlays, speedSteps, type PatternSpeed } from './project';

/** PAD / PLUCK notes held at once by their own lengths, per channel (more than the voices: tails overlap). */
const HOLDS = 12;
/** PAD / PLUCK live recording: keys pressed within this long (s) of a chord's first key join its step. */
const CHORD_WINDOW = 0.08;
/** Largest chunk rendered at once (also the LFO pitch update rate, ~1.3 ms at 48 kHz). */
const CHUNK = 64;
/** Max sound parameters per instrument that can be locked per step. */
export const LOCK_SLOTS = 32;

const STEP_SLOTS = NUM_CHANNELS * NUM_PATTERNS * MAX_STEPS;
/** Shortest patch glide (an immediate pattern switch), and the glide back from a cancelled switch, s. */
const MIN_PATCH_GLIDE = 0.05;
const CANCEL_PATCH_GLIDE = 0.2;
/** The hit tone (velocity colour) moves to a new hit's cutoff over about this long, s: no click on legato / tied notes. */
const TONE_SMOOTH = 0.003;

/**
 * Per-hit tone: the channel output passes a gentle 12 dB low-pass whose cutoff follows the
 * hit velocity, so accents are fully bright and ghost notes softer and darker, like a real
 * player hitting harder or lighter.
 */
export function hitToneCutoff(velocity: number): number {
  return 20000 * Math.pow(2, -(1 - Math.min(1, Math.max(0, velocity))) * 3.2);
}

export type RecordedMsg = Extract<WorkletToMain, { type: 'recordedNote' | 'recordedLock' | 'recordedChord' }>;

/**
 * Pure audio engine: sequencer, instruments, mixer, master. No DOM, no Web Audio.
 * The worklet (or a Node test) calls handleMessage() and process().
 *
 * Allocation-free in process(); step data lives in preallocated typed arrays.
 * Timing: a global 16th-note clock (with swing) drives every channel; each channel
 * keeps its own position and loops at its own length (polymeter). Steps fire at the
 * exact sample inside a block. The time signature sets the bar (bar lines: pattern
 * switches, song rows, RESET); steps that do not play (time signature, triplet time,
 * STEPS) take no time.
 */
export class Engine {
  readonly sampleRate: number;
  playing = false;
  frame = 0;
  peakL = 0;
  peakR = 0;
  /** Step index last played per channel (-1 when stopped). */
  readonly currentStep = new Int16Array(NUM_CHANNELS).fill(-1);
  /** Pattern currently playing per channel. */
  readonly activePattern = new Uint8Array(NUM_CHANNELS);
  /** Song playback: the row playing (-1 = not playing the song) and the bar within it. */
  songRow = -1;
  songBar = 0;
  /** Called when motion recording writes into a pattern (event rate, not per block). */
  onRecorded: ((msg: RecordedMsg) => void) | null = null;

  private bpm = 128;
  private swing = 0; // 0..0.5 fraction of a step
  private readonly master: Smoother;
  private readonly limiter: Limiter;
  /** SONG automation: one lane per knob with locked values (compiled from the song). */
  private lanes: Lane[] = [];
  /** Each song row's first bar, counted from the song's start. */
  private readonly rowStart = new Int32Array(SONG_MAX_ROWS + 1);
  /** Played step of the bar -> its strip cell (the time signature's dark cells skipped). */
  private readonly cellOf = new Uint8Array(16);
  /** The values set by the user (not automation), restored when a lane lets go: by lane key. */
  private readonly autoBase = new Map<string, number>();
  /** Automation is setting a value now (setters then don't record it as the user's). */
  private autoApplying = false;
  /** The song just started: the lanes' first values land at once (no mixer glide). */
  private autoSnap = false;
  /** A track's sound was set by something else (pattern switch, glide): its lanes re-apply. */
  private readonly autoStale = new Uint8Array(NUM_CHANNELS);
  /** METRONOME / COUNT-IN: the click, its level (0 = silent), whether it plays with the music. */
  private readonly click: Click;
  private clickBuf = new Float32Array(1024);
  /** The click wrote into clickBuf this block. */
  private clicked = false;
  private clickLevel = 0;
  private clickOn = false;
  /** Master steps of COUNT-IN still to go before the sequencer starts (and how many in all). */
  private countLeft = 0;
  private countTotal = 0;
  /** The LFO clock the music starts on (the count-in runs on its own). */
  private lfoStartClock = 0;
  /** Which master steps of the bar start a beat (the time signature's groups). */
  private readonly beatAt = new Uint8Array(16);

  /** How late the player hears the engine, in frames, besides the limiter (setListenLatency). */
  private listenFrames = 0;

  /** Output latency in frames (the master limiter's look-ahead). */
  get latency(): number {
    return this.limiter.len;
  }

  // Step data: index = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + step
  private readonly stepActive = new Uint8Array(STEP_SLOTS);
  private readonly stepNote = new Float32Array(STEP_SLOTS);
  private readonly stepVel = new Float32Array(STEP_SLOTS);
  private readonly stepAccent = new Uint8Array(STEP_SLOTS);
  private readonly stepRing = new Uint8Array(STEP_SLOTS);
  private readonly stepRest = new Uint8Array(STEP_SLOTS);
  private readonly stepSlide = new Uint8Array(STEP_SLOTS);
  /** Hits per step (ROLL), 1 = a single hit. */
  /** Note length in steps (1 = until the next step starts). */
  private readonly stepGate = new Uint8Array(STEP_SLOTS).fill(1);
  /** PAD / PLUCK chords: a step's further notes (STEP_NOTES - 1 slots each) and how many. */
  private readonly stepExtra = new Float32Array(STEP_SLOTS * (STEP_NOTES - 1));
  private readonly stepExtraN = new Uint8Array(STEP_SLOTS);
  /** Each PAD / PLUCK chord note's own length in steps (Step.extraGate; default the step's gate). */
  private readonly stepExtraGate = new Int16Array(STEP_SLOTS * (STEP_NOTES - 1));
  /** Each step's locks as set (Step.locks: a key per knob, automation.ts), null = none. */
  private readonly stepLockSrc: (Record<string, number> | null)[] = new Array<Record<string, number> | null>(STEP_SLOTS).fill(null);
  /**
   * Pattern locks as lanes, one per knob (positions = steps): [ch * NUM_PATTERNS + pattern].
   * They glide from lock to lock as the pattern plays, like the SONG's (rebuilt when a step
   * changes, outside the audio loop: flushPatLanes).
   */
  private readonly patLanes: Lane[][] = Array.from({ length: NUM_CHANNELS * NUM_PATTERNS }, () => []);
  private readonly patLanesDirty = new Uint8Array(NUM_CHANNELS * NUM_PATTERNS);
  private patDirty = false;
  /** The pattern whose lanes each track last ran (-1 = none). */
  private readonly lanePat = new Int8Array(NUM_CHANNELS).fill(-1);
  /** Each track's step now: frames played of it, and its length (for gliding between locks). */
  private readonly chanElapsed = new Float64Array(NUM_CHANNELS);
  private readonly chanLen = new Float64Array(NUM_CHANNELS).fill(1);
  /** SONG lanes by key: a pattern lane gives way while the song's holds the same knob. */
  private songLaneByKey = new Map<string, Lane>();
  /** STEPS: the step is switched the other way from the time signature. */
  private readonly stepFlip = new Uint8Array(STEP_SLOTS);
  /** Whether each step plays (time signature, triplet time, STEPS); others are skipped. */
  private readonly stepOn = new Uint8Array(STEP_SLOTS).fill(1);
  private readonly patternLength = new Uint8Array(NUM_CHANNELS * NUM_PATTERNS).fill(16);
  /** Per pattern: one step's length in master 16ths (1; double time 0.5; half time 2). */
  private readonly patternRate = new Float32Array(NUM_CHANNELS * NUM_PATTERNS).fill(1);
  /**
   * Per track, where its current step started (master steps, fractional), how long its
   * steps are (master steps) and how many it has played (unwrapped): live recording places
   * notes on the track's own steps.
   */
  private readonly chanAt = new Float64Array(NUM_CHANNELS);
  private readonly chanRate = new Float64Array(NUM_CHANNELS).fill(1);
  private readonly chanCount = new Float64Array(NUM_CHANNELS).fill(-1);
  /**
   * Steps between master steps (double time: one halfway; triplet: two more in the beat):
   * frames until the next (-1 = none), their length, how many are left, and the master
   * position of the next and the distance between them (master steps).
   */
  private readonly subAt = new Float64Array(NUM_CHANNELS).fill(-1);
  private readonly subLen = new Float64Array(NUM_CHANNELS);
  private readonly subLeft = new Uint8Array(NUM_CHANNELS);
  private readonly subPos = new Float64Array(NUM_CHANNELS);
  private readonly subStep = new Float64Array(NUM_CHANNELS);
  /** The track's next step starts its loop. */
  private readonly loopStart = new Uint8Array(NUM_CHANNELS).fill(1);
  /** The track's last loop started off a bar line (drifting): a pattern switch lands on the next bar line. */
  private readonly offGrid = new Uint8Array(NUM_CHANNELS);
  /** Time signature (index into METERS), its bar in 16ths, the master step its bars count from, and a change waiting for the bar line. */
  private meter = 0;
  private barLen = 16;
  private barOrigin = 0;
  private pendingMeter = -1;

  private readonly pendingPattern = new Int8Array(NUM_CHANNELS).fill(-1);
  private readonly position = new Uint8Array(NUM_CHANNELS);
  /** Step index whose trigger is skipped once (a live note was already played for it). */
  private readonly skipStep = new Int16Array(NUM_CHANNELS).fill(-1);
  private globalStep = 0;
  private framesToStep = 0;
  private lastStepFrames = 1;

  // Channels
  private readonly instruments: Record<string, Instrument>[] = [];
  private readonly current: (Instrument | null)[] = [];
  private readonly kind: InstrumentKind[] = new Array(NUM_CHANNELS).fill('none');
  /** Channel's own sound values per param slot (what applies when no lock). */
  private readonly baseValue = new Float32Array(NUM_CHANNELS * LOCK_SLOTS);
  /** Each pattern's patch: [(ch * NUM_PATTERNS + pattern) * LOCK_SLOTS + slot]. */
  private readonly patchValue = new Float32Array(NUM_CHANNELS * NUM_PATTERNS * LOCK_SLOTS);
  /**
   * Patch glides: a track's sound moving (normalised, per slot) to pattern glidePattern's
   * patch, over glideTotal frames (to the bar line its pattern switch lands on). Coarse
   * parameters switch when the pattern does. -1 = no glide.
   */
  private readonly glidePattern = new Int8Array(NUM_CHANNELS).fill(-1);
  private readonly glideFrom = new Float32Array(NUM_CHANNELS * LOCK_SLOTS);
  private readonly glideTo = new Float32Array(NUM_CHANNELS * LOCK_SLOTS);
  private readonly glideDone = new Float64Array(NUM_CHANNELS);
  private readonly glideTotal = new Float64Array(NUM_CHANNELS);
  /** The glide waits for a song row to switch the pattern (a waiting switch: pendingPattern). */
  private readonly glideWait = new Uint8Array(NUM_CHANNELS);
  /** RESET (notes too): a pattern's saved notes, swapped in at the next bar line. */
  private readonly pendingNotes: ({ length: number; steps: Step[]; speed?: PatternSpeed } | null)[] = new Array(NUM_CHANNELS * NUM_PATTERNS).fill(null);
  private notesPending = false;
  /** A pattern lock holds this channel / param slot now (base value changes wait). */
  private readonly lockApplied = new Uint8Array(NUM_CHANNELS * LOCK_SLOTS);
  /**
   * Relative LIVE knobs: each channel's offsets (live id -> -1..1), and their summed push
   * per param slot in normalised units, added on top of the base (or locked) value.
   */
  private readonly liveOffsets: Map<string, number>[] = Array.from({ length: NUM_CHANNELS }, () => new Map());
  private readonly offsetNorm = new Float32Array(NUM_CHANNELS * LOCK_SLOTS);
  private readonly prevOffset = new Float32Array(LOCK_SLOTS);
  private readonly volume: Smoother[] = [];
  private readonly pan: Smoother[] = [];
  private readonly toneL: Svf[] = [];
  private readonly toneR: Svf[] = [];
  /** The hit tone's cutoff now and where it is going (Hz). */
  private readonly toneNow = new Float32Array(NUM_CHANNELS).fill(hitToneCutoff(1));
  private readonly toneTarget = new Float32Array(NUM_CHANNELS).fill(hitToneCutoff(1));
  private readonly volumeValue = new Float32Array(NUM_CHANNELS).fill(0.8);
  /** The track type's output trim (InstrumentEntry.gain), applied with the volume. */
  private readonly typeGain = new Float32Array(NUM_CHANNELS).fill(1);
  /** Chord mode per channel (index into CHORDS). */
  private readonly chord = new Uint8Array(NUM_CHANNELS);
  private readonly notes = new Uint8Array(NUM_CHANNELS).fill(MAX_CHORD_NOTES);
  /**
   * PAD / PLUCK: sequenced notes held each by its own length (each its own voice group), so a note
   * tied on keeps sounding under later ones: note (-1 = free), steps left, and a pending
   * early / late release (frames, -1 = none), HOLDS per channel.
   */
  private readonly holdNote = new Int16Array(NUM_CHANNELS * HOLDS).fill(-1);
  private readonly holdSteps = new Int16Array(NUM_CHANNELS * HOLDS);
  private readonly holdAt = new Float64Array(NUM_CHANNELS * HOLDS).fill(-1);
  /** Steps until the sequenced note on a channel is released (0 = none held). */
  private readonly gateSteps = new Int16Array(NUM_CHANNELS);
  /** GATE per track (steps the last step of a note is held), and a pending early / late release (frames, -1 = none). */
  private readonly gateLength = new Float64Array(NUM_CHANNELS).fill(1);
  private readonly gateAt = new Float64Array(NUM_CHANNELS).fill(-1);
  /** Each track's MID CUT (after its DRIVE and onboard FX). */
  private readonly cuts: TrackCut[] = [];
  private readonly gateGroup = new Int16Array(NUM_CHANNELS);
  /** The held note is a RING note: it ends at the next hit or rest, not by count. */
  private readonly ringing = new Uint8Array(NUM_CHANNELS);
  /** Live recording: the held note per channel (-1 = none) and where it started. */
  private readonly recNote = new Int16Array(NUM_CHANNELS).fill(-1);
  /** When the note being recorded was played (engine frames): PAD / PLUCK chord keys near it join it. */
  private readonly recFrame = new Float64Array(NUM_CHANNELS);
  private readonly recStart = new Float64Array(NUM_CHANNELS);
  private readonly recIndex = new Int16Array(NUM_CHANNELS);
  private readonly recPattern = new Int8Array(NUM_CHANNELS);
  private readonly recVel = new Float32Array(NUM_CHANNELS);
  private readonly recAccent = new Uint8Array(NUM_CHANNELS);
  /**
   * PAD / PLUCK live recording: notes that joined a step's chord and are still held (-1 = free
   * slot), each with its step and start, so its release sets its own length.
   */
  private readonly chordNote = new Int16Array(NUM_CHANNELS * STEP_NOTES).fill(-1);
  private readonly chordSlot = new Int32Array(NUM_CHANNELS * STEP_NOTES);
  private readonly chordStart = new Float64Array(NUM_CHANNELS * STEP_NOTES);
  private readonly recSlide = new Uint8Array(NUM_CHANNELS);
  /** The held note came from a SLIDE step: the next note glides out of it. */
  private readonly sliding = new Uint8Array(NUM_CHANNELS);
  /** Drum tracks: hits per step of a ROLL step (ROLL DIV; the SLIDE flag). 0 = not a drum. */
  /** ROLL RATE: hits per 16th at the tempo (below 1: a hit every few 16ths); 0 = not a drum. */
  private readonly rollDiv = new Float64Array(NUM_CHANNELS);
  /** ROLL held below a hit a 16th: 16ths since it began (every 1 / rate-th plays). */
  private readonly holdRollCount = new Uint32Array(NUM_CHANNELS);
  /** The master step a track's own hit last started on (-1 = none), and its note: held ROLL plays over it. */
  private readonly hitStep = new Float64Array(NUM_CHANNELS).fill(-1);
  private readonly hitNote = new Uint8Array(NUM_CHANNELS);
  /** MUTE: the sequencer starts no new notes on the track (sounding ones play out). */
  private readonly muted = new Uint8Array(NUM_CHANNELS);
  // Song: per row its bars and per track its pattern (-1 = silent), row count, playback state.
  private readonly songBars = new Uint8Array(SONG_MAX_ROWS);
  private readonly songPatterns = new Int8Array(SONG_MAX_ROWS * NUM_CHANNELS);
  private songLength = 0;
  private songOn = false;
  private songJumpTo = -1;
  /** Track silent in the current song row. */
  private readonly songOff = new Uint8Array(NUM_CHANNELS);
  // ROLL: repeats still to play inside the current step, frames until the next one, spacing.
  private readonly rollLeft = new Uint8Array(NUM_CHANNELS);
  private readonly rollAt = new Float64Array(NUM_CHANNELS);
  private readonly rollEvery = new Float64Array(NUM_CHANNELS);
  private readonly rollNote = new Float32Array(NUM_CHANNELS);
  private readonly rollVel = new Float32Array(NUM_CHANNELS);
  /** The roll run: its end velocity, hits played, steps still to come. */
  private readonly rollVelEnd = new Float32Array(NUM_CHANNELS);
  /** Hits over which the velocity ramps from the run's first step to its end. */
  private readonly rollRamp = new Uint16Array(NUM_CHANNELS);
  private readonly rollIndex = new Uint16Array(NUM_CHANNELS);
  private readonly runLeft = new Uint16Array(NUM_CHANNELS);
  /** ROLL held down (PLAY / DESIGN, drums): the track repeats at ROLL RATE, and the note it strikes. */
  private readonly holdRoll = new Uint8Array(NUM_CHANNELS);
  private readonly holdRollNote = new Float32Array(NUM_CHANNELS).fill(36);
  // ARP (a track setting, engine/arp.ts): while a note is held its chord tones are played in
  // turn. On / off (the ARP key) and MODE as set, the mode in use (0 = off: off or MODE OFF),
  // rate in steps, and per track the held root, its velocity, the next note's index, frames
  // until it, and the arp note sounding now (-1 = none).
  private readonly arpOn = new Uint8Array(NUM_CHANNELS);
  private readonly arpSet = new Uint8Array(NUM_CHANNELS);
  private readonly arpMode = new Uint8Array(NUM_CHANNELS);
  private readonly arpSteps = new Float32Array(NUM_CHANNELS).fill(1);
  private readonly arpOct = new Uint8Array(NUM_CHANNELS).fill(1);
  private readonly arpHeld = new Uint8Array(NUM_CHANNELS);
  private readonly arpRoot = new Float32Array(NUM_CHANNELS);
  private readonly arpVel = new Float32Array(NUM_CHANNELS);
  private readonly arpIndex = new Int32Array(NUM_CHANNELS);
  private readonly arpAt = new Float64Array(NUM_CHANNELS);
  private readonly arpNote = new Float32Array(NUM_CHANNELS).fill(-1);
  private readonly arpNoise = new Noise(0xa29);
  private readonly scratchL = new Float32Array(CHUNK);
  private readonly scratchR = new Float32Array(CHUNK);


  // FX 1-3 (buses.ts). FX 1: member tracks pass through it (COMP) instead of going straight
  // out. FX 2 / FX 3 (index 1 / 2) are sends: each track feeds at most one.
  private readonly buses: FxBus[] = [];
  private readonly inDrumBus = new Uint8Array(NUM_CHANNELS);
  private readonly route = new Int8Array(NUM_CHANNELS).fill(-1); // bus index or -1
  private readonly sendLevel: Smoother[] = [];
  /** ACC/GHOST depth per track (1 = as designed; see dynVelocity). */
  private readonly dynDepth = new Float32Array(NUM_CHANNELS).fill(1);
  /** PLAY mode RING / SLIDE: every hit on the track plays with that flag (not stored). */
  private readonly forceRing = new Uint8Array(NUM_CHANNELS);
  private readonly forceSlide = new Uint8Array(NUM_CHANNELS);
  /** PLAY mode ACCENT / GHOST: every hit at this velocity (0 = the step's own). */
  private readonly forceVel = new Float32Array(NUM_CHANNELS);
  private readonly busL: Float32Array[] = [];
  private readonly busR: Float32Array[] = [];

  // The LFO, shared by the tracks on it; phase-locked to the song (lfoClock counts 16th steps).
  private lfoClock = 0;
  private lfoSteps = 4;
  private lfoRate = 0;
  private lfoShape = 0;
  private lfoMorph = 0;
  private lfoFm = 0;
  private lfoVol = 0;
  private lfoPitch = 0;
  private lfoFilter = 0;
  private lfoPan = 0;
  private lfoPhase = 0;
  private lfoSmooth = 0;
  private lfoFade = 0; // in steps
  private lfoRetrig = false;
  private lfoSend = 0;
  private lfoSpread = 0;
  /** Per track on the LFO: its value -1..1 per sample of the current chunk ... */
  private readonly lfoBuf = new Float32Array(NUM_CHANNELS * CHUNK);
  /** ... its smoothed level, S+H level and cycle, and where its last note started. */
  private readonly lfoY = new Float32Array(NUM_CHANNELS);
  private readonly lfoHeld = new Float32Array(NUM_CHANNELS);
  private readonly lfoCycle = new Float64Array(NUM_CHANNELS).fill(-1);
  private readonly lfoTrig = new Float64Array(NUM_CHANNELS);
  private readonly lfoOn = new Uint8Array(NUM_CHANNELS);
  private readonly pitchModOn = new Uint8Array(NUM_CHANNELS);
  private readonly filterModOn = new Uint8Array(NUM_CHANNELS);
  private readonly fmModOn = new Uint8Array(NUM_CHANNELS);
  private readonly lfoNoise = new Noise(0x1f0);

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.master = new Smoother(0.8, 0.02, sampleRate);
    this.limiter = new Limiter(sampleRate);
    this.click = new Click(sampleRate);
    this.beatAt[0] = this.beatAt[4] = this.beatAt[8] = this.beatAt[12] = 1;
    for (let k = 0; k < NUM_BUSES; k++) {
      this.buses.push(new FxBus(sampleRate, k));
      this.busL.push(new Float32Array(CHUNK));
      this.busR.push(new Float32Array(CHUNK));
    }
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      this.sendLevel.push(new Smoother(0.5, 0.02, sampleRate));
    }
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const set: Record<string, Instrument> = {};
      for (const kind of SOUND_KINDS) set[kind] = INSTRUMENTS[kind].create(sampleRate);
      this.instruments.push(set);
      this.cuts.push(new TrackCut(sampleRate));
      this.current.push(null);
      this.volume.push(new Smoother(0.8, 0.02, sampleRate));
      this.pan.push(new Smoother(0, 0.02, sampleRate));
      const l = new Svf();
      const r = new Svf();
      l.setup(hitToneCutoff(1), 0, sampleRate);
      r.setup(hitToneCutoff(1), 0, sampleRate);
      this.toneL.push(l);
      this.toneR.push(r);
    }
  }

  handleMessage(msg: MainToWorklet): void {
    switch (msg.type) {
      case 'loadProject': this.loadProject(msg.project); break;
      case 'setStep': this.writeStep(msg.channel, msg.pattern, msg.index, msg.step); break;
      case 'setPatternLength':
        this.patternLength[msg.channel * NUM_PATTERNS + msg.pattern] = Math.max(1, Math.min(MAX_STEPS, msg.length));
        break;
      case 'setPatternSpeed': {
        const k = msg.channel * NUM_PATTERNS + msg.pattern;
        this.patternRate[k] = speedSteps(msg.speed);
        this.refreshOn(k);
        break;
      }
      case 'selectPattern': this.selectPattern(msg.channel, msg.pattern, msg.immediate); break;
      case 'setSound': this.setPatchSound(msg.channel, msg.pattern ?? this.editedPattern(msg.channel), msg.id, msg.value); break;
      case 'setPatch': this.setPatch(msg.channel, msg.pattern, msg.sound, msg.glide); break;
      case 'swapNotes': this.swapNotes(msg.channel, msg.pattern, msg.length, msg.steps, msg.speed); break;
      case 'setOffset': this.setOffset(msg.channel, msg.id, msg.value); break;
      case 'setMix': this.setMix(msg.channel, msg.id, msg.value); break;
      case 'setListenLatency': this.listenFrames = Math.max(0, msg.ms) * 0.001 * this.sampleRate; break;
      case 'setGlobal':
        if (msg.id === 'bpm') { this.bpm = msg.value; for (const b of this.buses) b.setTempo(msg.value); this.instrumentTempo(); }
        else if (msg.id === 'swing') this.swing = (msg.value - 50) / 50;
        else if (msg.id === 'master') this.master.setTarget(msg.value);
        else if (msg.id === 'meter') this.setMeter(msg.value);
        break;
      case 'setRouting': this.route[msg.channel] = this.busIndex(msg.send); break;
      case 'setDrumBus': this.inDrumBus[msg.channel] = msg.on ? 1 : 0; break;
      case 'setBus': this.setBusParam(msg.bus, msg.id, msg.value); break;
      case 'setLfo': this.setLfo(msg.id, msg.value); break;
      case 'setLfoTrack': this.lfoOn[msg.channel] = msg.on ? 1 : 0; break;
      case 'setArp': this.setArp(msg.channel, msg.id, msg.value); break;
      case 'holdRoll': this.setHoldRoll(msg.channel, msg.on, msg.note); break;
      case 'transport':
        if (msg.playing && !this.playing) {
          this.songOn = msg.song === true && this.songLength > 0;
          this.songRow = this.songOn ? Math.max(0, Math.min(this.songLength - 1, msg.fromRow ?? 0)) : -1;
          this.songBar = -1; // the row is entered on the first step
          this.setPlaying(true);
          if (!this.songOn && msg.fromStep) this.startAt(msg.fromChannel ?? 0, msg.fromStep);
          if (this.songOn && msg.fromBar) this.startSongAt(Math.max(0, Math.min(this.songBars[this.songRow] - 1, Math.round(msg.fromBar))));
          this.countTotal = this.countLeft = Math.max(0, Math.round(msg.countIn ?? 0)) * this.barLen;
          this.autoSnap = this.songOn;
          this.lfoStartClock = this.lfoClock;
        }
        this.setPlaying(msg.playing);
        break;
      case 'setSong': this.setSong(msg.song); break;
      case 'setClick':
        this.clickOn = msg.on;
        this.clickLevel = Math.max(0, Math.min(1, msg.level));
        break;
      case 'songJump':
        if (!this.songOn) break;
        this.songJumpTo = Math.max(0, Math.min(this.songLength - 1, msg.row));
        this.glideToRow(this.songJumpTo, this.framesAhead((this.barLen - this.barPos(this.globalStep)) % this.barLen));
        break;
      case 'trigger': this.noteOn(msg.channel, msg.note, msg.velocity, false, msg.slideFrom ?? -1); break;
      case 'release': this.release(msg.channel, msg.note); break;
      case 'setInstrument': this.setInstrument(msg.channel, msg.kind, msg.sound); break;
      case 'setChord': this.chord[msg.channel] = msg.chord; break;
      case 'setNotes': this.notes[msg.channel] = msg.notes; break;
      case 'setForce':
        this.forceRing[msg.channel] = msg.ring ? 1 : 0;
        this.forceSlide[msg.channel] = msg.slide ? 1 : 0;
        this.forceVel[msg.channel] = msg.velocity ?? 0;
        break;
      case 'recordNote':
        if (msg.chord && this.recordChordNote(msg.channel, msg.note, msg.velocity)) break;
        this.recordNote(msg.channel, msg.note, msg.velocity, msg.accent, msg.slide === true);
        break;
      case 'recordLock': this.recordLock(msg.channel, msg.id, msg.value); break;
      case 'ping': break; // answered by the host
    }
    if (this.patDirty) this.flushPatLanes();
  }

  /** A lane for a knob key (automation.ts) and its points, or null for an unknown key. */
  private makeLane(key: string, points: readonly (readonly [number, number])[]): Lane | null {
    const t = parseAutoKey(key);
    if (!t || points.length === 0) return null;
    const lane = new Lane(key, t.kind, t.index, t.id, points.length);
    points.forEach(([p, v], i) => { lane.pos[i] = p; lane.val[i] = v; });
    lane.spec = t.kind === 'm' ? MIX_PARAMS.find((s) => s.id === t.id) ?? null
      : t.kind === 'b' ? BUS_PARAMS[t.index]?.find((s) => s.id === t.id) ?? null
      : t.kind === 'l' ? LFO_PARAMS[t.id as LfoId] ?? null
      : t.kind === 'a' ? ARP_PARAMS.find((s) => s.id === t.id) ?? null : null;
    return lane;
  }

  /** Rebuild the lanes of patterns whose steps' locks changed. */
  private flushPatLanes(): void {
    this.patDirty = false;
    for (let k = 0; k < this.patLanes.length; k++) {
      if (!this.patLanesDirty[k]) continue;
      this.patLanesDirty[k] = 0;
      const ch = Math.floor(k / NUM_PATTERNS);
      for (const lane of this.patLanes[k]) if (lane.active) this.releasePatLane(lane);
      const points = new Map<string, [number, number][]>();
      for (let i = 0; i < MAX_STEPS; i++) {
        const src = this.stepLockSrc[k * MAX_STEPS + i];
        if (!src) continue;
        for (const id in src) {
          // The track's own sound params are stored by their bare id.
          const key = id.includes(':') ? id : `s:${ch}:${id}`;
          let pts = points.get(key);
          if (!pts) points.set(key, (pts = []));
          pts.push([i, src[id]]);
        }
      }
      const lanes: Lane[] = [];
      for (const [key, pts] of points) {
        const lane = this.makeLane(key, pts);
        if (lane) lanes.push(lane);
      }
      this.patLanes[k] = lanes;
    }
  }

  /**
   * Pattern locks for this chunk: each track's lanes at its position in its pattern (step +
   * the part of it played). A lane lets go before its first lock and when its pattern stops
   * playing; after its last it holds until the loop starts again.
   */
  private runPatAuto(): void {
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const pat = this.activePattern[ch];
      if (this.lanePat[ch] !== pat) {
        this.releasePatLanes(ch);
        this.lanePat[ch] = pat;
      }
      const lanes = this.patLanes[ch * NUM_PATTERNS + pat];
      if (lanes.length === 0) continue;
      const idx = this.currentStep[ch];
      if (idx < 0 || this.songOff[ch] || !this.current[ch]) {
        for (const lane of lanes) if (lane.active) this.releasePatLane(lane);
        continue;
      }
      const p = idx + Math.min(1, this.chanElapsed[ch] / this.chanLen[ch]);
      for (const lane of lanes) {
        if (this.songLaneByKey.get(lane.key)?.active) { lane.active = false; continue; }
        const spec = lane.kind === 's' ? this.laneSpec(lane) : lane.spec;
        if (lane.kind === 's' && !spec) continue;
        const v = valueAt(lane.pos, lane.val, lane.pos.length, p, spec);
        if (v !== v) {
          if (lane.active) this.releasePatLane(lane);
          continue;
        }
        if (lane.active && v === lane.last && !(lane.kind === 's' && this.autoStale[lane.index])) continue;
        lane.active = true;
        lane.last = v;
        this.applyPatLane(lane, v);
      }
    }
  }

  /** A pattern lane sets its knob: a sound param over the base (the patch stays), else as the song's. */
  private applyPatLane(lane: Lane, v: number): void {
    if (lane.kind !== 's') { this.applyLane(lane, v); return; }
    const ch = lane.index;
    const inst = this.current[ch]!;
    this.applyParam(ch, inst, inst.params[lane.slot].id, this.withOffset(ch, lane.slot, v));
    this.lockApplied[ch * LOCK_SLOTS + lane.slot] = 1;
    for (const k of lane.links) {
      this.applyParam(ch, inst, inst.params[k].id, this.withOffset(ch, k, v));
      this.lockApplied[ch * LOCK_SLOTS + k] = 1;
    }
  }

  private releasePatLane(lane: Lane): void {
    if (lane.kind !== 's') { this.releaseLane(lane); return; }
    lane.active = false;
    lane.last = NaN;
    const ch = lane.index;
    const inst = this.current[ch];
    if (!inst || this.laneSpec(lane) === null) return;
    this.unlockSlot(ch, inst, lane.slot);
    for (const k of lane.links) this.unlockSlot(ch, inst, k);
  }

  private unlockSlot(ch: number, inst: Instrument, k: number): void {
    this.lockApplied[ch * LOCK_SLOTS + k] = 0;
    this.applyParam(ch, inst, inst.params[k].id, this.withOffset(ch, k, this.baseValue[ch * LOCK_SLOTS + k]));
  }

  /** Let go of the pattern lanes track ch is running. */
  private releasePatLanes(ch: number): void {
    const pat = this.lanePat[ch];
    if (pat < 0) return;
    for (const lane of this.patLanes[ch * NUM_PATTERNS + pat]) if (lane.active) this.releasePatLane(lane);
    this.lanePat[ch] = -1;
  }

  /** A sound parameter to the instrument; MID FREQ goes to the track's MID CUT. */
  private applyParam(ch: number, inst: Instrument, id: string, value: number): void {
    if (id === 'midfreq') this.cuts[ch].setFreq(value);
    else inst.setParam(id, value);
  }

  /** The hit tone glides (in octaves) towards the latest hit's cutoff. */
  private moveTone(ch: number, n: number): void {
    const to = this.toneTarget[ch];
    const k = 1 - Math.exp(-n / (TONE_SMOOTH * this.sampleRate));
    let fc = this.toneNow[ch] * Math.pow(to / this.toneNow[ch], k);
    if (Math.abs(fc - to) < to * 0.002) fc = to;
    this.toneNow[ch] = fc;
    this.toneL[ch].setup(fc, 0, this.sampleRate);
    this.toneR[ch].setup(fc, 0, this.sampleRate);
  }

  /** Tempo-synced onboard effects (PLUCK's delay) follow the tempo. */
  private instrumentTempo(): void {
    for (const set of this.instruments) for (const k in set) set[k].setTempo?.(this.bpm);
  }

  /** SIDECHAIN: a KICK hit ducks every track that listens (BASS DUCK) and pumps FX 2 (PUMP). */
  private kickHit(ch: number): void {
    if (this.kind[ch] !== 'kick') return;
    for (let c = 0; c < NUM_CHANNELS; c++) if (c !== ch) this.current[c]?.duck?.();
    for (const b of this.buses) b.kick();
  }

  loadProject(p: Project): void {
    this.autoBase.clear();
    this.bpm = p.bpm;
    this.instrumentTempo();
    this.buses.forEach((bus, k) => {
      bus.setTempo(p.bpm);
      for (const spec of BUS_PARAMS[k]) this.setBusParam(k, spec.id, p.buses[k]?.[spec.id] ?? spec.defaultValue);
      bus.settle();
    });
    this.setSong(p.song ?? { rows: [] });
    this.pendingMeter = -1;
    this.applyMeter(Math.max(0, Math.min(METERS.length - 1, Math.round(p.meter ?? 0))));
    for (const id in p.lfo) this.setLfo(id as LfoId, p.lfo[id as LfoId]);
    this.swing = (p.swing - 50) / 50;
    this.master.setImmediate(p.master);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const c = p.channels[ch];
      this.setInstrument(ch, c.instrument, c.instrument === 'none' ? {} : (c.sounds[c.instrument] ?? {}));
      this.pendingPattern[ch] = -1;
      this.activePattern[ch] = c.activePattern;
      for (let pat = 0; pat < NUM_PATTERNS; pat++) {
        this.pendingNotes[ch * NUM_PATTERNS + pat] = null;
        if (c.instrument !== 'none') this.storePatch(ch, pat, patchOf(c, pat).sound);
      }
      this.enterPattern(ch, c.activePattern, true);
      for (const id in c.liveOffset) this.setOffset(ch, id, c.liveOffset[id]);
      this.chord[ch] = c.chord;
      this.notes[ch] = c.notes ?? MAX_CHORD_NOTES;
      this.lfoOn[ch] = c.lfoOn ? 1 : 0;
      const arp = c.arp ?? defaultArp();
      this.setArp(ch, 'on', arp.on ? 1 : 0);
      this.setArp(ch, 'mode', arp.mode);
      this.setArp(ch, 'rate', arp.rate);
      this.setArp(ch, 'oct', arp.oct);
      this.setMix(ch, 'volume', c.volume);
      this.setMix(ch, 'mute', c.mute ? 1 : 0);
      this.setMix(ch, 'pan', c.pan);
      this.setMix(ch, 'dyn', c.dynamics ?? 100);
      this.setMix(ch, 'gate', c.gateLength ?? 1);
      this.setMix(ch, 'ring', c.ringLength ?? 1);
      this.setMix(ch, 'cut', c.midCut ?? 0);
      this.route[ch] = this.busIndex(c.fxSend);
      this.inDrumBus[ch] = c.fx1 ? 1 : 0;
      this.sendLevel[ch].setImmediate(c.sendLevel);
      this.autoBase.set(`m:${ch}:send`, c.sendLevel);
      // A loaded project starts at its values instead of gliding to them.
      this.volume[ch].setImmediate(c.volume);
      this.pan[ch].setImmediate(c.pan);
      this.cuts[ch].settle();
      for (let pat = 0; pat < NUM_PATTERNS; pat++) {
        this.patternLength[ch * NUM_PATTERNS + pat] = c.patterns[pat].length;
        this.patternRate[ch * NUM_PATTERNS + pat] = speedSteps(c.patterns[pat].speed);
        for (let i = 0; i < MAX_STEPS; i++) this.writeStep(ch, pat, i, c.patterns[pat].steps[i]);
        this.refreshOn(ch * NUM_PATTERNS + pat);
      }
    }
  }

  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    if (!playing) {
      this.releaseLanes();
      this.songOn = false;
      this.songRow = -1;
      this.songJumpTo = -1;
      this.songOff.fill(0);
    }
    this.globalStep = 0;
    this.countLeft = 0;
    if (this.pendingMeter >= 0) this.applyMeter(this.pendingMeter);
    this.barOrigin = 0;
    this.framesToStep = 0; // first step fires at the next sample
    this.lfoClock = 0; // LFOs restart with the song
    this.lfoTrig.fill(0);
    this.position.fill(0);
    this.currentStep.fill(-1);
    this.skipStep.fill(-1);
    this.rollLeft.fill(0);
    this.hitStep.fill(-1);
    this.runLeft.fill(0);
    this.subAt.fill(-1);
    this.subLeft.fill(0);
    this.loopStart.fill(1);
    this.offGrid.fill(0);
    this.chanCount.fill(-1);
    this.applyPendingNotes();
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      // A switch waiting for its bar line happens now, and every patch glide lands.
      if (this.pendingPattern[ch] >= 0) this.landPattern(ch);
      if (this.glidePattern[ch] >= 0) this.finishGlide(ch);
      if (!playing) {
        if (this.arpHeld[ch]) this.stopArp(ch);
        this.current[ch]?.noteOff(-1);
        this.clearHolds(ch);
        this.gateSteps[ch] = 0;
        this.gateAt[ch] = -1;
        this.recNote[ch] = -1;
        this.chordNote.fill(-1, ch * STEP_NOTES, (ch + 1) * STEP_NOTES);
        this.releasePatLanes(ch);
      }
    }
  }

  /**
   * PLAY from a bar: every track's step counters move on, silently, to where they would be
   * had everything played from the top until track ch reached step `from` of its pattern.
   * Notes that would have started before then do not sound.
   */
  private startAt(ch: number, from: number): void {
    if (!this.current[ch]) return;
    const pat = ch * NUM_PATTERNS + this.activePattern[ch];
    const len = this.patternLength[pat];
    const base = pat * MAX_STEPS;
    if (from >= len || this.nextOn(base, from, len) < 0) return;
    let g = 0;
    for (; g < 4 * MAX_STEPS; g++) {
      if (this.callsAt(ch, this.barPos(g)) && this.peekStep(ch) >= from) break;
      this.chaseMasterStep(g);
    }
    this.startClockAt(g);
  }

  /**
   * SONG from a bar inside a row: the row is entered and every track's counters move on,
   * silently, through its first `bar` bars (each row starts its patterns from the top).
   */
  private startSongAt(bar: number): void {
    this.enterRow(this.songRow);
    const steps = bar * this.barLen;
    for (let g = 0; g < steps; g++) this.chaseMasterStep(g);
    this.songBar = bar - 1; // the first bar line moves it on to `bar`
    this.startClockAt(steps);
  }

  /** startAt / startSongAt: one master step of every track, counters only. */
  private chaseMasterStep(g: number): void {
    const pos = this.barPos(g);
    for (let c = 0; c < NUM_CHANNELS; c++) {
      if (!this.current[c] || !this.callsAt(c, pos)) continue;
      const rate = this.patternRate[c * NUM_PATTERNS + this.activePattern[c]];
      this.chaseStep(c, g);
      if (rate < 1) this.chaseStep(c, g + 0.5);
      else if (rate > 1 && rate < 2) {
        this.chaseStep(c, g + 4 / 3);
        this.chaseStep(c, g + 8 / 3);
      }
    }
  }

  /** The master clock (and the LFO, phase-locked to it) starts at master step g. */
  private startClockAt(g: number): void {
    this.globalStep = g;
    this.lfoClock = g;
    this.lfoTrig.fill(g);
  }

  /** Whether track ch steps on master step `pos` of the bar (half time / triplets: not every one). */
  private callsAt(ch: number, pos: number): boolean {
    const rate = this.patternRate[ch * NUM_PATTERNS + this.activePattern[ch]];
    if (rate >= 2) return pos % 2 === 0;
    if (rate > 1) return pos % 4 === 0;
    return true;
  }

  /** The step track ch plays next (-1 = none plays). */
  private peekStep(ch: number): number {
    const pat = ch * NUM_PATTERNS + this.activePattern[ch];
    const len = this.patternLength[pat];
    const base = pat * MAX_STEPS;
    const idx = this.nextOn(base, this.position[ch] % len, len);
    return idx >= 0 ? idx : this.nextOn(base, 0, len);
  }

  /** startAt: one silent step of track ch (at master position `at`): stepChannel's counters only. */
  private chaseStep(ch: number, at: number): void {
    const pat = ch * NUM_PATTERNS + this.activePattern[ch];
    const len = this.patternLength[pat];
    const base = pat * MAX_STEPS;
    this.chanRate[ch] = this.patternRate[pat];
    this.chanAt[ch] = at;
    this.chanCount[ch]++;
    if (this.loopStart[ch]) this.offGrid[ch] = at === Math.floor(at) && this.barPos(at) === 0 ? 0 : 1;
    const idx = this.peekStep(ch);
    if (idx < 0) {
      this.position[ch] = 0;
      this.loopStart[ch] = 1;
      return;
    }
    const next = this.nextOn(base, idx + 1, len);
    this.loopStart[ch] = next < 0 ? 1 : 0;
    this.position[ch] = next < 0 ? 0 : next;
  }

  /** Overwrites outL/outR with `frames` samples. */
  process(outL: Float32Array, outR: Float32Array, frames: number): void {
    outL.fill(0, 0, frames);
    outR.fill(0, 0, frames);
    if (this.clickBuf.length < frames) this.clickBuf = new Float32Array(frames);
    if (this.clicked) this.clickBuf.fill(0, 0, frames);
    this.clicked = false;
    this.stepPatchGlides(frames);
    let pos = 0;
    while (pos < frames) {
      if (this.playing && this.framesToStep <= 0) {
        if (this.countLeft > 0) this.countStep();
        else this.fireStep();
        continue;
      }
      let n = frames - pos;
      if (n > CHUNK) n = CHUNK;
      // ARP notes land on their exact sample (also while stopped: live playing).
      for (let ch = 0; ch < NUM_CHANNELS; ch++) {
        if (!this.arpHeld[ch]) continue;
        if (this.arpAt[ch] <= 0) this.arpStep(ch);
        const a = Math.ceil(this.arpAt[ch]);
        if (a < n) n = a;
      }
      if (n < 1) n = 1;
      if (this.playing) {
        const until = Math.ceil(this.framesToStep);
        if (until < n) n = until;
        // GATE releases land on their exact sample.
        for (let ch = 0; ch < NUM_CHANNELS; ch++) {
          if (this.gateAt[ch] < 0) continue;
          if (this.gateAt[ch] <= 0) { this.releaseGate(ch); continue; }
          const g = Math.ceil(this.gateAt[ch]);
          if (g < n) n = g;
        }
        // ... and the PAD / PLUCK's held notes' releases.
        for (let k = 0; k < NUM_CHANNELS * HOLDS; k++) {
          if (this.holdAt[k] < 0) continue;
          if (this.holdAt[k] <= 0) { this.releaseHold(k); continue; }
          const g = Math.ceil(this.holdAt[k]);
          if (g < n) n = g;
        }
        // Steps between master steps (double time, triplets) land on their exact sample.
        for (let ch = 0; ch < NUM_CHANNELS; ch++) {
          if (this.subAt[ch] < 0) continue;
          if (this.subAt[ch] <= 0) {
            const at = this.subPos[ch];
            if (--this.subLeft[ch] > 0) {
              this.subAt[ch] = this.subLen[ch];
              this.subPos[ch] += this.subStep[ch];
            } else this.subAt[ch] = -1;
            this.stepChannel(ch, this.subLen[ch], at);
            if (this.subAt[ch] < 0) continue;
          }
          const d = Math.ceil(this.subAt[ch]);
          if (d < n) n = d;
        }
        // ROLL repeats also land on their exact sample.
        for (let ch = 0; ch < NUM_CHANNELS; ch++) {
          if (this.rollLeft[ch] === 0) continue;
          if (this.rollAt[ch] <= 0) {
            this.rollHit(ch);
            if (this.rollLeft[ch] === 0) continue;
          }
          const r = Math.ceil(this.rollAt[ch]);
          if (r < n) n = r;
        }
        if (n < 1) n = 1;
      }
      if (this.playing && this.globalStep > 0) {
        this.runPatAuto();
        if (this.songOn && this.lanes.length > 0) this.runAuto();
        else this.autoStale.fill(0);
      }
      this.renderChunk(outL, outR, pos, n);
      if (this.playing) for (let ch = 0; ch < NUM_CHANNELS; ch++) this.chanElapsed[ch] += n;
      if (this.click.render(this.clickBuf, pos, n)) this.clicked = true;
      pos += n;
      for (let ch = 0; ch < NUM_CHANNELS; ch++) if (this.arpHeld[ch]) this.arpAt[ch] -= n;
      if (this.playing) {
        this.framesToStep -= n;
        for (let ch = 0; ch < NUM_CHANNELS; ch++) if (this.rollLeft[ch] > 0) this.rollAt[ch] -= n;
        for (let ch = 0; ch < NUM_CHANNELS; ch++) if (this.subAt[ch] > 0) this.subAt[ch] = Math.max(0, this.subAt[ch] - n);
        for (let ch = 0; ch < NUM_CHANNELS; ch++) if (this.gateAt[ch] > 0) this.gateAt[ch] = Math.max(0, this.gateAt[ch] - n);
        for (let k = 0; k < NUM_CHANNELS * HOLDS; k++) if (this.holdAt[k] > 0) this.holdAt[k] = Math.max(0, this.holdAt[k] - n);
      }
    }
    this.finishBlock(outL, outR, frames);
  }

  /** Position in the current bar (of the time signature), 0..1; 0 when stopped. */
  get barPhase(): number {
    if (!this.playing || this.globalStep === 0) return 0;
    const inStep = Math.min(1, Math.max(0, (this.lastStepFrames - this.framesToStep) / this.lastStepFrames));
    const pos = (this.globalStep - 1 + inStep - this.barOrigin) / this.barLen;
    return pos - Math.floor(pos);
  }

  /** The bar's length in 16th steps (the time signature playing now). */
  get barSteps(): number {
    return this.barLen;
  }

  resetPeaks(): void {
    this.peakL = 0;
    this.peakR = 0;
  }

  /** Send number (FX 2 / FX 3) -> bus index; anything else = no send. */
  private busIndex(send: number): number {
    return send >= 2 && send <= NUM_SENDS ? send - 1 : -1;
  }

  /** Length in frames of the 16th step that starts at global step k (with swing, in pairs from the bar line). */
  stepFrames(k: number): number {
    const base = (60 / this.bpm / 4) * this.sampleRate;
    return this.barPos(k) % 2 === 0 ? base * (1 + this.swing) : base * (1 - this.swing);
  }

  /** Master step k's place in its bar (0 = a bar line). */
  private barPos(k: number): number {
    const p = (k - this.barOrigin) % this.barLen;
    return p < 0 ? p + this.barLen : p;
  }

  /** TIME SIG: stopped at once, playing at the next bar line. */
  private setMeter(value: number): void {
    const m = Math.max(0, Math.min(METERS.length - 1, Math.round(value)));
    if (this.playing) this.pendingMeter = m === this.meter ? -1 : m;
    else this.applyMeter(m);
  }

  /** A time signature takes over: bars count from here, every pattern's playing steps follow it. */
  private applyMeter(m: number): void {
    this.pendingMeter = -1;
    this.meter = m;
    this.barLen = meterLength(m);
    let k = 0;
    for (let cell = 0; cell < 16; cell++) if (meterPlays(m, cell)) this.cellOf[k++] = cell;
    // A beat starts each of the meter's (non-empty) groups.
    this.beatAt.fill(0);
    let at = 0;
    for (const g of METERS[m].groups) {
      if (g === 0) continue;
      this.beatAt[at] = 1;
      at += g;
    }
    this.barOrigin = this.globalStep;
    for (let k = 0; k < NUM_CHANNELS * NUM_PATTERNS; k++) this.refreshOn(k);
    this.lfoSteps = this.lfoRateSteps();
    this.lfoCycle.fill(-1);
  }

  /** Which steps of pattern slot k (ch * NUM_PATTERNS + pattern) play. */
  private refreshOn(k: number): void {
    const triplet = this.patternRate[k] > 1 && this.patternRate[k] < 2;
    const base = k * MAX_STEPS;
    for (let i = 0; i < MAX_STEPS; i++) {
      const on = meterPlays(this.meter, i) && !(triplet && i % 4 === 3) ? 1 : 0;
      this.stepOn[base + i] = on ^ this.stepFlip[base + i];
    }
  }

  /** The first playing step at or after `from` (below len) of the pattern at `base`; -1 = none. */
  private nextOn(base: number, from: number, len: number): number {
    for (let i = from; i < len; i++) if (this.stepOn[base + i]) return i;
    return -1;
  }

  /** Playing steps from `from` up to len. */
  private onCount(base: number, from: number, len: number): number {
    let n = 0;
    for (let i = from; i < len; i++) n += this.stepOn[base + i];
    return n;
  }

  /** The playing step k playing steps away from `from` (either way, round the loop). */
  private walkOn(base: number, from: number, k: number, len: number): number {
    const dir = k < 0 ? -1 : 1;
    let i = from;
    for (let n = Math.abs(k); n > 0; n--) {
      let j = i;
      for (let t = 0; t < len; t++) {
        j = (j + dir + len) % len;
        if (this.stepOn[base + j]) break;
      }
      i = j;
    }
    return i;
  }

  // ------------------------------------------------------------------ sequencing

  /** COUNT-IN: one straight step of clicks before the music (the sequencer waits). */
  private countStep(): void {
    const pos = (this.countTotal - this.countLeft) % this.barLen;
    if (this.beatAt[pos]) this.click.trigger(pos === 0);
    this.lastStepFrames = (60 / this.bpm / 4) * this.sampleRate;
    this.framesToStep += this.lastStepFrames;
    if (--this.countLeft === 0) this.lfoClock = this.lfoStartClock;
  }

  /** COUNT-IN: beats still to go (0 = none). */
  get countBeats(): number {
    let n = 0;
    for (let k = this.countTotal - this.countLeft; k < this.countTotal; k++) n += this.beatAt[k % this.barLen];
    return n;
  }

  private fireStep(): void {
    const g = this.globalStep;
    const atBar = this.barPos(g) === 0;
    if (atBar && this.pendingMeter >= 0) this.applyMeter(this.pendingMeter);
    const pos = this.barPos(g);
    const stepLen = this.stepFrames(g);
    if (this.clickOn && this.beatAt[pos]) this.click.trigger(pos === 0);
    if (atBar && this.notesPending) this.applyPendingNotes();
    if (this.songOn && atBar) this.songBarLine();
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      if (!this.current[ch]) continue;
      // Quantised pattern switch on a bar line: where the track starts its loop, or (its
      // last loop started off the bar: drifting) at the next one, from its first step.
      if (atBar && this.pendingPattern[ch] >= 0 && (this.loopStart[ch] || this.offGrid[ch])) {
        if (!this.loopStart[ch]) {
          this.position[ch] = 0;
          this.loopStart[ch] = 1;
          this.runLeft[ch] = 0;
          this.rollLeft[ch] = 0;
        }
        this.landPattern(ch);
      }
      const rate = this.patternRate[ch * NUM_PATTERNS + this.activePattern[ch]];
      if (rate < 1) {
        // Double time: a step now and one halfway through.
        this.stepChannel(ch, stepLen / 2, g);
        this.subLen[ch] = stepLen / 2;
        this.subAt[ch] = stepLen / 2;
        this.subLeft[ch] = 1;
        this.subPos[ch] = g + 0.5;
      } else if (rate >= 2) {
        // Half time: a step on every other master step (on the beat grid), two steps long.
        if (pos % 2 === 0) this.stepChannel(ch, stepLen + this.stepFrames(g + 1), g);
      } else if (rate > 1) {
        // Triplets: three steps in each beat (swing evens out over the beat).
        if (pos % 4 === 0) {
          const third = (stepLen + this.stepFrames(g + 1) + this.stepFrames(g + 2) + this.stepFrames(g + 3)) / 3;
          this.stepChannel(ch, third, g);
          this.subLen[ch] = third;
          this.subAt[ch] = third;
          this.subLeft[ch] = 2;
          this.subPos[ch] = g + 4 / 3;
          this.subStep[ch] = 4 / 3;
        }
      } else {
        this.stepChannel(ch, stepLen, g);
      }
      if (this.holdRoll[ch] && this.rollDiv[ch] > 0 && !this.songOff[ch]) this.heldRollStep(ch, g);
    }
    this.lastStepFrames = this.stepFrames(this.globalStep);
    this.framesToStep += this.lastStepFrames;
    this.globalStep++;
  }

  /**
   * One step of track ch (its own length stepLen frames; at master position `at`): gates,
   * locks and the step's note. At normal speed once per master step; double time twice;
   * half time every other.
   */
  private stepChannel(ch: number, stepLen: number, at: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    const pat = ch * NUM_PATTERNS + this.activePattern[ch];
    this.chanRate[ch] = this.patternRate[pat];
    this.chanAt[ch] = at;
    this.chanCount[ch]++;
    // Where this loop started: on a bar line, or off it (the track drifts).
    if (this.loopStart[ch]) this.offGrid[ch] = at === Math.floor(at) && this.barPos(at) === 0 ? 0 : 1;
    const len = this.patternLength[pat];
    const base = pat * MAX_STEPS;
    // The next step that plays (skipped ones take no time); none at all: the track rests.
    let idx = this.nextOn(base, this.position[ch] % len, len);
    if (idx < 0) idx = this.nextOn(base, 0, len);
    if (idx < 0) {
      if (this.gateSteps[ch] > 0) this.releaseGate(ch);
      this.releaseHolds(ch);
      this.rollLeft[ch] = 0;
      this.runLeft[ch] = 0;
      this.currentStep[ch] = -1;
      this.position[ch] = 0;
      this.loopStart[ch] = 1;
      return;
    }
    const s = base + idx;
    // MUTE stops new notes only: what is sounding plays out, and an unmuted track comes back
    // on its next note (a held RING / SLIDE note still ends at a muted note's step).
    const hit = this.stepActive[s] === 1 && this.skipStep[ch] !== idx && this.songOff[ch] === 0 && this.muted[ch] === 0;
    // SLIDE: the held note was marked to slide, so it glides into this one (no release).
    const slideFrom = hit && this.sliding[ch] && this.gateSteps[ch] > 0 ? this.gateGroup[ch] : -1;
    // Inside a roll run its hits are already scheduled; otherwise a roll ends here.
    const inRun = this.runLeft[ch] > 0;
    if (inRun) this.runLeft[ch]--;
    else if (!this.holdRoll[ch]) this.rollLeft[ch] = 0; // held ROLL keeps its own hits going
    // REST: everything sounding on the track stops (held, ringing, tied, releasing) over
    // CUT_FADE; a muted track's notes play out.
    const rest = this.stepRest[s] === 1 && this.skipStep[ch] !== idx && this.songOff[ch] === 0 && this.muted[ch] === 0;
    if (rest) {
      this.cutTrack(ch);
    } else if (slideFrom >= 0) {
      this.gateSteps[ch] = 0;
      this.ringing[ch] = 0;
      this.gateAt[ch] = -1;
    } else if (this.gateAt[ch] >= 0) {
      // A GATE release due by now (it always lands inside the step it was set in).
      this.releaseGate(ch);
    } else if (this.gateSteps[ch] > 0) {
      if (this.ringing[ch]) {
        // A RING note ends at the next hit on this track (or a REST, above).
        if (this.stepActive[s]) this.releaseGate(ch);
      } else if (--this.gateSteps[ch] === 0) {
        // A held note ends where its gate says: at the start of a later step, or (GATE
        // above 1) that far into it.
        if (this.gateLength[ch] > 1) {
          this.gateSteps[ch] = 1;
          this.gateAt[ch] = (this.gateLength[ch] - 1) * stepLen;
        } else this.releaseGate(ch);
      } else if (this.gateSteps[ch] === 1) this.gateEarly(ch, stepLen); // its last step
    }
    this.stepHolds(ch, stepLen);
    this.chanElapsed[ch] = 0;
    this.chanLen[ch] = stepLen;
    if (hit && !inRun) {
      const ring = this.stepRing[s] === 1 || this.forceRing[ch] === 1;
      const slideFlag = this.stepSlide[s] === 1 || this.forceSlide[ch] === 1;
      // On drum tracks the SLIDE flag is ROLL: the hit repeats at ROLL RATE.
      const drumRoll = this.rollDiv[ch] > 0 && slideFlag;
      // A SLIDE note is held (like RING) until the next note, which it glides into.
      const slide = this.rollDiv[ch] === 0 && slideFlag;
      const vel = this.forceVel[ch] > 0 ? this.forceVel[ch] : this.stepVel[s];
      // PAD / PLUCK chords: CHORD OFF plays every note of the step; a CHORD plays on the lowest.
      const extra = playsChords(this.kind[ch]) ? this.stepExtraN[s] : 0;
      const ex = s * (STEP_NOTES - 1);
      const all = extra > 0 && this.chord[ch] === 0 && this.arpMode[ch] === 0;
      let root = this.stepNote[s];
      if (extra > 0 && !all) for (let k = 0; k < extra; k++) root = Math.min(root, this.stepExtra[ex + k]);
      // PAD / PLUCK (no RING / SLIDE / ARP): every note held by its own length, under later ones.
      const poly = playsChords(this.kind[ch]) && !ring && !slide && slideFrom < 0 && this.arpMode[ch] === 0;
      if (poly) {
        this.holdStart(ch, root, this.stepGate[s], stepLen);
        this.noteOn(ch, root, vel);
        if (all) {
          const v = dynVelocity(vel, this.dynDepth[ch]);
          for (let k = 0; k < extra; k++) {
            const note = this.stepExtra[ex + k];
            this.holdStart(ch, note, this.stepExtraGate[ex + k], stepLen);
            inst.noteOn(note, v, note, false, -1, false);
          }
        }
        this.sliding[ch] = 0;
      } else {
        this.noteOn(ch, root, vel, ring, slideFrom, slide);
        if (all) {
          const v = dynVelocity(vel, this.dynDepth[ch]);
          for (let k = 0; k < extra; k++) inst.noteOn(this.stepExtra[ex + k], v, root, ring, -1, slide);
        }
        // A chord slid from: voices the slide did not carry over end now.
        if (slideFrom >= 0 && slideFrom !== root) inst.noteOff(slideFrom);
        this.gateGroup[ch] = root;
        this.gateSteps[ch] = ring || slide ? 1 : this.stepGate[s];
        this.ringing[ch] = ring || slide ? 1 : 0;
        this.gateAt[ch] = -1;
        if (!ring && !slide && this.gateSteps[ch] === 1) this.gateEarly(ch, stepLen);
        this.sliding[ch] = slide ? 1 : 0;
      }
      if (drumRoll && !this.holdRoll[ch]) this.startRollRun(ch, pat, idx, len, vel);
    }
    if (hit) {
      this.hitStep[ch] = at;
      this.hitNote[ch] = this.stepNote[s];
    }
    this.skipStep[ch] = -1;
    this.currentStep[ch] = idx;
    const next = this.nextOn(base, idx + 1, len);
    this.loopStart[ch] = next < 0 ? 1 : 0;
    this.position[ch] = next < 0 ? 0 : next;
  }

  /** GATE below 1: the note's last step (just started, stepLen long) is cut short. */
  private gateEarly(ch: number, stepLen: number): void {
    if (this.gateLength[ch] < 1) this.gateAt[ch] = this.gateLength[ch] * stepLen;
  }

  /** Song: a bar line. Move on to the next row (or a queued jump) when this row is done. */
  private songBarLine(): void {
    if (this.songBar < 0) {
      this.enterRow(this.songRow);
    } else {
      this.songBar++;
      if (this.songJumpTo >= 0) {
        this.enterRow(this.songJumpTo);
        this.songJumpTo = -1;
      } else if (this.songBar >= this.songBars[this.songRow]) {
        this.enterRow((this.songRow + 1) % this.songLength); // the end loops to the top
      }
    }
    // The row's last bar: each track's sound glides over it to the next row's patch.
    if (this.songBar === this.songBars[this.songRow] - 1 && this.songJumpTo < 0) {
      this.glideToRow((this.songRow + 1) % this.songLength, this.framesAhead(this.barLen));
    }
  }

  /**
   * Song: tracks whose pattern changes in `row` glide to its patch over `frames`; ones
   * already gliding elsewhere that keep their pattern glide back.
   */
  private glideToRow(row: number, frames: number): void {
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const p = this.songPatterns[row * NUM_CHANNELS + ch];
      if (p < 0) continue;
      if (p !== this.activePattern[ch]) {
        this.startGlide(ch, p, frames);
        this.glideWait[ch] = 1;
      } else if (this.glidePattern[ch] >= 0 && this.glidePattern[ch] !== p) {
        this.startGlide(ch, p, frames);
      }
    }
  }

  /** Song: start a row. Every track restarts its row pattern (or falls silent). */
  private enterRow(row: number): void {
    this.songRow = row;
    this.songBar = 0;
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const p = this.songPatterns[row * NUM_CHANNELS + ch];
      this.pendingPattern[ch] = -1;
      this.glideWait[ch] = 0;
      this.position[ch] = 0;
      this.loopStart[ch] = 1;
      this.runLeft[ch] = 0;
      this.rollLeft[ch] = 0;
      if (p < 0) {
        if (!this.songOff[ch] && this.gateSteps[ch] > 0) this.releaseGate(ch);
        if (!this.songOff[ch]) this.releaseHolds(ch);
        this.songOff[ch] = 1;
      } else {
        this.songOff[ch] = 0;
        if (p !== this.activePattern[ch]) this.enterPattern(ch, p, this.glidePattern[ch] !== p);
      }
    }
  }

  setSong(song: Song): void {
    const rows = song.rows.slice(0, SONG_MAX_ROWS);
    this.songLength = rows.length;
    rows.forEach((r, i) => {
      this.songBars[i] = Math.max(1, Math.min(255, Math.round(r.bars)));
      for (let ch = 0; ch < NUM_CHANNELS; ch++) {
        const p = r.patterns[ch];
        this.songPatterns[i * NUM_CHANNELS + ch] = typeof p === 'number' && p >= 0 && p < NUM_PATTERNS ? p : -1;
      }
    });
    if (this.songOn && this.songLength === 0) { this.songOn = false; this.songRow = -1; this.songOff.fill(0); }
    if (this.songRow >= this.songLength) this.songRow = this.songLength - 1;
    let bar = 0;
    for (let i = 0; i < this.songLength; i++) { this.rowStart[i] = bar; bar += this.songBars[i]; }
    this.rowStart[this.songLength] = bar;
    // The lanes, anew (any that were playing hand their knobs back first).
    this.releaseLanes();
    this.lanes = [];
    this.songLaneByKey = new Map();
    for (const key in song.auto ?? {}) {
      const points = song.auto![key];
      const lane = Array.isArray(points) ? this.makeLane(key, points) : null;
      if (!lane) continue;
      this.lanes.push(lane);
      this.songLaneByKey.set(key, lane);
    }
  }

  /** SONG automation for this chunk: where the song is now (in strip cells), each lane's value. */
  private runAuto(): void {
    const g = this.globalStep - 1;
    const step = Math.min(1, Math.max(0, 1 - this.framesToStep / this.lastStepFrames));
    const bar = this.rowStart[this.songRow] + Math.max(0, this.songBar);
    const p = bar * CELLS_PER_BAR + this.cellOf[this.barPos(g)] + step;
    for (const lane of this.lanes) {
      const spec = lane.kind === 's' ? this.laneSpec(lane) : lane.spec;
      if (lane.kind === 's' && !spec) continue;
      const v = valueAt(lane.pos, lane.val, lane.pos.length, p, spec);
      if (v !== v) { // NaN: before its first locked value
        if (lane.active) this.releaseLane(lane);
        continue;
      }
      if (lane.active && v === lane.last && !(lane.kind === 's' && this.autoStale[lane.index])) continue;
      lane.active = true;
      lane.last = v;
      this.applyLane(lane, v);
    }
    this.autoStale.fill(0);
    this.autoSnap = false;
  }

  /** A sound lane's parameter (slot) on the track's instrument now; null = it has none. */
  private laneSpec(lane: Lane): ParamSpec | null {
    const inst = this.current[lane.index];
    if (!inst) return null;
    if (lane.inst !== inst) {
      lane.inst = inst;
      lane.slot = this.slotOf(inst, lane.id);
      const kind = this.kind[lane.index];
      lane.links = kind === 'none' ? [] : linkedParams(kind, lane.id).map((id) => this.slotOf(inst, id)).filter((s) => s >= 0);
    }
    return lane.slot >= 0 ? inst.params[lane.slot] : null;
  }

  private applyLane(lane: Lane, v: number): void {
    this.autoApplying = true;
    const i = lane.index;
    switch (lane.kind) {
      case 's': {
        const inst = this.current[i]!;
        this.setSound(i, lane.id, v, lane.slot);
        for (const s of lane.links) this.setSound(i, inst.params[s].id, v, s);
        break;
      }
      case 'm':
        this.setMix(i, lane.id as MixParam, v);
        if (this.autoSnap) {
          if (lane.id === 'volume') this.volume[i].setImmediate(v);
          else if (lane.id === 'pan') this.pan[i].setImmediate(v);
          else if (lane.id === 'send') this.sendLevel[i].setImmediate(v);
        }
        break;
      case 'o': this.setOffset(i, lane.id, v); break;
      case 'b': this.setBusParam(i, lane.id, v); break;
      case 'l': this.setLfo(lane.id as LfoId, v); break;
      case 'a': this.setArp(i, lane.id as ArpId, v); break;
    }
    this.autoApplying = false;
  }

  /** A lane lets go: its knob back to the user's value (a sound: the playing pattern's). */
  private releaseLane(lane: Lane): void {
    lane.active = false;
    lane.last = NaN;
    if (lane.kind === 's') {
      const inst = this.current[lane.index];
      if (!inst || this.laneSpec(lane) === null) return;
      const at = (lane.index * NUM_PATTERNS + this.activePattern[lane.index]) * LOCK_SLOTS;
      this.autoApplying = true;
      this.setSound(lane.index, lane.id, this.patchValue[at + lane.slot], lane.slot);
      for (const s of lane.links) this.setSound(lane.index, inst.params[s].id, this.patchValue[at + s], s);
      this.autoApplying = false;
      return;
    }
    const base = this.autoBase.get(lane.key);
    this.applyLane(lane, base ?? (lane.kind === 'o' ? 0 : lane.spec?.defaultValue ?? 0));
  }

  private releaseLanes(): void {
    for (const lane of this.lanes) if (lane.active) this.releaseLane(lane);
  }

  /** An FX bus parameter (the user's value is kept for the automation to come back to). */
  private setBusParam(k: number, id: string, value: number): void {
    if (!this.autoApplying) this.autoBase.set(`b:${k}:${id}`, value);
    this.buses[k]?.setParam(id, value);
  }

  /**
   * Play a note (as a chord when chord mode is on); voices are grouped by the root note.
   * slideFrom >= 0: legato from that still-sounding root (no release, no new attack).
   */
  private noteOn(ch: number, note: number, velocity: number, ring = false, slideFrom = -1, slide = false): void {
    const inst = this.current[ch];
    if (!inst) return;
    velocity = dynVelocity(velocity, this.dynDepth[ch]);
    if (this.gateSteps[ch] > 0 && slideFrom < 0) this.releaseGate(ch);
    this.toneTarget[ch] = hitToneCutoff(velocity);
    if (this.arpMode[ch] > 0) {
      // ARP: start stepping through the chord from its first note.
      this.stopArp(ch);
      this.arpHeld[ch] = 1;
      this.arpRoot[ch] = note;
      this.arpVel[ch] = velocity;
      this.arpIndex[ch] = 0;
      this.arpStep(ch);
    } else {
      const intervals = chordVoicing(this.chord[ch], this.notes[ch]);
      for (let i = 0; i < intervals.length; i++) inst.noteOn(note + intervals[i], velocity, note, ring, slideFrom, slide);
    }
    // RETRIG NOTE: the LFO restarts with each new note (not on slides).
    if (slideFrom < 0) this.lfoTrig[ch] = this.lfoClock;
    this.kickHit(ch);
  }

  /**
   * A ROLL run: the consecutive ROLL steps from here (to the pattern's end) roll as one, at
   * ROLL RATE hits per step from the start of the first step to the end of the last, evenly
   * (straight through swing). Velocity ramps hit by hit from the first step's to the last's.
   * Forced ROLL (PLAY) rolls through runs of consecutive hits instead: from the first hit up
   * to the last one, which plays plainly as the roll's end (the ramp leads into it); a hit
   * with no hit right after it does not roll.
   */
  private startRollRun(ch: number, pat: number, idx: number, len: number, vel: number): void {
    const forced = this.forceSlide[ch] === 1;
    let steps = 1;
    let last = vel;
    const base = pat * MAX_STEPS;
    for (let i = this.nextOn(base, idx + 1, len); i >= 0; i = this.nextOn(base, i + 1, len)) {
      const s = base + i;
      if (this.stepActive[s] !== 1 || (!forced && this.stepSlide[s] !== 1)) break;
      steps++;
      last = this.forceVel[ch] > 0 ? this.forceVel[ch] : this.stepVel[s];
    }
    if (forced) {
      // The last consecutive hit ends the roll: it fires on its own step.
      if (steps === 1) return;
      steps--;
    }
    // Below a hit a step, the hits that start inside the run (a run of 3 at 2:1: 2).
    // The hits that start inside the run, at the tempo's note value (a run of 3 at 1/8: 2).
    const hits = Math.ceil(steps * this.chanRate[ch] * this.rollDiv[ch] - 1e-9);
    // Stored runs end on their last hit; a forced roll ramps on into the hit that ends it.
    this.rollRamp[ch] = forced ? hits : hits - 1;
    this.runLeft[ch] = steps - 1;
    this.rollLeft[ch] = hits - 1;
    this.rollIndex[ch] = 0;
    // Straight (through swing), at the tempo whatever the pattern's speed.
    this.rollEvery[ch] = this.rollSpacing() / this.rollDiv[ch];
    this.rollAt[ch] = this.rollEvery[ch];
    this.rollNote[ch] = this.stepNote[pat * MAX_STEPS + idx];
    this.rollVel[ch] = vel;
    this.rollVelEnd[ch] = last;
  }

  /** ROLL held: on (note: what it strikes) or off; the repeats start at the next ROLL RATE hit. */
  private setHoldRoll(ch: number, on: boolean, note: number): void {
    this.holdRoll[ch] = on ? 1 : 0;
    this.holdRollNote[ch] = note;
    this.holdRollCount[ch] = 0;
    if (!on) {
      this.rollLeft[ch] = 0;
      return;
    }
    if (!this.playing || this.globalStep === 0 || this.rollDiv[ch] < 1) return; // the next 16th starts it
    const every = this.rollSpacing() / this.rollDiv[ch];
    const elapsed = this.lastStepFrames - this.framesToStep;
    const k = Math.floor(elapsed / every) + 1;
    if (k >= this.rollDiv[ch]) return;
    this.holdRollFrom(ch, note, k);
    this.rollAt[ch] = k * every - elapsed;
  }

  /**
   * ROLL held, at master step g (the 16th grid, straight): a hit at normal velocity unless the
   * track's own hit starts here (it plays as set), then the rest of ROLL RATE's hits in this
   * 16th; below a hit a 16th, every 1 / rate-th 16th from the press.
   */
  private heldRollStep(ch: number, g: number): void {
    const rate = this.rollDiv[ch];
    const own = this.hitStep[ch] === g;
    if (rate < 1 && this.holdRollCount[ch]++ % Math.round(1 / rate) !== 0) return;
    if (!own) this.noteOn(ch, this.holdRollNote[ch], DYNAMIC_VELOCITY.normal);
    if (rate > 1) this.holdRollFrom(ch, own ? this.hitNote[ch] : this.holdRollNote[ch], 1);
  }

  /** Held ROLL: the hits from the k-th of this step to its end, at normal velocity. */
  private holdRollFrom(ch: number, note: number, k: number): void {
    this.runLeft[ch] = 0;
    this.rollLeft[ch] = this.rollDiv[ch] - k;
    this.rollEvery[ch] = this.rollSpacing() / this.rollDiv[ch];
    this.rollAt[ch] = this.rollEvery[ch];
    this.rollNote[ch] = note;
    this.rollVel[ch] = DYNAMIC_VELOCITY.normal;
    this.rollVelEnd[ch] = DYNAMIC_VELOCITY.normal;
    this.rollRamp[ch] = 0;
    this.rollIndex[ch] = 0;
  }

  /** A straight 16th at the tempo, in frames (ROLL hits are this / ROLL RATE apart). */
  private rollSpacing(): number {
    return (60 / this.bpm / 4) * this.sampleRate;
  }

  /** One ROLL repeat: re-strike the run's note (on its velocity ramp), then schedule the next. */
  private rollHit(ch: number): void {
    const inst = this.current[ch];
    this.rollLeft[ch]--;
    this.rollAt[ch] += this.rollEvery[ch];
    const k = ++this.rollIndex[ch];
    if (!inst) return;
    const note = this.rollNote[ch];
    const intervals = chordVoicing(this.chord[ch], this.notes[ch]);
    const v0 = this.rollVel[ch];
    const ramp = this.rollRamp[ch] > 0 ? Math.min(1, k / this.rollRamp[ch]) : 0;
    const vel = dynVelocity(v0 + (this.rollVelEnd[ch] - v0) * ramp, this.dynDepth[ch]);
    for (let i = 0; i < intervals.length; i++) inst.noteOn(note + intervals[i], vel, note, this.ringing[ch] === 1);
    this.kickHit(ch);
  }

  /** ARP: play the next note of the held chord (and schedule the one after). */
  private arpStep(ch: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    if (this.arpNote[ch] >= 0) inst.noteOff(this.arpNote[ch]);
    const intervals = chordVoicing(this.chord[ch], this.notes[ch]);
    const mode = this.arpMode[ch];
    const count = intervals.length * this.arpOct[ch]; // chord tones over ARP OCT octaves
    const i = this.arpIndex[ch]++;
    let k: number;
    if (mode === 2) k = count - 1 - (i % count); // DOWN
    else if (mode === 3) { // UP/DN
      const period = Math.max(1, 2 * count - 2);
      const t = i % period;
      k = t < count ? t : period - t;
    } else if ((mode === 4 || mode === 5) && count >= 3) {
      // CASCADE: overlapping skips, pairs (k, k + 2): 1 5 3 7 5 9 ... / from the top down.
      const j = i % (2 * (count - 2));
      const pair = j >> 1;
      const skip = (j & 1) * 2;
      k = mode === 4 ? pair + skip : count - 1 - pair - skip;
    } else if (mode === 6) k = Math.min(count - 1, Math.floor((this.arpNoise.next() * 0.5 + 0.5) * count)); // RANDOM
    else k = mode === 5 ? count - 1 - (i % count) : i % count; // UP (short chords cascade as UP / DOWN)
    const n = this.arpRoot[ch] + intervals[k % intervals.length] + 12 * Math.floor(k / intervals.length);
    inst.noteOn(n, this.arpVel[ch], n, false);
    this.arpNote[ch] = n;
    this.arpAt[ch] += this.arpSteps[ch] * (60 / this.bpm / 4) * this.sampleRate;
  }

  private stopArp(ch: number): void {
    if (this.arpNote[ch] >= 0) this.current[ch]?.noteOff(this.arpNote[ch]);
    this.arpNote[ch] = -1;
    this.arpHeld[ch] = 0;
    this.arpAt[ch] = 0;
  }

  /** PAD / PLUCK: hold `note` for `steps` steps from now (a held one of the same pitch ends first). */
  private holdStart(ch: number, note: number, steps: number, stepLen: number): void {
    const base = ch * HOLDS;
    let free = -1;
    for (let k = base; k < base + HOLDS; k++) {
      if (this.holdNote[k] === note) this.releaseHold(k);
      if (free < 0 && this.holdNote[k] < 0) free = k;
    }
    if (free < 0) { free = base; this.releaseHold(free); }
    this.holdNote[free] = note;
    this.holdSteps[free] = Math.max(1, steps);
    // One step long: TRIM below 1 ends it early, as for any note's last step.
    this.holdAt[free] = steps <= 1 && this.gateLength[ch] < 1 ? this.gateLength[ch] * stepLen : -1;
  }

  /** PAD / PLUCK: a step went by; held notes count down and end where their length (and TRIM) says. */
  private stepHolds(ch: number, stepLen: number): void {
    const gl = this.gateLength[ch];
    for (let k = ch * HOLDS; k < (ch + 1) * HOLDS; k++) {
      if (this.holdNote[k] < 0) continue;
      if (this.holdAt[k] >= 0) { this.releaseHold(k); continue; } // due by now
      if (--this.holdSteps[k] === 0) {
        if (gl > 1) { this.holdSteps[k] = 1; this.holdAt[k] = (gl - 1) * stepLen; }
        else this.releaseHold(k);
      } else if (this.holdSteps[k] === 1 && gl < 1) this.holdAt[k] = gl * stepLen;
    }
  }

  private releaseHold(k: number): void {
    const note = this.holdNote[k];
    this.holdNote[k] = -1;
    this.holdAt[k] = -1;
    if (note >= 0) this.current[Math.floor(k / HOLDS)]?.noteOff(note);
  }

  private releaseHolds(ch: number): void {
    for (let k = ch * HOLDS; k < (ch + 1) * HOLDS; k++) if (this.holdNote[k] >= 0) this.releaseHold(k);
  }

  /** Forget the held notes without releasing them (their voices were already silenced). */
  private clearHolds(ch: number): void {
    this.holdNote.fill(-1, ch * HOLDS, (ch + 1) * HOLDS);
    this.holdAt.fill(-1, ch * HOLDS, (ch + 1) * HOLDS);
  }

  private releaseGate(ch: number): void {
    this.sliding[ch] = 0;
    this.gateAt[ch] = -1;
    if (this.arpHeld[ch]) this.stopArp(ch);
    this.current[ch]?.noteOff(this.gateGroup[ch]);
    this.gateSteps[ch] = 0;
    this.ringing[ch] = 0;
  }

  /** REST: the track's sequenced notes forgotten and every voice cut (Instrument.cut). */
  private cutTrack(ch: number): void {
    this.sliding[ch] = 0;
    this.gateAt[ch] = -1;
    this.gateSteps[ch] = 0;
    this.ringing[ch] = 0;
    if (this.arpHeld[ch]) this.stopArp(ch);
    this.clearHolds(ch);
    this.current[ch]?.cut();
  }

  /** Live note released. If it was being recorded, its length becomes the step's gate. */
  private release(ch: number, note: number): void {
    if (this.arpHeld[ch] && this.arpRoot[ch] === note) this.stopArp(ch);
    this.current[ch]?.noteOff(note);
    if (this.releaseChordNote(ch, note)) return;
    if (this.recNote[ch] !== note) return;
    this.recNote[ch] = -1;
    if (!this.playing) return;
    const pattern = this.recPattern[ch];
    const gate = this.heldLength(ch, pattern, this.recStart[ch]);
    const index = this.recIndex[ch];
    this.stepGate[(ch * NUM_PATTERNS + pattern) * MAX_STEPS + index] = gate;
    this.onRecorded?.({
      type: 'recordedNote', channel: ch, pattern, index, note,
      velocity: this.recVel[ch], accent: this.recAccent[ch] === 1, gate, slide: this.recSlide[ch] === 1,
    });
  }

  /** Steps from `start` (global) to the step heard now: a released note's length, up to the whole loop. */
  private heldLength(ch: number, pattern: number, start: number): number {
    const endStep = this.chanCount[ch] + Math.round(this.heardStep(ch));
    // Up to the whole loop (a note may be held past the end and on from the start).
    return Math.max(1, Math.min(this.patternLength[ch * NUM_PATTERNS + pattern], endStep - start));
  }

  /** PAD / PLUCK: a chord note recorded onto a step was released: its own length. False if it was none. */
  private releaseChordNote(ch: number, note: number): boolean {
    for (let k = ch * STEP_NOTES; k < (ch + 1) * STEP_NOTES; k++) {
      if (this.chordNote[k] !== note) continue;
      this.chordNote[k] = -1;
      if (!this.playing) return true;
      const slot = this.chordSlot[k];
      const pattern = (slot / MAX_STEPS | 0) % NUM_PATTERNS;
      const index = slot % MAX_STEPS;
      const gate = this.heldLength(ch, pattern, this.chordStart[k]);
      const ex = slot * (STEP_NOTES - 1);
      for (let j = 0; j < this.stepExtraN[slot]; j++) {
        if (this.stepExtra[ex + j] !== note) continue;
        this.stepExtraGate[ex + j] = gate;
        this.onRecorded?.({ type: 'recordedChord', channel: ch, pattern, index, note, gate });
      }
      return true;
    }
    return false;
  }

  /** A slot's value with the relative LIVE knobs' push added (clamped to its range). */
  private withOffset(ch: number, slot: number, value: number): number {
    const off = this.offsetNorm[ch * LOCK_SLOTS + slot];
    if (off === 0) return value;
    const spec = this.current[ch]!.params[slot];
    const n = toNorm(spec, value) + off;
    return toValue(spec, n < 0 ? 0 : n > 1 ? 1 : n);
  }

  /**
   * A relative LIVE knob moved (value -1..1, 0 = centred). Re-sums the channel's push per
   * slot and re-applies the slots whose push changed (UI rate, not per block).
   */
  private setOffset(ch: number, id: string, value: number): void {
    if (!this.autoApplying) this.autoBase.set(`o:${ch}:${id}`, value);
    const inst = this.current[ch];
    const offsets = this.liveOffsets[ch];
    if (value === 0) offsets.delete(id);
    else offsets.set(id, Math.max(-1, Math.min(1, value)));
    if (!inst) return;
    const kind = this.kind[ch];
    const base = ch * LOCK_SLOTS;
    const n = Math.min(inst.params.length, LOCK_SLOTS);
    for (let k = 0; k < n; k++) this.prevOffset[k] = this.offsetNorm[base + k];
    this.offsetNorm.fill(0, base, base + LOCK_SLOTS);
    for (const [key, v] of offsets) {
      for (const t of liveTargets(kind, key)) {
        const slot = this.slotOf(inst, t.id);
        if (slot >= 0) this.offsetNorm[base + slot] += liveContribution(t, v);
      }
    }
    for (let k = 0; k < n; k++) {
      if (this.offsetNorm[base + k] === this.prevOffset[k] || this.lockApplied[base + k]) continue;
      this.applyParam(ch, inst, inst.params[k].id, this.withOffset(ch, k, this.baseValue[base + k]));
    }
  }

  private setInstrument(ch: number, kind: InstrumentKind, sound: Record<string, number>): void {
    this.releasePatLanes(ch);
    if (this.arpHeld[ch]) this.stopArp(ch);
    this.rollDiv[ch] = 0;
    this.current[ch]?.noteOff(-1);
    this.clearHolds(ch);
    this.gateSteps[ch] = 0;
    this.gateAt[ch] = -1;
    this.current[ch] = kind === 'none' ? null : this.instruments[ch][kind];
    this.kind[ch] = kind;
    this.typeGain[ch] = kind === 'none' ? 1 : INSTRUMENTS[kind].gain ?? 1;
    // Live offsets belong to the old type's knobs.
    this.liveOffsets[ch].clear();
    this.offsetNorm.fill(0, ch * LOCK_SLOTS, (ch + 1) * LOCK_SLOTS);
    this.lockApplied.fill(0, ch * LOCK_SLOTS, (ch + 1) * LOCK_SLOTS);
    this.glidePattern[ch] = -1;
    const inst = this.current[ch];
    if (inst) {
      inst.params.forEach((spec, slot) => this.setSound(ch, spec.id, sound[spec.id] ?? spec.defaultValue, slot));
      for (let pat = 0; pat < NUM_PATTERNS; pat++) this.storePatch(ch, pat, sound);
    }
  }

  /**
   * Where the player is (global steps, fractional): what they hear now, which is the engine's
   * position less the output latency (limiter look-ahead + the reported listen latency).
   */
  private heardPosition(): number {
    const elapsed = this.lastStepFrames - this.framesToStep;
    return this.globalStep - 1 + (elapsed - this.latency - this.listenFrames) / this.lastStepFrames;
  }

  /**
   * The step a live note belongs to: the one nearest to where it was heard (global step
   * `global`; `isNext` = the step about to fire, which must then skip it).
   */
  private nearestStep(ch: number, round = true): { index: number; isNext: boolean; global: number } {
    const cur = this.currentStep[ch];
    if (cur < 0) return { index: 0, isNext: true, global: 0 };
    const heard = this.heardStep(ch);
    const k = round ? Math.round(heard) : Math.floor(heard);
    const pat = ch * NUM_PATTERNS + this.activePattern[ch];
    const index = this.walkOn(pat * MAX_STEPS, cur, k, this.patternLength[pat]);
    return { index, isNext: k >= 1, global: this.chanCount[ch] + k };
  }

  /**
   * Where the player is in track ch's own steps, from its current step (fractional; 0 = its
   * start): half / double time count the track's steps, not the master's.
   */
  private heardStep(ch: number): number {
    return (this.heardPosition() - this.chanAt[ch]) / this.chanRate[ch];
  }

  private recordNote(ch: number, note: number, velocity: number, accent: boolean, slide = false): void {
    // Legato over a note still being recorded: glide from it, and it now lasts until here.
    const prev = slide && this.recNote[ch] >= 0 ? this.recNote[ch] : -1;
    this.noteOn(ch, note, velocity, false, slide ? prev : -1);
    if (!this.playing || !this.current[ch] || this.countLeft > 0) return;
    const { index, isNext, global } = this.nearestStep(ch);
    const pattern = this.activePattern[ch];
    if (prev >= 0) {
      const start = global;
      const gate = Math.max(1, Math.min(MAX_STEPS, start - this.recStart[ch]));
      const p = this.recPattern[ch];
      const i = this.recIndex[ch];
      // The held note slides into this one: the SLIDE flag goes on it.
      this.stepGate[(ch * NUM_PATTERNS + p) * MAX_STEPS + i] = gate;
      this.stepSlide[(ch * NUM_PATTERNS + p) * MAX_STEPS + i] = 1;
      this.onRecorded?.({
        type: 'recordedNote', channel: ch, pattern: p, index: i, note: prev,
        velocity: this.recVel[ch], accent: this.recAccent[ch] === 1, gate, slide: true,
      });
    }
    const s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
    this.stepActive[s] = 1;
    this.stepNote[s] = note;
    this.stepVel[s] = velocity;
    this.stepAccent[s] = accent ? 1 : 0;
    this.stepRing[s] = 0;
    this.stepRest[s] = 0;
    this.stepSlide[s] = 0;
    this.stepGate[s] = 1;
    this.stepExtraN[s] = 0;
    // Chord notes still held from this step's old notes are gone with them.
    for (let k = ch * STEP_NOTES; k < (ch + 1) * STEP_NOTES; k++) if (this.chordSlot[k] === s) this.chordNote[k] = -1;
    // The note already sounded now; don't play it again when that step comes round.
    if (isNext) this.skipStep[ch] = index;
    // Remember it so the release sets its length.
    this.recNote[ch] = note;
    this.recFrame[ch] = this.frame;
    this.recStart[ch] = global;
    this.recIndex[ch] = index;
    this.recPattern[ch] = pattern;
    this.recVel[ch] = velocity;
    this.recAccent[ch] = accent ? 1 : 0;
    this.recSlide[ch] = 0;
    this.onRecorded?.({ type: 'recordedNote', channel: ch, pattern, index, note, velocity, accent, gate: 1, slide: false, start: true });
  }

  /**
   * PAD / PLUCK: a key played while the note being recorded is held joins its step (Step.extra, up
   * to STEP_NOTES) when it lands on the same step, or comes within CHORD_WINDOW of it (the
   * keys of one chord, pressed a little apart, even across the middle of a step). False when
   * it belongs on another step (then it is recorded as a note of its own).
   */
  private recordChordNote(ch: number, note: number, velocity: number): boolean {
    if (!this.playing || this.countLeft > 0 || this.recNote[ch] < 0 || !playsChords(this.kind[ch])) return false;
    const nearest = this.nearestStep(ch);
    const together = this.frame - this.recFrame[ch] < CHORD_WINDOW * this.sampleRate;
    if (!together && (nearest.index !== this.recIndex[ch] || this.activePattern[ch] !== this.recPattern[ch])) return false;
    const index = this.recIndex[ch];
    const pattern = this.recPattern[ch];
    const s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
    const n = this.stepExtraN[s];
    const ex = s * (STEP_NOTES - 1);
    let present = this.stepNote[s] === note;
    for (let k = 0; k < n; k++) if (this.stepExtra[ex + k] === note) present = true;
    this.noteOn(ch, note, velocity);
    if (present || n >= STEP_NOTES - 1) return true;
    this.stepExtra[ex + n] = note;
    // One step long until its own release sets its length.
    this.stepExtraGate[ex + n] = 1;
    this.stepExtraN[s] = n + 1;
    this.onRecorded?.({ type: 'recordedChord', channel: ch, pattern, index, note, gate: 1 });
    for (let k = ch * STEP_NOTES; k < (ch + 1) * STEP_NOTES; k++) {
      if (this.chordNote[k] >= 0) continue;
      this.chordNote[k] = note;
      this.chordSlot[k] = s;
      this.chordStart[k] = this.recStart[ch];
      break;
    }
    return true;
  }

  private recordLock(ch: number, id: string, value: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    const slot = this.slotOf(inst, id);
    if (slot < 0) return;
    this.applyParam(ch, inst, id, this.withOffset(ch, slot, value)); // hear it now
    if (!this.playing || this.currentStep[ch] < 0) return;
    const pattern = this.activePattern[ch];
    // The step being heard when the knob moved.
    const { index } = this.nearestStep(ch, false);
    const s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
    this.stepLockSrc[s] = { ...this.stepLockSrc[s], [id]: value };
    this.lockChanged(ch, pattern);
    this.onRecorded?.({ type: 'recordedLock', channel: ch, pattern, index, id, value });
  }

  // ------------------------------------------------------------------ audio

  private renderChunk(outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    const sl = this.scratchL;
    const sr = this.scratchR;
    // Bus 0 collects the drum bus input; buses 1-2 the sends.
    for (let k = 0; k < NUM_SENDS; k++) {
      this.busL[k].fill(0, 0, n);
      this.busR[k].fill(0, 0, n);
    }
    const lfoActive = this.lfoVol > 0 || this.lfoPitch > 0 || this.lfoFilter > 0 || this.lfoPan > 0 || this.lfoSend > 0 || this.lfoFm > 0;
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const inst = this.current[ch];
      if (!inst) continue;
      if (this.toneNow[ch] !== this.toneTarget[ch]) this.moveTone(ch, n);
      sl.fill(0, 0, n);
      sr.fill(0, 0, n);
      const lfo = lfoActive && this.lfoOn[ch] === 1;
      const lb = ch * CHUNK;
      if (lfo) this.fillLfo(ch, n);
      // Pitch and filter: one value per chunk; volume, pan and send: per sample below.
      if (lfo && this.lfoPitch > 0) {
        inst.setPitchMod(this.lfoPitch * this.lfoBuf[lb]);
        this.pitchModOn[ch] = 1;
      } else if (this.pitchModOn[ch]) {
        inst.setPitchMod(0);
        this.pitchModOn[ch] = 0;
      }
      if (lfo && this.lfoFilter > 0) {
        inst.setFilterMod(this.lfoFilter * this.lfoBuf[lb]);
        this.filterModOn[ch] = 1;
      } else if (this.filterModOn[ch]) {
        inst.setFilterMod(0);
        this.filterModOn[ch] = 0;
      }
      // FM MOD: the synths' modulation level swings by up to ±depth (one value per chunk).
      if (lfo && this.lfoFm > 0) {
        inst.setFmMod(this.lfoFm * this.lfoBuf[lb]);
        this.fmModOn[ch] = 1;
      } else if (this.fmModOn[ch]) {
        inst.setFmMod(0);
        this.fmModOn[ch] = 0;
      }
      inst.render(sl, sr, 0, n);
      const tl = this.toneL[ch];
      const tr = this.toneR[ch];
      // The hit tone (velocity colour; skipped while nothing comes in and it has died away),
      // then the track's onboard effects.
      if (!(tl.quiet && tr.quiet && silent(sl, sr, n))) {
        for (let i = 0; i < n; i++) {
          tl.process(sl[i]);
          tr.process(sr[i]);
          sl[i] = tl.low;
          sr[i] = tr.low;
        }
      }
      inst.post?.(sl, sr, n);
      this.cuts[ch].process(sl, sr, n);
      const volDepth = lfo ? this.lfoVol : 0;
      const panDepth = lfo ? this.lfoPan : 0;
      const sendDepth = lfo ? this.lfoSend : 0;
      const vol = this.volume[ch];
      const tg = this.typeGain[ch];
      const pan = this.pan[ch];
      const level = this.sendLevel[ch];
      const bus = this.route[ch];
      const bL = bus >= 0 ? this.busL[bus] : null;
      const bR = bus >= 0 ? this.busR[bus] : null;
      // Drum bus members go through FX 1 instead of straight to the mix.
      const dL = this.inDrumBus[ch] ? this.busL[0] : outL;
      const dR = this.inDrumBus[ch] ? this.busR[0] : outR;
      const dOff = this.inDrumBus[ch] ? 0 : off;
      if (silent(sl, sr, n)) {
        // Nothing to mix: the levels move on as if it had been.
        vol.advance(n);
        pan.advance(n);
        level.advance(n);
        continue;
      }
      if (volDepth === 0 && panDepth === 0 && sendDepth === 0 && vol.settled && pan.settled && level.settled) {
        // Levels at rest: the gains once for the block (the same as the per-sample path below).
        const v = vol.value * tg;
        const a = (pan.value + 1) * 0.25 * Math.PI;
        const cl = Math.cos(a);
        const cr = Math.sin(a);
        const g = level.value;
        for (let i = 0; i < n; i++) {
          const l = sl[i] * v * cl;
          const r = sr[i] * v * cr;
          dL[dOff + i] += l;
          dR[dOff + i] += r;
          if (bL && bR) {
            bL[i] += l * g;
            bR[i] += r * g;
          }
        }
        continue;
      }
      for (let i = 0; i < n; i++) {
        let v = vol.next() * tg;
        if (volDepth > 0) {
          // Tremolo: the LFO dips the level by up to VOL MOD (full depth = silent at the bottom).
          v *= 1 - volDepth * (0.5 - 0.5 * this.lfoBuf[lb + i]);
        }
        // Equal-power pan, -1..1 -> 0..pi/2 (PAN MOD swings it with the LFO).
        let pp = pan.next();
        if (panDepth > 0) {
          pp += panDepth * this.lfoBuf[lb + i];
          pp = pp > 1 ? 1 : pp < -1 ? -1 : pp;
        }
        const a = (pp + 1) * 0.25 * Math.PI;
        const l = sl[i] * v * Math.cos(a);
        const r = sr[i] * v * Math.sin(a);
        dL[dOff + i] += l;
        dR[dOff + i] += r;
        // Post-fader send, taken before the drum bus.
        let g = level.next();
        if (sendDepth > 0) {
          // SEND MOD: the LFO pushes the send level up and down (dub throws).
          g += sendDepth * this.lfoBuf[lb + i];
          g = g > 1 ? 1 : g < 0 ? 0 : g;
        }
        if (bL && bR) {
          bL[i] += l * g;
          bR[i] += r * g;
        }
      }
    }
    // FX 1 (the drums through it, plus its returns), then the sends' returns, into the mix.
    for (let k = 0; k < NUM_BUSES; k++) this.buses[k].process(this.busL[k], this.busR[k], outL, outR, off, n);
    this.lfoClock += n * this.lfoStepInc();
  }

  /** LFO clock advance per sample, in 16th steps (straight, ignoring swing). */
  private lfoStepInc(): number {
    return (this.bpm * 4) / (60 * this.sampleRate);
  }

  /**
   * One track's LFO for the next n samples into lfoBuf: song-locked (FREE) or from its
   * last note (RETRIG NOTE), shifted by PHASE and SPREAD, slewed by SMOOTH, faded in by FADE.
   */
  private fillLfo(ch: number, n: number): void {
    const inc = this.lfoStepInc();
    const steps = this.lfoSteps;
    const t0 = this.lfoRetrig ? this.lfoClock - this.lfoTrig[ch] : this.lfoClock;
    const offset = this.lfoPhase + (this.lfoSpread * ch) / NUM_CHANNELS;
    // SMOOTH: a one-pole slew of up to a quarter cycle.
    const k = this.lfoSmooth > 0 ? 1 - Math.exp(-inc / (this.lfoSmooth * steps * 0.25)) : 1;
    const buf = this.lfoBuf;
    const base = ch * CHUNK;
    let y = this.lfoY[ch];
    for (let i = 0; i < n; i++) {
      const t = t0 + i * inc;
      const pos = t / steps + offset;
      const cycle = Math.floor(pos);
      if (cycle !== this.lfoCycle[ch]) {
        // Sample-and-hold: a new random level each cycle.
        this.lfoCycle[ch] = cycle;
        this.lfoHeld[ch] = this.lfoNoise.next();
      }
      y += (lfoValue(this.lfoShape, pos - cycle, this.lfoHeld[ch], this.lfoMorph) - y) * k;
      const fade = this.lfoFade > 0 ? Math.min(1, Math.max(0, t) / this.lfoFade) : 1;
      buf[base + i] = y * fade;
    }
    this.lfoY[ch] = y;
  }

  /** The LFO cycle in 16ths: whole-bar rates last the time signature's bars. */
  private lfoRateSteps(): number {
    const r = LFO_RATES[this.lfoRate];
    if (!r) return 4;
    return r.name.endsWith('BAR') ? (r.steps * this.barLen) / 16 : r.steps;
  }

  private setLfo(id: LfoId, value: number): void {
    if (!this.autoApplying) this.autoBase.set(`l:${id}`, value);
    switch (id) {
      case 'rate':
        this.lfoRate = Math.round(value);
        this.lfoSteps = this.lfoRateSteps();
        this.lfoCycle.fill(-1);
        break;
      case 'shape': this.lfoShape = Math.round(value); break;
      case 'morph': this.lfoMorph = value; break;
      case 'fm': this.lfoFm = value; break;
      case 'vol': this.lfoVol = value; break;
      case 'pitch': this.lfoPitch = value; break;
      case 'filter': this.lfoFilter = value; break;
      case 'pan': this.lfoPan = value; break;
      case 'phase': this.lfoPhase = value; break;
      case 'smooth': this.lfoSmooth = value; break;
      case 'fade': this.lfoFade = value * 16; break;
      case 'retrig': this.lfoRetrig = Math.round(value) === 1; break;
      case 'send': this.lfoSend = value; break;
      case 'spread': this.lfoSpread = value; break;
    }
  }


  private finishBlock(outL: Float32Array, outR: Float32Array, frames: number): void {
    // MASTER (the pan law gives -3 dB at centre; compensated), then the look-ahead limiter.
    for (let i = 0; i < frames; i++) {
      const g = this.master.next() * Math.SQRT2;
      outL[i] *= g;
      outR[i] *= g;
    }
    // The click past MASTER, through the limiter (so it stays in time with the music).
    if (this.clicked && this.clickLevel > 0) {
      const k = 0.5 * this.clickLevel;
      const c = this.clickBuf;
      for (let i = 0; i < frames; i++) {
        outL[i] += c[i] * k;
        outR[i] += c[i] * k;
      }
    }
    this.limiter.process(outL, outR, frames);
    let pL = this.peakL;
    let pR = this.peakR;
    for (let i = 0; i < frames; i++) {
      const l = outL[i];
      const r = outR[i];
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > pL) pL = al;
      if (ar > pR) pR = ar;
    }
    this.peakL = pL;
    this.peakR = pR;
    this.frame += frames;
  }

  // ------------------------------------------------------------------ state

  private slotOf(inst: Instrument, id: string): number {
    const n = Math.min(inst.params.length, LOCK_SLOTS);
    for (let k = 0; k < n; k++) if (inst.params[k].id === id) return k;
    return -1;
  }

  // ------------------------------------------------------------------ patches (one per pattern)

  /** The pattern a sound edit without a pattern goes to: the one switched to, else playing. */
  private editedPattern(ch: number): number {
    return this.pendingPattern[ch] >= 0 ? this.pendingPattern[ch] : this.activePattern[ch];
  }

  /** Frames until the step `steps` steps after the next one starts (0 = the next step). */
  private framesAhead(steps: number): number {
    let f = Math.max(0, this.framesToStep);
    for (let k = 0; k < steps; k++) f += this.stepFrames(this.globalStep + k);
    return f;
  }

  /** Frames until the next bar line (a bar line under a step away: the one after). */
  private framesToBar(): number {
    const steps = (this.barLen - this.barPos(this.globalStep)) % this.barLen;
    const f = this.framesAhead(steps);
    return f < this.stepFrames(this.globalStep) ? this.framesAhead(steps + this.barLen) : f;
  }

  /** Write a whole patch for a pattern (values by param id; missing = the default). */
  private storePatch(ch: number, pat: number, sound: Record<string, number>): void {
    const inst = this.current[ch];
    if (!inst) return;
    const base = (ch * NUM_PATTERNS + pat) * LOCK_SLOTS;
    const n = Math.min(inst.params.length, LOCK_SLOTS);
    for (let k = 0; k < n; k++) this.patchValue[base + k] = sound[inst.params[k].id] ?? inst.params[k].defaultValue;
  }

  /** One value of a pattern's patch; heard now when that pattern is (or is gliding in). */
  private setPatchSound(ch: number, pat: number, id: string, value: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    const slot = this.slotOf(inst, id);
    if (slot < 0) {
      if (pat === this.activePattern[ch]) this.setSound(ch, id, value);
      return;
    }
    this.patchValue[(ch * NUM_PATTERNS + pat) * LOCK_SLOTS + slot] = value;
    const gliding = this.glidePattern[ch];
    if (gliding < 0) {
      if (pat === this.activePattern[ch]) this.setSound(ch, id, value, slot);
    } else if (pat === gliding) {
      const spec = inst.params[slot];
      if (spec.coarse || spec.options) {
        if (pat === this.activePattern[ch]) this.setSound(ch, id, value, slot);
      } else {
        this.glideTo[ch * LOCK_SLOTS + slot] = toNorm(spec, value);
      }
    }
  }

  /** A whole patch for a pattern: heard now, or (glide, playing) glided to by the next bar line. */
  private setPatch(ch: number, pat: number, sound: Record<string, number>, glide: boolean): void {
    if (!this.current[ch]) return;
    this.storePatch(ch, pat, sound);
    const target = this.glidePattern[ch] >= 0 ? this.glidePattern[ch] : this.activePattern[ch];
    if (pat !== target) return;
    if (glide && this.playing) this.startGlide(ch, pat, Math.max(this.glidePattern[ch] >= 0 ? this.glideTotal[ch] - this.glideDone[ch] : 0, this.framesToBar()));
    else {
      this.glidePattern[ch] = -1;
      this.enterPattern(ch, pat, true);
    }
  }

  /** Switch pattern: stopped at once; playing at the loop end (or now), the sound gliding in. */
  private selectPattern(ch: number, pat: number, immediate: boolean): void {
    if (!this.playing) {
      this.pendingPattern[ch] = -1;
      this.glidePattern[ch] = -1;
      this.enterPattern(ch, pat, true);
      return;
    }
    if (pat === this.activePattern[ch]) {
      // Back to the pattern playing: a waiting switch is cancelled and the sound glides back.
      if (this.pendingPattern[ch] >= 0 || this.glidePattern[ch] >= 0) {
        this.pendingPattern[ch] = -1;
        this.startGlide(ch, pat, CANCEL_PATCH_GLIDE * this.sampleRate);
      }
      return;
    }
    if (immediate) {
      this.pendingPattern[ch] = -1;
      this.startGlide(ch, pat, 0);
      this.enterPattern(ch, pat, false);
      return;
    }
    this.pendingPattern[ch] = pat;
    // Glide until it lands: the loop's end, on (or, drifting, rounded up to) a bar line.
    const cur = ch * NUM_PATTERNS + this.activePattern[ch];
    const left = this.loopStart[ch] ? 0 : this.onCount(cur * MAX_STEPS, this.position[ch], this.patternLength[cur]);
    let ahead = Math.ceil(left * this.patternRate[cur] - 1e-6);
    const p = this.barPos(this.globalStep + ahead);
    if (p !== 0) ahead += this.barLen - p;
    this.startGlide(ch, pat, this.framesAhead(ahead));
  }

  /** A switch waiting for the loop end happens. */
  private landPattern(ch: number): void {
    const pat = this.pendingPattern[ch];
    this.pendingPattern[ch] = -1;
    this.enterPattern(ch, pat, this.glidePattern[ch] !== pat);
  }

  /**
   * The track plays pattern `pat` from now: its coarse settings switch now; the rest too
   * when `snap`, else a running glide brings them in.
   */
  private enterPattern(ch: number, pat: number, snap: boolean): void {
    this.activePattern[ch] = pat;
    const inst = this.current[ch];
    if (!inst) return;
    const base = (ch * NUM_PATTERNS + pat) * LOCK_SLOTS;
    const n = Math.min(inst.params.length, LOCK_SLOTS);
    for (let k = 0; k < n; k++) {
      const spec = inst.params[k];
      if (snap || spec.coarse || spec.options) this.setSound(ch, spec.id, this.patchValue[base + k], k);
    }
    if (snap && this.glidePattern[ch] === pat) this.glidePattern[ch] = -1;
  }

  /** Start gliding the track's sound to pattern pat's patch over `frames` (at least MIN_PATCH_GLIDE). */
  private startGlide(ch: number, pat: number, frames: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    const base = ch * LOCK_SLOTS;
    const from = (ch * NUM_PATTERNS + pat) * LOCK_SLOTS;
    const n = Math.min(inst.params.length, LOCK_SLOTS);
    for (let k = 0; k < n; k++) {
      const spec = inst.params[k];
      this.glideFrom[base + k] = toNorm(spec, this.baseValue[base + k]);
      this.glideTo[base + k] = toNorm(spec, this.patchValue[from + k]);
    }
    this.glidePattern[ch] = pat;
    this.glideWait[ch] = 0;
    this.glideDone[ch] = 0;
    this.glideTotal[ch] = Math.max(frames, MIN_PATCH_GLIDE * this.sampleRate);
  }

  /** Move the patch glides on by `frames` (once per block). */
  private stepPatchGlides(frames: number): void {
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const pat = this.glidePattern[ch];
      if (pat < 0) continue;
      const inst = this.current[ch];
      if (!inst) { this.glidePattern[ch] = -1; continue; }
      if (this.glideDone[ch] >= this.glideTotal[ch]) {
        // Arrived: done once the pattern plays (its switch may still wait for its step);
        // a switch that will not come (cancelled) glides back.
        if (this.activePattern[ch] === pat && this.pendingPattern[ch] < 0) this.finishGlide(ch);
        else if (this.pendingPattern[ch] !== pat && !this.glideWait[ch]) this.startGlide(ch, this.activePattern[ch], CANCEL_PATCH_GLIDE * this.sampleRate);
        continue;
      }
      this.glideDone[ch] += frames;
      const t = Math.min(1, this.glideDone[ch] / this.glideTotal[ch]);
      const base = ch * LOCK_SLOTS;
      const n = Math.min(inst.params.length, LOCK_SLOTS);
      for (let k = 0; k < n; k++) {
        const spec = inst.params[k];
        if (spec.coarse || spec.options) continue;
        const a = this.glideFrom[base + k];
        const b = this.glideTo[base + k];
        if (a === b) continue;
        const v = toValue(spec, a + (b - a) * t);
        this.baseValue[base + k] = v;
        if (!this.lockApplied[base + k]) this.applyParam(ch, inst, spec.id, this.withOffset(ch, k, v));
      }
    }
  }

  /** A glide ends: the playing pattern's patch exactly (coarse settings included). */
  private finishGlide(ch: number): void {
    this.glidePattern[ch] = -1;
    this.glideWait[ch] = 0;
    this.enterPattern(ch, this.activePattern[ch], true);
  }

  /** RESET with notes: a pattern's saved notes go in at the next bar line (now when stopped). */
  private swapNotes(ch: number, pat: number, length: number, steps: Step[], speed?: PatternSpeed): void {
    this.pendingNotes[ch * NUM_PATTERNS + pat] = { length, steps, speed };
    this.notesPending = true;
    if (!this.playing) this.applyPendingNotes();
  }

  private applyPendingNotes(): void {
    if (!this.notesPending) return;
    this.notesPending = false;
    for (let k = 0; k < this.pendingNotes.length; k++) {
      const next = this.pendingNotes[k];
      if (!next) continue;
      this.pendingNotes[k] = null;
      const ch = Math.floor(k / NUM_PATTERNS);
      const pat = k % NUM_PATTERNS;
      this.patternLength[k] = Math.max(1, Math.min(MAX_STEPS, next.length));
      this.patternRate[k] = speedSteps(next.speed);
      for (let i = 0; i < MAX_STEPS && i < next.steps.length; i++) this.writeStep(ch, pat, i, next.steps[i]);
      this.refreshOn(k);
    }
  }

  private setSound(ch: number, id: string, value: number, knownSlot = -1): void {
    const inst = this.current[ch];
    if (!inst) return;
    if (!this.autoApplying) this.autoStale[ch] = 1;
    const slot = knownSlot >= 0 ? knownSlot : this.slotOf(inst, id);
    if (slot >= 0) this.baseValue[ch * LOCK_SLOTS + slot] = value;
    this.applyParam(ch, inst, id, slot >= 0 ? this.withOffset(ch, slot, value) : value);
    if (id === 'rolldiv') this.rollDiv[ch] = ROLL_DIVS[Math.round(value)]?.hits ?? 1;
  }

  /** ARP: on / off, MODE, RATE, OCT (option indices); it plays when on and MODE is not OFF. */
  private setArp(ch: number, id: ArpId | 'on', value: number): void {
    if (!this.autoApplying) this.autoBase.set(`a:${ch}:${id}`, value);
    const v = Math.max(0, Math.round(value));
    if (id === 'on') this.arpOn[ch] = v > 0 ? 1 : 0;
    else if (id === 'mode') this.arpSet[ch] = v;
    else if (id === 'rate') this.arpSteps[ch] = ARP_RATES[v]?.steps ?? 1;
    else this.arpOct[ch] = Math.min(3, v + 1);
    this.arpMode[ch] = this.arpOn[ch] ? this.arpSet[ch] : 0;
    if (this.arpMode[ch] === 0 && this.arpHeld[ch]) this.stopArp(ch);
  }

  private writeStep(ch: number, pattern: number, index: number, step: Step): void {
    const s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
    this.stepActive[s] = step.active ? 1 : 0;
    this.stepNote[s] = step.note;
    this.stepVel[s] = step.velocity;
    this.stepAccent[s] = step.accent ? 1 : 0;
    this.stepRing[s] = step.ring ? 1 : 0;
    this.stepRest[s] = step.rest && !step.active ? 1 : 0;
    this.stepSlide[s] = step.slide && step.active ? 1 : 0;
    this.stepGate[s] = Math.max(1, Math.min(MAX_STEPS, Math.round(step.gate || 1)));
    this.stepFlip[s] = step.flip ? 1 : 0;
    const rate = this.patternRate[ch * NUM_PATTERNS + pattern];
    const on = meterPlays(this.meter, index) && !(rate > 1 && rate < 2 && index % 4 === 3) ? 1 : 0;
    this.stepOn[s] = on ^ this.stepFlip[s];
    const extra = step.active && step.extra ? Math.min(step.extra.length, STEP_NOTES - 1) : 0;
    this.stepExtraN[s] = extra;
    for (let k = 0; k < extra; k++) {
      this.stepExtra[s * (STEP_NOTES - 1) + k] = step.extra![k];
      this.stepExtraGate[s * (STEP_NOTES - 1) + k] = Math.max(1, Math.round(step.extraGate?.[k] ?? step.gate));
    }
    const had = this.stepLockSrc[s] !== null;
    const locks = step.locks && Object.keys(step.locks).length > 0 ? { ...step.locks } : null;
    this.stepLockSrc[s] = locks;
    if (had || locks) this.lockChanged(ch, pattern);
  }

  private lockChanged(ch: number, pattern: number): void {
    this.patLanesDirty[ch * NUM_PATTERNS + pattern] = 1;
    this.patDirty = true;
  }

  private setMix(ch: number, id: MixParam, value: number): void {
    if (!this.autoApplying) this.autoBase.set(`m:${ch}:${id}`, value);
    if (id === 'send') { this.sendLevel[ch].setTarget(value); return; }
    if (id === 'dyn') { this.dynDepth[ch] = value / 100; return; }
    if (id === 'gate') { this.gateLength[ch] = value; return; }
    if (id === 'ring') {
      // Every drum type the track can switch to rings this long.
      for (const kind of SOUND_KINDS) this.instruments[ch][kind].setRingLength?.(value);
      return;
    }
    if (id === 'cut') { this.cuts[ch].setAmount(value); return; }
    if (id === 'volume') this.volumeValue[ch] = value;
    else if (id === 'pan') this.pan[ch].setTarget(value);
    else this.muted[ch] = value > 0 ? 1 : 0; // the sequencer skips a muted track's notes
    this.volume[ch].setTarget(this.volumeValue[ch]);
  }
}

/** One SONG automation lane: a knob's locked values (see automation.ts). */
class Lane {
  readonly pos: Float64Array;
  readonly val: Float64Array;
  /** The parameter's spec (mix / bus / LFO; a sound lane's comes from the instrument playing). */
  spec: ParamSpec | null = null;
  /** Holding the knob now, and the value it last set. */
  active = false;
  last = NaN;
  /** Sound lanes: the instrument the slot was looked up on, the slot, linked slots (PAD ATTACK ...). */
  inst: Instrument | null = null;
  slot = -1;
  links: number[] = [];

  constructor(readonly key: string, readonly kind: AutoKind, readonly index: number, readonly id: string, n: number) {
    this.pos = new Float64Array(n);
    this.val = new Float64Array(n);
  }
}
