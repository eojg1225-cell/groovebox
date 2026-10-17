import type { MainToWorklet, WorkletToMain } from './protocol';
import { Smoother } from './smoother';
import {
  MAX_ROLL, MAX_STEPS, NUM_CHANNELS, NUM_PATTERNS, SONG_MAX_ROWS, type Song,
  type InstrumentKind, type Project, type Step,
} from './project';
import { CHORDS } from './chords';
import type { Instrument } from '../instruments/Instrument';
import { INSTRUMENTS, SOUND_KINDS, liveContribution, liveTargets } from '../instruments/registry';
import { toNorm, toValue } from './params';
import { ARP_RATES } from '../instruments/Synth';
import { ROLL_DIVS } from '../instruments/Drum';
import { Noise, Svf } from '../instruments/dsp';
import { LFO_RATES, lfoValue, type LfoId } from './lfo';
import { SendBus } from '../fx/SendBus';
import { DrumBus } from '../fx/DrumBus';
import { Tape } from '../fx/Tape';
import { Limiter } from '../fx/Limiter';
import { EFFECTS, SEND_BUSES } from '../fx';
import type { MixParam } from './protocol';
import { NUM_SENDS } from './project';

/** Largest chunk rendered at once; blocks are split at step boundaries anyway. */
/** Largest chunk rendered at once (also the LFO pitch update rate, ~1.3 ms at 48 kHz). */
const CHUNK = 64;
/** Max sound parameters per instrument that can be locked per step. */
export const LOCK_SLOTS = 32;

const STEP_SLOTS = NUM_CHANNELS * NUM_PATTERNS * MAX_STEPS;

/**
 * Per-hit tone: the channel output passes a gentle 12 dB low-pass whose cutoff follows the
 * hit velocity, so accents are fully bright and ghost notes softer and darker, like a real
 * player hitting harder or lighter.
 */
export function hitToneCutoff(velocity: number): number {
  return 20000 * Math.pow(2, -(1 - Math.min(1, Math.max(0, velocity))) * 3.2);
}

export type RecordedMsg = Extract<WorkletToMain, { type: 'recordedNote' | 'recordedLock' }>;

