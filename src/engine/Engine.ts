import type { MainToWorklet } from './protocol';
import { Smoother } from './smoother';
import {
  MAX_STEPS, NUM_CHANNELS, NUM_PATTERNS,
  type InstrumentKind, type Project, type Step,
} from './project';
import type { Instrument } from '../instruments/Instrument';
import { INSTRUMENTS } from '../instruments/registry';

/** Largest chunk rendered at once; blocks are split at step boundaries anyway. */
const CHUNK = 256;
const KINDS = Object.keys(INSTRUMENTS) as Exclude<InstrumentKind, 'none'>[];

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

  private bpm = 128;
  private swing = 0; // 0..0.5 fraction of a step
  private readonly master: Smoother;

  // Step data: index = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + step
  private readonly stepActive = new Uint8Array(NUM_CHANNELS * NUM_PATTERNS * MAX_STEPS);
  private readonly stepNote = new Float32Array(NUM_CHANNELS * NUM_PATTERNS * MAX_STEPS);
  private readonly stepVel = new Float32Array(NUM_CHANNELS * NUM_PATTERNS * MAX_STEPS);
  private readonly patternLength = new Uint8Array(NUM_CHANNELS * NUM_PATTERNS).fill(16);

  private readonly pendingPattern = new Int8Array(NUM_CHANNELS).fill(-1);
  private readonly position = new Uint8Array(NUM_CHANNELS);
  private globalStep = 0;
  private framesToStep = 0;

  // Channels
  private readonly instruments: Record<string, Instrument>[] = [];
  private readonly current: (Instrument | null)[] = [];
  private readonly volume: Smoother[] = [];
  private readonly pan: Smoother[] = [];
  private readonly volumeValue = new Float32Array(NUM_CHANNELS).fill(0.8);
  private readonly muted = new Uint8Array(NUM_CHANNELS);
  private readonly scratchL = new Float32Array(CHUNK);
  private readonly scratchR = new Float32Array(CHUNK);

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.master = new Smoother(0.8, 0.02, sampleRate);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const set: Record<string, Instrument> = {};
      for (const kind of KINDS) set[kind] = INSTRUMENTS[kind].create(sampleRate);
      this.instruments.push(set);
      this.current.push(null);
      this.volume.push(new Smoother(0.8, 0.02, sampleRate));
      this.pan.push(new Smoother(0, 0.02, sampleRate));
    }
  }

  handleMessage(msg: MainToWorklet): void {
    switch (msg.type) {
      case 'loadProject': this.loadProject(msg.project); break;
      case 'setStep': this.writeStep(msg.channel, msg.pattern, msg.index, msg.step); break;
      case 'selectPattern':
        if (!this.playing || msg.immediate) {
          this.activePattern[msg.channel] = msg.pattern;
          this.pendingPattern[msg.channel] = -1;
        } else {
          this.pendingPattern[msg.channel] = msg.pattern;
        }
        break;
      case 'setSound': this.current[msg.channel]?.setParam(msg.id, msg.value); break;
      case 'setMix': this.setMix(msg.channel, msg.id, msg.value); break;
      case 'setGlobal':
        if (msg.id === 'bpm') this.bpm = msg.value;
        else if (msg.id === 'swing') this.swing = (msg.value - 50) / 50;
        else if (msg.id === 'master') this.master.setTarget(msg.value);
        break;
      case 'transport': this.setPlaying(msg.playing); break;
      case 'trigger': this.current[msg.channel]?.noteOn(msg.note, msg.velocity); break;
      case 'ping': break; // answered by the host
    }
  }

  loadProject(p: Project): void {
    this.bpm = p.bpm;
    this.swing = (p.swing - 50) / 50;
    this.master.setImmediate(p.master);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const c = p.channels[ch];
      this.current[ch] = c.instrument === 'none' ? null : this.instruments[ch][c.instrument];
      const inst = this.current[ch];
      if (inst) {
        for (const spec of inst.params) inst.setParam(spec.id, c.sound[spec.id] ?? spec.defaultValue);
      }
      this.setMix(ch, 'volume', c.volume);
      this.setMix(ch, 'mute', c.mute ? 1 : 0);
      this.setMix(ch, 'pan', c.pan);
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
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      if (this.pendingPattern[ch] >= 0) {
        this.activePattern[ch] = this.pendingPattern[ch];
        this.pendingPattern[ch] = -1;
      }
      if (!playing) this.current[ch]?.noteOff();
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
      if (this.stepActive[s]) inst.noteOn(this.stepNote[s], this.stepVel[s]);
      this.currentStep[ch] = idx;
      this.position[ch] = (idx + 1) % len;
    }
    this.framesToStep += this.stepFrames(this.globalStep);
    this.globalStep++;
  }

  private renderChunk(outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    const sl = this.scratchL;
    const sr = this.scratchR;
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const inst = this.current[ch];
      if (!inst) continue;
      sl.fill(0, 0, n);
      sr.fill(0, 0, n);
      inst.render(sl, sr, 0, n);
      const vol = this.volume[ch];
      const pan = this.pan[ch];
      for (let i = 0; i < n; i++) {
        const v = vol.next();
        // Equal-power pan, -1..1 -> 0..pi/2
        const a = (pan.next() + 1) * 0.25 * Math.PI;
        outL[off + i] += sl[i] * v * Math.cos(a);
        outR[off + i] += sr[i] * v * Math.sin(a);
      }
    }
  }

  private finishBlock(outL: Float32Array, outR: Float32Array, frames: number): void {
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

  private writeStep(ch: number, pattern: number, index: number, step: Step): void {
    const s = (ch * NUM_PATTERNS + pattern) * MAX_STEPS + index;
    this.stepActive[s] = step.active ? 1 : 0;
    this.stepNote[s] = step.note;
    this.stepVel[s] = step.velocity;
  }

  private setMix(ch: number, id: 'volume' | 'pan' | 'mute', value: number): void {
    if (id === 'volume') this.volumeValue[ch] = value;
    else if (id === 'pan') this.pan[ch].setTarget(value);
    else this.muted[ch] = value > 0 ? 1 : 0;
    this.volume[ch].setTarget(this.muted[ch] ? 0 : this.volumeValue[ch]);
  }
}
