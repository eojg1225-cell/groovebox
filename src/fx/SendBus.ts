import { Delay } from './Delay';
import { Distortion } from './Distortion';
import { Chorus } from './Chorus';
import { Reverb } from './Reverb';
import { Compressor } from './Compressor';
import { EFFECTS } from './index';
import type { Effect } from './Effect';

/** Largest block the engine hands a send (it renders in 64-frame chunks). */
const MAX_BLOCK = 256;

/** An effect turned to 0 keeps running this long (its return fades out), then is skipped. */
const FADE_SECONDS = 0.15;
/**
 * A bus with no input and nothing coming out for this long is skipped altogether (longer
 * than the longest delay, so no echo is still on its way).
 */
const QUIET_SECONDS = 5;
const QUIET_LEVEL = 1e-6;

/** Delay division (index into DELAY_DIVISIONS) per bus: FX 2 3/16 (dub), FX 3 1/4. */
const SEND_DELAY_DIVISION = [2, 2, 3];

/**
 * One send: a bus feeding four effects in parallel, their returns summed and then held
 * level by the bus COMPRESSOR (series: THRESH / RATIO / ATTACK / RELEASE) before the mix.
 * Each effect has two controls:
 *  WET        how much of its output returns to the mix (0 = off)
 *  INTENSITY  how hard it works: DELAY feedback, DISTORT drive, CHORUS depth, REVERB size
 */
export class SendBus {
  private readonly delay: Delay;
  private readonly dist: Distortion;
  private readonly chorus: Chorus;
  private readonly reverb: Reverb;
  /** The bus compressor on the summed returns. */
  readonly comp: Compressor;
  private readonly retL = new Float32Array(MAX_BLOCK);
  private readonly retR = new Float32Array(MAX_BLOCK);
  /** Effects in EFFECTS order, each running (1) or skipped (0), and frames left of a fade to 0. */
  private readonly effects: Effect[];
  private readonly running = new Uint8Array(EFFECTS.length);
  private readonly fadeLeft = new Float64Array(EFFECTS.length);
  private readonly fadeFrames: number;
  private readonly quietFrames: number;
  private quiet = 0;

  constructor(sampleRate: number, index: number) {
    this.delay = new Delay(sampleRate);
    this.dist = new Distortion(sampleRate);
    this.chorus = new Chorus(sampleRate);
    this.reverb = new Reverb(sampleRate);
    this.comp = new Compressor(sampleRate);
    this.effects = EFFECTS.map((e) => ({ delay: this.delay, dist: this.dist, chorus: this.chorus, reverb: this.reverb })[e.id]);
    this.fadeFrames = FADE_SECONDS * sampleRate;
    this.quietFrames = QUIET_SECONDS * sampleRate;
    this.delay.setParam('dly_time', SEND_DELAY_DIVISION[index] ?? 2);
    for (let k = 0; k < EFFECTS.length; k++) {
      this.setWet(k, 0);
      this.setIntensity(k, 0.5);
    }
  }

  setTempo(bpm: number): void {
    this.delay.setTempo(bpm);
  }

  settle(): void {
    this.delay.settle();
  }

  /** Return volume of effect k (EFFECTS order), 0..1. Turned to 0 it fades, then is skipped. */
  setWet(k: number, a: number): void {
    if (a > 0) {
      if (!this.running[k]) this.effects[k].reset();
      this.running[k] = 1;
      this.fadeLeft[k] = 0;
    } else if (this.running[k]) {
      this.fadeLeft[k] = this.fadeFrames;
    }
    switch (EFFECTS[k].id) {
      case 'delay': this.delay.setParam('dly_return', a); break;
      case 'dist': this.dist.setParam('dst_return', a * 0.8); break;
      case 'chorus': this.chorus.setParam('cho_return', a); break;
      case 'reverb': this.reverb.setParam('rev_return', a); break;
    }
  }

  /** How hard effect k works, 0..1. */
  setIntensity(k: number, a: number): void {
    switch (EFFECTS[k].id) {
      case 'delay': this.delay.setParam('dly_fdbk', 0.1 + 0.95 * a); break; // up to dub runaway
      case 'dist': this.dist.setParam('dst_drive', 1 + 150 * a * a); break;
      case 'chorus':
        this.chorus.setParam('cho_depth', a);
        this.chorus.setParam('cho_rate', 0.2 + 1.8 * a);
        break;
      case 'reverb':
        this.reverb.setParam('rev_size', 0.5 + 0.48 * a);
        this.reverb.setParam('rev_damp', 0.7 - 0.5 * a);
        break;
    }
  }

  /** Reads the bus input and ADDS the (compressed) returns into out[off, off + n). */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    const l = this.retL;
    const r = this.retR;
    l.fill(0, 0, n);
    r.fill(0, 0, n);
    // Nothing in and nothing out for a while (no track sends here): skip the whole bus.
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(inL[i]) + Math.abs(inR[i]);
      if (a > peak) peak = a;
    }
    if (peak > QUIET_LEVEL) this.quiet = 0;
    else if (this.quiet >= this.quietFrames) return;
    for (let k = 0; k < EFFECTS.length; k++) {
      if (!this.running[k]) continue;
      this.effects[k].process(inL, inR, l, r, 0, n);
      if (this.fadeLeft[k] > 0 && (this.fadeLeft[k] -= n) <= 0) this.running[k] = 0;
    }
    this.comp.process(l, r, 0, n);
    let out = 0;
    for (let i = 0; i < n; i++) {
      outL[off + i] += l[i];
      outR[off + i] += r[i];
      const a = Math.abs(l[i]) + Math.abs(r[i]);
      if (a > out) out = a;
    }
    if (peak <= QUIET_LEVEL && out <= QUIET_LEVEL) this.quiet += n;
    else this.quiet = 0;
  }
}
