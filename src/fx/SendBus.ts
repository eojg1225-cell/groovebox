import { Delay } from './Delay';
import { Distortion } from './Distortion';
import { MidCut } from './MidCut';
import { Chorus } from './Chorus';
import { Reverb } from './Reverb';
import { Compressor } from './Compressor';
import { EFFECTS } from './index';

/** Delay division (index into DELAY_DIVISIONS) per send: 3/16, 1/4, 1/8. */
const SEND_DELAY_DIVISION = [2, 3, 1];

/**
 * One send: a bus feeding six effects in parallel. Each effect has two controls:
 *  WET        how much of its output returns to the mix (0 = off)
 *  INTENSITY  how hard it works: DELAY feedback, DISTORT drive, MID CUT depth,
 *             CHORUS depth, REVERB size, COMP squash (threshold + ratio)
 */
export class SendBus {
  private readonly delay: Delay;
  private readonly dist: Distortion;
  private readonly mid: MidCut;
  private readonly chorus: Chorus;
  private readonly reverb: Reverb;
  private readonly comp: Compressor;

  constructor(sampleRate: number, index: number) {
    this.delay = new Delay(sampleRate);
    this.dist = new Distortion(sampleRate);
    this.mid = new MidCut(sampleRate);
    this.chorus = new Chorus(sampleRate);
    this.reverb = new Reverb(sampleRate);
    this.comp = new Compressor(sampleRate);
    this.delay.setParam('dly_time', SEND_DELAY_DIVISION[index] ?? 2);
    this.mid.setParam('mid_freq', 1000);
    this.mid.setParam('mid_width', 0.9);
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

  /** Return volume of effect k (EFFECTS order), 0..1. */
  setWet(k: number, a: number): void {
    switch (EFFECTS[k].id) {
      case 'delay': this.delay.setParam('dly_return', a); break;
      case 'dist': this.dist.setParam('dst_return', a * 0.8); break;
      case 'midcut': this.mid.setParam('mid_return', a); break;
      case 'chorus': this.chorus.setParam('cho_return', a); break;
      case 'reverb': this.reverb.setParam('rev_return', a); break;
      case 'comp': this.comp.setParam('cmp_return', a); break;
    }
  }

  /** How hard effect k works, 0..1. */
  setIntensity(k: number, a: number): void {
    switch (EFFECTS[k].id) {
      case 'delay': this.delay.setParam('dly_fdbk', 0.1 + 0.95 * a); break; // up to dub runaway
      case 'dist': this.dist.setParam('dst_drive', 1 + 40 * a * a); break;
      case 'midcut': this.mid.setParam('mid_depth', 30 * a); break;
      case 'chorus':
        this.chorus.setParam('cho_depth', a);
        this.chorus.setParam('cho_rate', 0.2 + 1.8 * a);
        break;
      case 'reverb':
        this.reverb.setParam('rev_size', 0.5 + 0.48 * a);
        this.reverb.setParam('rev_damp', 0.7 - 0.5 * a);
        break;
      case 'comp':
        this.comp.setParam('cmp_threshold', -6 - 36 * a);
        this.comp.setParam('cmp_ratio', 2 + 14 * a);
        break;
    }
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    this.delay.process(inL, inR, outL, outR, off, n);
    this.dist.process(inL, inR, outL, outR, off, n);
    this.mid.process(inL, inR, outL, outR, off, n);
    this.chorus.process(inL, inR, outL, outR, off, n);
    this.reverb.process(inL, inR, outL, outR, off, n);
    this.comp.process(inL, inR, outL, outR, off, n);
  }
}
