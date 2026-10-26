import { sinTurn } from './math';

/** How long the click rings (s, to 1/e). */
const CLICK_DECAY = 0.012;

/**
 * METRONOME / COUNT-IN click: a short sine blip, higher and louder on a bar's first beat.
 * render() adds into one buffer (the engine mixes it into both sides, past MASTER).
 */
export class Click {
  private phase = 0;
  private inc = 0;
  private env = 0;
  private readonly decay: number;

  constructor(private readonly sampleRate: number) {
    this.decay = Math.exp(-1 / (CLICK_DECAY * sampleRate));
  }

  trigger(accent: boolean): void {
    this.inc = (accent ? 1600 : 1000) / this.sampleRate;
    this.phase = 0;
    this.env = accent ? 1 : 0.6;
  }

  /** ADD frames [start, start + n) into out; false = silent (nothing written). */
  render(out: Float32Array, start: number, n: number): boolean {
    if (this.env < 1e-4) return false;
    let phase = this.phase;
    let env = this.env;
    for (let i = start; i < start + n; i++) {
      out[i] += sinTurn(phase) * env;
      phase += this.inc;
      if (phase >= 1) phase -= 1;
      env *= this.decay;
    }
    this.phase = phase;
    this.env = env;
    return true;
  }
}
