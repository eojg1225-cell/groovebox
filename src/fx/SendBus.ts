import { Delay } from './Delay';
import { Distortion } from './Distortion';
import { MidCut } from './MidCut';
import { Chorus } from './Chorus';
import { Reverb } from './Reverb';
import { Compressor } from './Compressor';
import { EFFECTS } from './index';

const CHUNK = 256;

/** Delay division (index into DELAY_DIVISIONS) per send: 3/16, 1/4, 1/8. */
const SEND_DELAY_DIVISION = [2, 3, 1];

/**
 * One send: a bus carrying the six effects, each driven by a single AMOUNT knob (0 = off).
 * MID CUT is an insert on the bus (it carves the signal feeding the other effects);
 * the rest run in parallel and each adds its output to the mix by its amount.
 * Each amount also scales the effect's character (more delay = more feedback, etc).
 */
export class SendBus {
  private readonly delay: Delay;
  private readonly dist: Distortion;
  private readonly mid: MidCut;
  private readonly chorus: Chorus;
  private readonly reverb: Reverb;
  private readonly comp: Compressor;
  private readonly midL = new Float32Array(CHUNK);
  private readonly midR = new Float32Array(CHUNK);
  private midAmount = 0;

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
    this.mid.setParam('mid_return', 1);
    for (let k = 0; k < EFFECTS.length; k++) this.setAmount(k, 0);
  }

  setTempo(bpm: number): void {
    this.delay.setTempo(bpm);
  }

  settle(): void {
    this.delay.settle();
  }

  /** Effect k (order of EFFECTS) to amount 0..1. */
  setAmount(k: number, a: number): void {
    switch (EFFECTS[k].id) {
      case 'delay':
        this.delay.setParam('dly_return', a);
        this.delay.setParam('dly_fdbk', 0.25 + 0.6 * a);
        break;
      case 'dist':
        this.dist.setParam('dst_return', a * 0.8);
        this.dist.setParam('dst_drive', 2 + 30 * a);
        break;
      case 'midcut':
        this.midAmount = a;
        this.mid.setParam('mid_depth', a * 24);
        break;
      case 'chorus':
        this.chorus.setParam('cho_return', a);
        this.chorus.setParam('cho_depth', 0.4 + 0.5 * a);
        break;
      case 'reverb':
        this.reverb.setParam('rev_return', a);
        this.reverb.setParam('rev_size', 0.55 + 0.4 * a);
        break;
      case 'comp':
        this.comp.setParam('cmp_return', a);
        break;
    }
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, off: number, n: number): void {
    // Mid-cut insert: the cut signal feeds the other effects.
    let srcL = inL;
    let srcR = inR;
    if (this.midAmount > 0) {
      this.midL.fill(0, 0, n);
      this.midR.fill(0, 0, n);
      this.mid.process(inL, inR, this.midL, this.midR, 0, n);
      srcL = this.midL;
      srcR = this.midR;
    }
    this.dist.process(srcL, srcR, outL, outR, off, n);
    this.chorus.process(srcL, srcR, outL, outR, off, n);
    this.delay.process(srcL, srcR, outL, outR, off, n);
    this.reverb.process(srcL, srcR, outL, outR, off, n);
    this.comp.process(srcL, srcR, outL, outR, off, n);
  }
}