/**
 * Pure audio engine: sequencer, instruments, mixer, master. No DOM, no Web Audio.
 * The worklet (or a Node test) calls handleMessage() and process().
 *
 * Allocation-free in process(); step data lives in preallocated typed arrays.
 * Timing: a global 16th-note clock (with swing) drives every channel; each channel
 * keeps its own position and loops at its own length (polymeter). Steps fire at the
 * exact sample inside a block.
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
  private readonly stepRoll = new Uint8Array(STEP_SLOTS).fill(1);
  /** Note length in steps (1 = until the next step starts). */
  private readonly stepGate = new Uint8Array(STEP_SLOTS).fill(1);
  /** Parameter locks: [stepSlot * LOCK_SLOTS + paramSlot], NaN = not locked. */
  private readonly locks = new Float32Array(STEP_SLOTS * LOCK_SLOTS).fill(NaN);
  private readonly patternLength = new Uint8Array(NUM_CHANNELS * NUM_PATTERNS).fill(16);

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
  /** Whether a lock is currently applied per channel/param slot. */
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
  private readonly volumeValue = new Float32Array(NUM_CHANNELS).fill(0.8);
  /** The track type's output trim (InstrumentEntry.gain), applied with the volume. */
  private readonly typeGain = new Float32Array(NUM_CHANNELS).fill(1);
  /** Chord mode per channel (index into CHORDS). */
  private readonly chord = new Uint8Array(NUM_CHANNELS);
  /** Steps until the sequenced note on a channel is released (0 = none held). */
  private readonly gateSteps = new Int16Array(NUM_CHANNELS);
  private readonly gateGroup = new Int16Array(NUM_CHANNELS);
  /** The held note is a RING note: it ends at the next hit or rest, not by count. */
  private readonly ringing = new Uint8Array(NUM_CHANNELS);
  /** Live recording: the held note per channel (-1 = none) and where it started. */
  private readonly recNote = new Int16Array(NUM_CHANNELS).fill(-1);
  private readonly recStart = new Float64Array(NUM_CHANNELS);
  private readonly recIndex = new Int16Array(NUM_CHANNELS);
  private readonly recPattern = new Int8Array(NUM_CHANNELS);
  private readonly recVel = new Float32Array(NUM_CHANNELS);
  private readonly recAccent = new Uint8Array(NUM_CHANNELS);
  private readonly recSlide = new Uint8Array(NUM_CHANNELS);
  /** The held note came from a SLIDE step: the next note glides out of it. */
  private readonly sliding = new Uint8Array(NUM_CHANNELS);
  /** Drum tracks: hits per step of a ROLL step (ROLL DIV; the SLIDE flag). 0 = not a drum. */
  private readonly rollDiv = new Uint8Array(NUM_CHANNELS);
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
  // ARP (sound params "arp" / "arprate"): while a note is held its chord tones are played in
  // turn. Mode (0 = off), rate in steps, and per track the held root, its velocity, the next
  // note's index, frames until it, and the arp note sounding now (-1 = none).
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


  // FX 1, the drum bus: member tracks pass through it instead of going straight out.
  private readonly drumBus: DrumBus;
  private readonly inDrumBus = new Uint8Array(NUM_CHANNELS);
  // Sends FX 2 / FX 3 (index 1 / 2; index 0 = FX 1 is not a send): each track feeds at most one.
  private readonly sends: (SendBus | null)[] = [];
  private readonly route = new Int8Array(NUM_CHANNELS).fill(-1); // bus index or -1
  private readonly sendLevel: Smoother[] = [];
  private readonly busL: Float32Array[] = [];
  private readonly busR: Float32Array[] = [];
  private readonly tape: Tape;

  // The LFO, shared by the tracks on it; phase-locked to the song (lfoClock counts 16th steps).
  private lfoClock = 0;
  private lfoSteps = 4;
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
    this.tape = new Tape(sampleRate);
    this.drumBus = new DrumBus(sampleRate);
    for (let k = 0; k < NUM_SENDS; k++) {
      this.sends.push(k === 0 ? null : new SendBus(sampleRate, k));
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
      case 'selectPattern':
        if (!this.playing || msg.immediate) {
          this.activePattern[msg.channel] = msg.pattern;
          this.pendingPattern[msg.channel] = -1;
        } else {
          this.pendingPattern[msg.channel] = msg.pattern;
        }
        break;
      case 'setSound': this.setSound(msg.channel, msg.id, msg.value); break;
      case 'setOffset': this.setOffset(msg.channel, msg.id, msg.value); break;
      case 'setMix': this.setMix(msg.channel, msg.id, msg.value); break;
      case 'setGlobal':
        if (msg.id === 'bpm') { this.bpm = msg.value; for (const b of this.sends) b?.setTempo(msg.value); }
        else if (msg.id === 'swing') this.swing = (msg.value - 50) / 50;
        else if (msg.id === 'master') this.master.setTarget(msg.value);
        else if (msg.id === 'lofi') this.tape.setAmount(msg.value);
        break;
      case 'setRouting': this.route[msg.channel] = this.busIndex(msg.send); break;
      case 'setDrumBus': this.inDrumBus[msg.channel] = msg.on ? 1 : 0; break;
      case 'setDrumBusParam': this.drumBus.setParam(msg.id, msg.value); break;
      case 'setSendFx':
        if (msg.control === 'wet') this.sends[msg.send]?.setWet(msg.effect, msg.value);
        else this.sends[msg.send]?.setIntensity(msg.effect, msg.value);
        break;
      case 'setLfo': this.setLfo(msg.id, msg.value); break;
      case 'setLfoTrack': this.lfoOn[msg.channel] = msg.on ? 1 : 0; break;
      case 'transport':
        if (msg.playing && !this.playing) {
          this.songOn = msg.song === true && this.songLength > 0;
          this.songRow = this.songOn ? Math.max(0, Math.min(this.songLength - 1, msg.fromRow ?? 0)) : -1;
          this.songBar = -1; // the row is entered on the first step
        }
        this.setPlaying(msg.playing);
        break;
      case 'setSong': this.setSong(msg.song); break;
      case 'songJump': if (this.songOn) this.songJumpTo = Math.max(0, Math.min(this.songLength - 1, msg.row)); break;
      case 'trigger': this.noteOn(msg.channel, msg.note, msg.velocity, false, msg.slideFrom ?? -1); break;
      case 'release': this.release(msg.channel, msg.note); break;
      case 'setInstrument': this.setInstrument(msg.channel, msg.kind, msg.sound); break;
      case 'setChord': this.chord[msg.channel] = msg.chord; break;
      case 'recordNote': this.recordNote(msg.channel, msg.note, msg.velocity, msg.accent, msg.slide === true); break;
      case 'recordLock': this.recordLock(msg.channel, msg.id, msg.value); break;
      case 'ping': break; // answered by the host
    }
  }

  loadProject(p: Project): void {
    this.bpm = p.bpm;
    for (const id in p.fx1) this.drumBus.setParam(id, p.fx1[id]);
    this.drumBus.settle();
    for (const k of SEND_BUSES) {
      const bus = this.sends[k];
      if (!bus) continue;
      bus.setTempo(p.bpm);
      for (let e = 0; e < EFFECTS.length; e++) {
        bus.setWet(e, p.sendWet[k]?.[e] ?? 0);
        bus.setIntensity(e, p.sendInt[k]?.[e] ?? 0.5);
      }
      bus.settle();
    }
    this.tape.setImmediate(p.lofi);
    this.setSong(p.song ?? { rows: [] });
    for (const id in p.lfo) this.setLfo(id as LfoId, p.lfo[id as LfoId]);
    this.swing = (p.swing - 50) / 50;
    this.master.setImmediate(p.master);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const c = p.channels[ch];
      this.setInstrument(ch, c.instrument, c.instrument === 'none' ? {} : (c.sounds[c.instrument] ?? {}));
      for (const id in c.liveOffset) this.setOffset(ch, id, c.liveOffset[id]);
      this.chord[ch] = c.chord;
      this.lfoOn[ch] = c.lfoOn ? 1 : 0;
      this.setMix(ch, 'volume', c.volume);
      this.setMix(ch, 'mute', c.mute ? 1 : 0);
      this.setMix(ch, 'pan', c.pan);
      this.route[ch] = this.busIndex(c.fxSend);
      this.inDrumBus[ch] = c.fx1 ? 1 : 0;
      this.sendLevel[ch].setImmediate(c.sendLevel);
      // A loaded project starts at its values instead of gliding to them.
      this.volume[ch].setImmediate(c.mute ? 0 : c.volume);
      this.pan[ch].setImmediate(c.pan);
      this.activePattern[ch] = c.activePattern;
      this.pendingPattern[ch] = -1;
      for (let pat = 0; pat < NUM_PATTERNS; pat++) {
        this.patternLength[ch * NUM_PATTERNS + pat] = c.patterns[pat].length;
        for (let i = 0; i < MAX_STEPS; i++) this.writeStep(ch, pat, i, c.patterns[pat].steps[i]);
      }
    }
  }

  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    if (!playing) {
      this.songOn = false;
      this.songRow = -1;
      this.songJumpTo = -1;
      this.songOff.fill(0);
    }
    this.globalStep = 0;
    this.framesToStep = 0; // first step fires at the next sample
    this.lfoClock = 0; // LFOs restart with the song
    this.lfoTrig.fill(0);
    this.position.fill(0);
    this.currentStep.fill(-1);
    this.skipStep.fill(-1);
    this.rollLeft.fill(0);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      if (this.pendingPattern[ch] >= 0) {
        this.activePattern[ch] = this.pendingPattern[ch];
        this.pendingPattern[ch] = -1;
      }
      if (!playing) {
        if (this.arpHeld[ch]) this.stopArp(ch);
        this.current[ch]?.noteOff(-1);
        this.gateSteps[ch] = 0;
        this.recNote[ch] = -1;
        this.restoreBase(ch);
      }
    }
  }

  /** Overwrites outL/outR with `frames` samples. */
  process(outL: Float32Array, outR: Float32Array, frames: number): void {
    outL.fill(0, 0, frames);
    outR.fill(0, 0, frames);
    let pos = 0;
    while (pos < frames) {
      if (this.playing && this.framesToStep <= 0) {
        this.fireStep();
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
      this.renderChunk(outL, outR, pos, n);
      pos += n;
      for (let ch = 0; ch < NUM_CHANNELS; ch++) if (this.arpHeld[ch]) this.arpAt[ch] -= n;
      if (this.playing) {
        this.framesToStep -= n;
        for (let ch = 0; ch < NUM_CHANNELS; ch++) if (this.rollLeft[ch] > 0) this.rollAt[ch] -= n;
      }
    }
    this.finishBlock(outL, outR, frames);
  }

  /** Position in the current bar (16 steps), 0..1; 0 when stopped. */
  get barPhase(): number {
    if (!this.playing || this.globalStep === 0) return 0;
    const inStep = Math.min(1, Math.max(0, (this.lastStepFrames - this.framesToStep) / this.lastStepFrames));
    const pos = (this.globalStep - 1 + inStep) / 16;
    return pos - Math.floor(pos);
  }

  resetPeaks(): void {
    this.peakL = 0;
    this.peakR = 0;
  }

  /** Send number (FX 2 / FX 3) -> bus index; anything else = no send. */
  private busIndex(send: number): number {
    return send >= 2 && send <= NUM_SENDS ? send - 1 : -1;
  }

  /** Length in frames of the 16th step that starts at global step k (with swing). */
  stepFrames(k: number): number {
    const base = (60 / this.bpm / 4) * this.sampleRate;
    return k % 2 === 0 ? base * (1 + this.swing) : base * (1 - this.swing);
  }

  // ------------------------------------------------------------------ sequencing

  private fireStep(): void {
    const stepLen = this.stepFrames(this.globalStep);
    if (this.songOn && this.globalStep % 16 === 0) this.songBarLine();
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const inst = this.current[ch];
      if (!inst) continue;
      // Quantised pattern switch at the channel's loop start.
      if (this.position[ch] === 0 && this.pendingPattern[ch] >= 0) {
        this.activePattern[ch] = this.pendingPattern[ch];
        this.pendingPattern[ch] = -1;
      }
      const pat = ch * NUM_PATTERNS + this.activePattern[ch];
      const len = this.patternLength[pat];
      const idx = this.position[ch] % len;
      const s = pat * MAX_STEPS + idx;
      const hit = this.stepActive[s] === 1 && this.skipStep[ch] !== idx && this.songOff[ch] === 0;
      // SLIDE: the held note was marked to slide, so it glides into this one (no release).
      const slideFrom = hit && this.sliding[ch] && this.gateSteps[ch] > 0 ? this.gateGroup[ch] : -1;
      this.rollLeft[ch] = 0;
      if (slideFrom >= 0) {
        this.gateSteps[ch] = 0;
        this.ringing[ch] = 0;
      } else if (this.gateSteps[ch] > 0) {
        if (this.ringing[ch]) {
          // A RING note ends at the next hit or rest on this track.
          if (this.stepActive[s] || this.stepRest[s]) this.releaseGate(ch);
        } else if (--this.gateSteps[ch] === 0) {
          // A held note ends where its gate says: exactly at the start of a later step.
          this.releaseGate(ch);
        }
      }
      this.applyLocks(ch, s);
      if (hit) {
        const ring = this.stepRing[s] === 1;
        // On drum tracks the SLIDE flag is ROLL: the hit repeats at ROLL DIV.
        const drumRoll = this.rollDiv[ch] > 0 && this.stepSlide[s] === 1;
        // A SLIDE note is held (like RING) until the next note, which it glides into.
        const slide = this.rollDiv[ch] === 0 && this.stepSlide[s] === 1;
        this.noteOn(ch, this.stepNote[s], this.stepVel[s], ring, slideFrom, slide);
        this.gateGroup[ch] = this.stepNote[s];
        this.gateSteps[ch] = ring || slide ? 1 : this.stepGate[s];
        this.ringing[ch] = ring || slide ? 1 : 0;
        this.sliding[ch] = slide ? 1 : 0;
        const roll = drumRoll ? this.rollDiv[ch] : this.stepRoll[s];
        if (roll > 1) {
          this.rollLeft[ch] = roll - 1;
          this.rollEvery[ch] = stepLen / roll;
          this.rollAt[ch] = stepLen / roll;
          this.rollNote[ch] = this.stepNote[s];
          this.rollVel[ch] = this.stepVel[s];
        }
      }
      this.skipStep[ch] = -1;
      this.currentStep[ch] = idx;
      this.position[ch] = (idx + 1) % len;
    }
    this.lastStepFrames = this.stepFrames(this.globalStep);
    this.framesToStep += this.lastStepFrames;
    this.globalStep++;
  }

  /** Song: a bar line. Move on to the next row (or a queued jump) when this row is done. */
  private songBarLine(): void {
    if (this.songBar < 0) {
      this.enterRow(this.songRow);
      return;
    }
    this.songBar++;
    if (this.songJumpTo >= 0) {
      this.enterRow(this.songJumpTo);
      this.songJumpTo = -1;
    } else if (this.songBar >= this.songBars[this.songRow]) {
      this.enterRow((this.songRow + 1) % this.songLength); // the end loops to the top
    }
  }

  /** Song: start a row. Every track restarts its row pattern (or falls silent). */
  private enterRow(row: number): void {
    this.songRow = row;
    this.songBar = 0;
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const p = this.songPatterns[row * NUM_CHANNELS + ch];
      this.pendingPattern[ch] = -1;
      this.position[ch] = 0;
      if (p < 0) {
        if (!this.songOff[ch] && this.gateSteps[ch] > 0) this.releaseGate(ch);
        this.songOff[ch] = 1;
      } else {
        this.songOff[ch] = 0;
        this.activePattern[ch] = p;
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
  }

  /**
   * Play a note (as a chord when chord mode is on); voices are grouped by the root note.
   * slideFrom >= 0: legato from that still-sounding root (no release, no new attack).
   */
  private noteOn(ch: number, note: number, velocity: number, ring = false, slideFrom = -1, slide = false): void {
    const inst = this.current[ch];
    if (!inst) return;
    if (this.gateSteps[ch] > 0 && slideFrom < 0) this.releaseGate(ch);
    const fc = hitToneCutoff(velocity);
    this.toneL[ch].setup(fc, 0, this.sampleRate);
    this.toneR[ch].setup(fc, 0, this.sampleRate);
    if (this.arpMode[ch] > 0) {
      // ARP: start stepping through the chord from its first note.
      this.stopArp(ch);
      this.arpHeld[ch] = 1;
      this.arpRoot[ch] = note;
      this.arpVel[ch] = velocity;
      this.arpIndex[ch] = 0;
      this.arpStep(ch);
    } else {
      const intervals = CHORDS[this.chord[ch]]?.intervals ?? CHORDS[0].intervals;
      for (let i = 0; i < intervals.length; i++) inst.noteOn(note + intervals[i], velocity, note, ring, slideFrom, slide);
    }
    // RETRIG NOTE: the LFO restarts with each new note (not on slides).
    if (slideFrom < 0) this.lfoTrig[ch] = this.lfoClock;
  }

  /** One ROLL repeat: re-strike the step's note (same velocity), then schedule the next. */
  private rollHit(ch: number): void {
    const inst = this.current[ch];
    this.rollLeft[ch]--;
    this.rollAt[ch] += this.rollEvery[ch];
    if (!inst) return;
    const note = this.rollNote[ch];
    const intervals = CHORDS[this.chord[ch]]?.intervals ?? CHORDS[0].intervals;
    for (let i = 0; i < intervals.length; i++) inst.noteOn(note + intervals[i], this.rollVel[ch], note, this.ringing[ch] === 1);
  }

  /** ARP: play the next note of the held chord (and schedule the one after). */
  private arpStep(ch: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    if (this.arpNote[ch] >= 0) inst.noteOff(this.arpNote[ch]);
    const intervals = CHORDS[this.chord[ch]]?.intervals ?? CHORDS[0].intervals;
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

  private releaseGate(ch: number): void {
    this.sliding[ch] = 0;
    if (this.arpHeld[ch]) this.stopArp(ch);
    this.current[ch]?.noteOff(this.gateGroup[ch]);
    this.gateSteps[ch] = 0;
    this.ringing[ch] = 0;
  }

  /** Live note released. If it was being recorded, its length becomes the step's gate. */
  private release(ch: number, note: number): void {
    if (this.arpHeld[ch] && this.arpRoot[ch] === note) this.stopArp(ch);
    this.current[ch]?.noteOff(note);
    if (this.recNote[ch] !== note) return;
    this.recNote[ch] = -1;
    if (!this.playing) return;
    const elapsed = this.lastStepFrames - this.framesToStep;
    const endStep = elapsed < this.lastStepFrames / 2 ? this.globalStep - 1 : this.globalStep;
    const pattern = this.recPattern[ch];
    // Up to the whole loop (a note may be held past the end and on from the start).
    const gate = Math.max(1, Math.min(this.patternLength[ch * NUM_PATTERNS + pattern], endStep - this.recStart[ch]));
    const index = this.recIndex[ch];
    this.stepGate[(ch * NUM_PATTERNS + pattern) * MAX_STEPS + index] = gate;
    this.onRecorded?.({
      type: 'recordedNote', channel: ch, pattern, index, note,
      velocity: this.recVel[ch], accent: this.recAccent[ch] === 1, gate, slide: this.recSlide[ch] === 1,
    });
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
      inst.setParam(inst.params[k].id, this.withOffset(ch, k, this.baseValue[base + k]));
    }
  }

  private setInstrument(ch: number, kind: InstrumentKind, sound: Record<string, number>): void {
    if (this.arpHeld[ch]) this.stopArp(ch);
    this.arpMode[ch] = 0;
    this.rollDiv[ch] = 0;
    this.current[ch]?.noteOff(-1);
    this.gateSteps[ch] = 0;
    this.current[ch] = kind === 'none' ? null : this.instruments[ch][kind];
    this.kind[ch] = kind;
    this.typeGain[ch] = kind === 'none' ? 1 : INSTRUMENTS[kind].gain ?? 1;
    // Live offsets belong to the old type's knobs.
    this.liveOffsets[ch].clear();
    this.offsetNorm.fill(0, ch * LOCK_SLOTS, (ch + 1) * LOCK_SLOTS);
    this.lockApplied.fill(0, ch * LOCK_SLOTS, (ch + 1) * LOCK_SLOTS);
    // Locks are stored by parameter slot, which means something else on another instrument.
    const from = ch * NUM_PATTERNS * MAX_STEPS * LOCK_SLOTS;
    this.locks.fill(NaN, from, from + NUM_PATTERNS * MAX_STEPS * LOCK_SLOTS);
    const inst = this.current[ch];
    if (inst) inst.params.forEach((spec, slot) => this.setSound(ch, spec.id, sound[spec.id] ?? spec.defaultValue, slot));
  }

  /** Apply the step's locks; params locked on the previous step but not this one revert. */
  private applyLocks(ch: number, stepSlot: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    const n = Math.min(inst.params.length, LOCK_SLOTS);
    for (let k = 0; k < n; k++) {
      const v = this.locks[stepSlot * LOCK_SLOTS + k];
      const applied = ch * LOCK_SLOTS + k;
      if (v === v) { // not NaN
        inst.setParam(inst.params[k].id, this.withOffset(ch, k, v));
        this.lockApplied[applied] = 1;
      } else if (this.lockApplied[applied]) {
        inst.setParam(inst.params[k].id, this.withOffset(ch, k, this.baseValue[applied]));
        this.lockApplied[applied] = 0;
      }
    }
  }

  private restoreBase(ch: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    for (let k = 0; k < Math.min(inst.params.length, LOCK_SLOTS); k++) {
      if (this.lockApplied[ch * LOCK_SLOTS + k]) {
        inst.setParam(inst.params[k].id, this.withOffset(ch, k, this.baseValue[ch * LOCK_SLOTS + k]));
        this.lockApplied[ch * LOCK_SLOTS + k] = 0;
      }
    }
  }

  /** Index of the step nearest to "now" for a channel, given the current step progress. */
  private nearestStep(ch: number): { index: number; isNext: boolean } {
    const elapsed = this.lastStepFrames - this.framesToStep;
    const cur = this.currentStep[ch];
    if (cur < 0) return { index: 0, isNext: true };
    return elapsed < this.lastStepFrames / 2
      ? { index: cur, isNext: false }
      : { index: this.position[ch], isNext: true };
  }

  private recordNote(ch: number, note: number, velocity: number, accent: boolean, slide = false): void {
    // Legato over a note still being recorded: glide from it, and it now lasts until here.
    const prev = slide && this.recNote[ch] >= 0 ? this.recNote[ch] : -1;
    this.noteOn(ch, note, velocity, false, slide ? prev : -1);
    if (!this.playing || !this.current[ch]) return;
    const { index, isNext } = this.nearestStep(ch);
    const pattern = this.activePattern[ch];
    if (prev >= 0) {
      const start = isNext ? this.globalStep : this.globalStep - 1;
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
    this.stepRoll[s] = 1;
    this.stepGate[s] = 1;
    // The note already sounded now; don't play it again when that step comes round.
    if (isNext) this.skipStep[ch] = index;
    // Remember it so the release sets its length.
    this.recNote[ch] = note;
    this.recStart[ch] = isNext ? this.globalStep : this.globalStep - 1;
    this.recIndex[ch] = index;
    this.recPattern[ch] = pattern;
    this.recVel[ch] = velocity;
    this.recAccent[ch] = accent ? 1 : 0;
    this.recSlide[ch] = 0;
    this.onRecorded?.({ type: 'recordedNote', channel: ch, pattern, index, note, velocity, accent, gate: 1, slide: false });
  }

  private recordLock(ch: number, id: string, value: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    const slot = this.slotOf(inst, id);
    if (slot < 0) return;
    inst.setParam(id, this.withOffset(ch, slot, value)); // hear it now
    if (!this.playing || this.currentStep[ch] < 0) return;
    const pattern = this.activePattern[ch];
    const index = this.currentStep[ch];
    const s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
    this.locks[s * LOCK_SLOTS + slot] = value;
    this.lockApplied[ch * LOCK_SLOTS + slot] = 1;
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
      const volDepth = lfo ? this.lfoVol : 0;
      const panDepth = lfo ? this.lfoPan : 0;
      const sendDepth = lfo ? this.lfoSend : 0;
      const vol = this.volume[ch];
      const tg = this.typeGain[ch];
      const pan = this.pan[ch];
      const tl = this.toneL[ch];
      const tr = this.toneR[ch];
      const level = this.sendLevel[ch];
      const bus = this.route[ch];
      const bL = bus >= 0 ? this.busL[bus] : null;
      const bR = bus >= 0 ? this.busR[bus] : null;
      // Drum bus members go through FX 1 instead of straight to the mix.
      const dL = this.inDrumBus[ch] ? this.busL[0] : outL;
      const dR = this.inDrumBus[ch] ? this.busR[0] : outR;
      const dOff = this.inDrumBus[ch] ? 0 : off;
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
        tl.process(sl[i]);
        tr.process(sr[i]);
        const l = tl.low * v * Math.cos(a);
        const r = tr.low * v * Math.sin(a);
        dL[dOff + i] += l;
        dR[dOff + i] += r;
        // Post-fader send, taken before the drum bus (a muted track sends nothing).
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
    this.drumBus.setClock(this.lfoClock, this.lfoStepInc());
    this.drumBus.process(this.busL[0], this.busR[0], outL, outR, off, n);
    // Each send bus runs its six effects back into the mix.
    for (const k of SEND_BUSES) this.sends[k]?.process(this.busL[k], this.busR[k], outL, outR, off, n);
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

  private setLfo(id: LfoId, value: number): void {
    switch (id) {
      case 'rate': this.lfoSteps = LFO_RATES[Math.round(value)]?.steps ?? 4; this.lfoCycle.fill(-1); break;
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
    this.tape.process(outL, outR, frames);
    // MASTER (the pan law gives -3 dB at centre; compensated), then the look-ahead limiter.
    for (let i = 0; i < frames; i++) {
      const g = this.master.next() * Math.SQRT2;
      outL[i] *= g;
      outR[i] *= g;
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

  private setSound(ch: number, id: string, value: number, knownSlot = -1): void {
    const inst = this.current[ch];
    if (!inst) return;
    const slot = knownSlot >= 0 ? knownSlot : this.slotOf(inst, id);
    if (slot >= 0) this.baseValue[ch * LOCK_SLOTS + slot] = value;
    inst.setParam(id, slot >= 0 ? this.withOffset(ch, slot, value) : value);
    if (id === 'arp') {
      this.arpMode[ch] = Math.max(0, Math.round(value));
      if (this.arpMode[ch] === 0 && this.arpHeld[ch]) this.stopArp(ch);
    } else if (id === 'arprate') {
      this.arpSteps[ch] = ARP_RATES[Math.round(value)]?.steps ?? 1;
    } else if (id === 'rolldiv') {
      this.rollDiv[ch] = ROLL_DIVS[Math.round(value)]?.hits ?? 2;
    } else if (id === 'arpoct') {
      this.arpOct[ch] = Math.max(1, Math.min(3, Math.round(value) + 1));
    }
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
    this.stepRoll[s] = Math.max(1, Math.min(MAX_ROLL, Math.round(step.roll ?? 1)));
    this.stepGate[s] = Math.max(1, Math.min(MAX_STEPS, Math.round(step.gate || 1)));
    const base = s * LOCK_SLOTS;
    this.locks.fill(NaN, base, base + LOCK_SLOTS);
    const inst = this.current[ch];
    if (step.locks && inst) {
      for (const id in step.locks) {
        const slot = this.slotOf(inst, id);
        if (slot >= 0) this.locks[base + slot] = step.locks[id];
      }
    }
  }

  private setMix(ch: number, id: MixParam, value: number): void {
    if (id === 'send') { this.sendLevel[ch].setTarget(value); return; }
    if (id === 'volume') this.volumeValue[ch] = value;
    else if (id === 'pan') this.pan[ch].setTarget(value);
    else this.muted[ch] = value > 0 ? 1 : 0;
    this.volume[ch].setTarget(this.muted[ch] ? 0 : this.volumeValue[ch]);
  }
}
