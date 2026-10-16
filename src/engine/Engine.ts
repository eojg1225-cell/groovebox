import type { MainToWorklet, WorkletToMain } from './protocol';
import { Smoother } from './smoother';
import {
  MAX_STEPS, NUM_CHANNELS, NUM_PATTERNS,
  type InstrumentKind, type Project, type Step,
} from './project';
import { CHORDS } from './chords';
import type { Instrument } from '../instruments/Instrument';
import { INSTRUMENTS, SOUND_KINDS } from '../instruments/registry';
import { Svf } from '../instruments/dsp';
import { SendBus } from '../fx/SendBus';
import { Tape } from '../fx/Tape';
import { EFFECTS } from '../fx';
import type { MixParam } from './protocol';
import { NUM_SENDS } from './project';

/** Largest chunk rendered at once; blocks are split at step boundaries anyway. */
const CHUNK = 256;
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
  /** Called when motion recording writes into a pattern (event rate, not per block). */
  onRecorded: ((msg: RecordedMsg) => void) | null = null;

  private bpm = 128;
  private swing = 0; // 0..0.5 fraction of a step
  private readonly master: Smoother;

  // Step data: index = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + step
  private readonly stepActive = new Uint8Array(STEP_SLOTS);
  private readonly stepNote = new Float32Array(STEP_SLOTS);
  private readonly stepVel = new Float32Array(STEP_SLOTS);
  private readonly stepAccent = new Uint8Array(STEP_SLOTS);
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
  /** Channel's own sound values per param slot (what applies when no lock). */
  private readonly baseValue = new Float32Array(NUM_CHANNELS * LOCK_SLOTS);
  /** Whether a lock is currently applied per channel/param slot. */
  private readonly lockApplied = new Uint8Array(NUM_CHANNELS * LOCK_SLOTS);
  private readonly volume: Smoother[] = [];
  private readonly pan: Smoother[] = [];
  private readonly toneL: Svf[] = [];
  private readonly toneR: Svf[] = [];
  private readonly volumeValue = new Float32Array(NUM_CHANNELS).fill(0.8);
  /** Chord mode per channel (index into CHORDS). */
  private readonly chord = new Uint8Array(NUM_CHANNELS);
  /** Steps until the sequenced note on a channel is released (0 = none held). */
  private readonly gateSteps = new Int16Array(NUM_CHANNELS);
  private readonly gateGroup = new Int16Array(NUM_CHANNELS);
  /** Live recording: the held note per channel (-1 = none) and where it started. */
  private readonly recNote = new Int16Array(NUM_CHANNELS).fill(-1);
  private readonly recStart = new Float64Array(NUM_CHANNELS);
  private readonly recIndex = new Int16Array(NUM_CHANNELS);
  private readonly recPattern = new Int8Array(NUM_CHANNELS);
  private readonly recVel = new Float32Array(NUM_CHANNELS);
  private readonly recAccent = new Uint8Array(NUM_CHANNELS);
  private readonly muted = new Uint8Array(NUM_CHANNELS);
  private readonly scratchL = new Float32Array(CHUNK);
  private readonly scratchR = new Float32Array(CHUNK);

  // Track low-pass (CUTOFF), coefficients refreshed every 16 samples while it moves.
  private readonly cutoff: Smoother[] = [];
  private readonly cutL: Svf[] = [];
  private readonly cutR: Svf[] = [];
  private readonly cutApplied = new Float32Array(NUM_CHANNELS);

  // Sends: each track feeds at most one of the three send buses.
  private readonly sends: SendBus[] = [];
  private readonly route = new Int8Array(NUM_CHANNELS).fill(-1); // bus index or -1
  private readonly sendLevel: Smoother[] = [];
  private readonly busL: Float32Array[] = [];
  private readonly busR: Float32Array[] = [];
  private readonly tape: Tape;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.master = new Smoother(0.8, 0.02, sampleRate);
    this.tape = new Tape(sampleRate);
    for (let k = 0; k < NUM_SENDS; k++) {
      this.sends.push(new SendBus(sampleRate, k));
      this.busL.push(new Float32Array(CHUNK));
      this.busR.push(new Float32Array(CHUNK));
    }
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      this.sendLevel.push(new Smoother(0.5, 0.02, sampleRate));
      this.cutoff.push(new Smoother(20000, 0.02, sampleRate));
      const l = new Svf();
      const r = new Svf();
      l.setup(20000, 0, sampleRate);
      r.setup(20000, 0, sampleRate);
      this.cutL.push(l);
      this.cutR.push(r);
      this.cutApplied[ch] = 20000;
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
      case 'setMix': this.setMix(msg.channel, msg.id, msg.value); break;
      case 'setGlobal':
        if (msg.id === 'bpm') { this.bpm = msg.value; for (const b of this.sends) b.setTempo(msg.value); }
        else if (msg.id === 'swing') this.swing = (msg.value - 50) / 50;
        else if (msg.id === 'master') this.master.setTarget(msg.value);
        else if (msg.id === 'lofi') this.tape.setAmount(msg.value);
        break;
      case 'setRouting': this.route[msg.channel] = msg.send >= 1 && msg.send <= NUM_SENDS ? msg.send - 1 : -1; break;
      case 'setSendFx': this.sends[msg.send]?.setAmount(msg.effect, msg.value); break;
      case 'transport': this.setPlaying(msg.playing); break;
      case 'trigger': this.noteOn(msg.channel, msg.note, msg.velocity); break;
      case 'release': this.release(msg.channel, msg.note); break;
      case 'setInstrument': this.setInstrument(msg.channel, msg.kind, msg.sound); break;
      case 'setChord': this.chord[msg.channel] = msg.chord; break;
      case 'recordNote': this.recordNote(msg.channel, msg.note, msg.velocity, msg.accent); break;
      case 'recordLock': this.recordLock(msg.channel, msg.id, msg.value); break;
      case 'ping': break; // answered by the host
    }
  }

  loadProject(p: Project): void {
    this.bpm = p.bpm;
    for (let k = 0; k < NUM_SENDS; k++) {
      const bus = this.sends[k];
      bus.setTempo(p.bpm);
      for (let e = 0; e < EFFECTS.length; e++) bus.setAmount(e, p.sendFx[k]?.[e] ?? 0);
      bus.settle();
    }
    this.tape.setImmediate(p.lofi);
    this.swing = (p.swing - 50) / 50;
    this.master.setImmediate(p.master);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const c = p.channels[ch];
      this.setInstrument(ch, c.instrument, c.instrument === 'none' ? {} : (c.sounds[c.instrument] ?? {}));
      this.chord[ch] = c.chord;
      this.setMix(ch, 'volume', c.volume);
      this.setMix(ch, 'mute', c.mute ? 1 : 0);
      this.setMix(ch, 'pan', c.pan);
      this.route[ch] = c.fxSend >= 1 && c.fxSend <= NUM_SENDS ? c.fxSend - 1 : -1;
      this.sendLevel[ch].setImmediate(c.sendLevel);
      this.cutoff[ch].setImmediate(c.cutoff);
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
    this.globalStep = 0;
    this.framesToStep = 0; // first step fires at the next sample
    this.position.fill(0);
    this.currentStep.fill(-1);
    this.skipStep.fill(-1);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      if (this.pendingPattern[ch] >= 0) {
        this.activePattern[ch] = this.pendingPattern[ch];
        this.pendingPattern[ch] = -1;
      }
      if (!playing) {
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
      if (this.playing) {
        const until = Math.ceil(this.framesToStep);
        if (until < n) n = until;
      }
      this.renderChunk(outL, outR, pos, n);
      pos += n;
      if (this.playing) this.framesToStep -= n;
    }
    this.finishBlock(outL, outR, frames);
  }

  resetPeaks(): void {
    this.peakL = 0;
    this.peakR = 0;
  }

  /** Length in frames of the 16th step that starts at global step k (with swing). */
  stepFrames(k: number): number {
    const base = (60 / this.bpm / 4) * this.sampleRate;
    return k % 2 === 0 ? base * (1 + this.swing) : base * (1 - this.swing);
  }

  // ------------------------------------------------------------------ sequencing

  private fireStep(): void {
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
      // A held note ends where its gate says: exactly at the start of a later step.
      if (this.gateSteps[ch] > 0 && --this.gateSteps[ch] === 0) this.releaseGate(ch);
      this.applyLocks(ch, s);
      if (this.stepActive[s] && this.skipStep[ch] !== idx) {
        this.noteOn(ch, this.stepNote[s], this.stepVel[s]);
        this.gateGroup[ch] = this.stepNote[s];
        this.gateSteps[ch] = this.stepGate[s];
      }
      this.skipStep[ch] = -1;
      this.currentStep[ch] = idx;
      this.position[ch] = (idx + 1) % len;
    }
    this.lastStepFrames = this.stepFrames(this.globalStep);
    this.framesToStep += this.lastStepFrames;
    this.globalStep++;
  }

  /** Play a note (as a chord when chord mode is on); voices are grouped by the root note. */
  private noteOn(ch: number, note: number, velocity: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    if (this.gateSteps[ch] > 0) this.releaseGate(ch);
    const fc = hitToneCutoff(velocity);
    this.toneL[ch].setup(fc, 0, this.sampleRate);
    this.toneR[ch].setup(fc, 0, this.sampleRate);
    const intervals = CHORDS[this.chord[ch]]?.intervals ?? CHORDS[0].intervals;
    for (let i = 0; i < intervals.length; i++) inst.noteOn(note + intervals[i], velocity, note);
  }

  private releaseGate(ch: number): void {
    this.current[ch]?.noteOff(this.gateGroup[ch]);
    this.gateSteps[ch] = 0;
  }

  /** Live note released. If it was being recorded, its length becomes the step's gate. */
  private release(ch: number, note: number): void {
    this.current[ch]?.noteOff(note);
    if (this.recNote[ch] !== note) return;
    this.recNote[ch] = -1;
    if (!this.playing) return;
    const elapsed = this.lastStepFrames - this.framesToStep;
    const endStep = elapsed < this.lastStepFrames / 2 ? this.globalStep - 1 : this.globalStep;
    const gate = Math.max(1, Math.min(MAX_STEPS, endStep - this.recStart[ch]));
    const pattern = this.recPattern[ch];
    const index = this.recIndex[ch];
    this.stepGate[(ch * NUM_PATTERNS + pattern) * MAX_STEPS + index] = gate;
    this.onRecorded?.({
      type: 'recordedNote', channel: ch, pattern, index, note,
      velocity: this.recVel[ch], accent: this.recAccent[ch] === 1, gate,
    });
  }

  private setInstrument(ch: number, kind: InstrumentKind, sound: Record<string, number>): void {
    this.current[ch]?.noteOff(-1);
    this.gateSteps[ch] = 0;
    this.current[ch] = kind === 'none' ? null : this.instruments[ch][kind];
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
        inst.setParam(inst.params[k].id, v);
        this.lockApplied[applied] = 1;
      } else if (this.lockApplied[applied]) {
        inst.setParam(inst.params[k].id, this.baseValue[applied]);
        this.lockApplied[applied] = 0;
      }
    }
  }

  private restoreBase(ch: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    for (let k = 0; k < Math.min(inst.params.length, LOCK_SLOTS); k++) {
      if (this.lockApplied[ch * LOCK_SLOTS + k]) {
        inst.setParam(inst.params[k].id, this.baseValue[ch * LOCK_SLOTS + k]);
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

  private recordNote(ch: number, note: number, velocity: number, accent: boolean): void {
    this.noteOn(ch, note, velocity);
    if (!this.playing || !this.current[ch]) return;
    const { index, isNext } = this.nearestStep(ch);
    const pattern = this.activePattern[ch];
    const s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
    this.stepActive[s] = 1;
    this.stepNote[s] = note;
    this.stepVel[s] = velocity;
    this.stepAccent[s] = accent ? 1 : 0;
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
    this.onRecorded?.({ type: 'recordedNote', channel: ch, pattern, index, note, velocity, accent, gate: 1 });
  }

  private recordLock(ch: number, id: string, value: number): void {
    const inst = this.current[ch];
    if (!inst) return;
    const slot = this.slotOf(inst, id);
    if (slot < 0) return;
    inst.setParam(id, value); // hear it now
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
    for (let k = 0; k < NUM_SENDS; k++) {
      this.busL[k].fill(0, 0, n);
      this.busR[k].fill(0, 0, n);
    }
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const inst = this.current[ch];
      if (!inst) continue;
      sl.fill(0, 0, n);
      sr.fill(0, 0, n);
      inst.render(sl, sr, 0, n);
      const vol = this.volume[ch];
      const pan = this.pan[ch];
      const tl = this.toneL[ch];
      const tr = this.toneR[ch];
      const cut = this.cutoff[ch];
      const cl = this.cutL[ch];
      const cr = this.cutR[ch];
      const level = this.sendLevel[ch];
      const bus = this.route[ch];
      const bL = bus >= 0 ? this.busL[bus] : null;
      const bR = bus >= 0 ? this.busR[bus] : null;
      for (let i = 0; i < n; i++) {
        const v = vol.next();
        // Equal-power pan, -1..1 -> 0..pi/2
        const a = (pan.next() + 1) * 0.25 * Math.PI;
        const fc = cut.next();
        if ((i & 15) === 0 && fc !== this.cutApplied[ch]) {
          cl.setup(fc, 0.1, this.sampleRate);
          cr.setup(fc, 0.1, this.sampleRate);
          this.cutApplied[ch] = fc;
        }
        tl.process(sl[i]);
        tr.process(sr[i]);
        cl.process(tl.low);
        cr.process(tr.low);
        const l = cl.low * v * Math.cos(a);
        const r = cr.low * v * Math.sin(a);
        outL[off + i] += l;
        outR[off + i] += r;
        // Post-fader send (a muted track sends nothing).
        const g = level.next();
        if (bL && bR) {
          bL[i] += l * g;
          bR[i] += r * g;
        }
      }
    }
    // Each send bus runs its six effects back into the mix.
    for (let k = 0; k < NUM_SENDS; k++) this.sends[k].process(this.busL[k], this.busR[k], outL, outR, off, n);
  }

  private finishBlock(outL: Float32Array, outR: Float32Array, frames: number): void {
    this.tape.process(outL, outR, frames);
    let pL = this.peakL;
    let pR = this.peakR;
    for (let i = 0; i < frames; i++) {
      const g = this.master.next();
      // Pan law gives -3 dB at centre; compensate, then safety soft-clip
      // (a real limiter arrives with the mixer milestone).
      const l = Math.tanh(outL[i] * g * Math.SQRT2);
      const r = Math.tanh(outR[i] * g * Math.SQRT2);
      outL[i] = l;
      outR[i] = r;
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
    inst.setParam(id, value);
  }

  private writeStep(ch: number, pattern: number, index: number, step: Step): void {
    const s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
    this.stepActive[s] = step.active ? 1 : 0;
    this.stepNote[s] = step.note;
    this.stepVel[s] = step.velocity;
    this.stepAccent[s] = step.accent ? 1 : 0;
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
    if (id === 'cutoff') { this.cutoff[ch].setTarget(value); return; }
    if (id === 'volume') this.volumeValue[ch] = value;
    else if (id === 'pan') this.pan[ch].setTarget(value);
    else this.muted[ch] = value > 0 ? 1 : 0;
    this.volume[ch].setTarget(this.muted[ch] ? 0 : this.volumeValue[ch]);
  }
}
