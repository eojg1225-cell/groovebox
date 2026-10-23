/**
 * Loudness of one sound, rendered offline on the real engine: one default hit (synths: a
 * half-second note), BS.1770 K-weighted, the loudest 400 ms (momentary loudness, dB). The
 * same measure as the app's "every TIMBRE sound is equally loud" test.
 */
import { Engine } from '../../src/engine/Engine';
import { createDefaultProject } from '../../src/engine/defaultProject';
import { emptyPattern, type SoundKind } from '../../src/engine/project';
import { INSTRUMENTS } from '../../src/instruments/registry';

const SR = 48000;
const BLOCK = 128;

function biquad(c: readonly number[], x: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const SHELF = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
const HIGHPASS = [1, -2, 1, -1.99004745483398, 0.99007225036621];
const kWeight = (x: Float32Array) => biquad(HIGHPASS, biquad(SHELF, x));

export function loudness(kind: SoundKind, sound: Record<string, number>): number {
  const p = createDefaultProject();
  p.bpm = 120;
  p.master = 0.2; // under the limiter
  const ch = p.channels.findIndex((c) => c.instrument === kind);
  p.channels.forEach((c, n) => { c.patterns = c.patterns.map(() => emptyPattern(c.patterns[0].steps[0].note)); c.mute = n !== ch; });
  p.channels[ch].sounds[kind] = { ...sound };
  const pat = p.channels[ch].patterns[0];
  pat.length = 64;
  Object.assign(pat.steps[0], { active: true, gate: INSTRUMENTS[kind].drum ? 1 : 4 });
  const e = new Engine(SR);
  e.handleMessage({ type: 'loadProject', project: p });
  e.handleMessage({ type: 'transport', playing: true });
  const total = Math.floor((1.5 * SR) / BLOCK) * BLOCK;
  const l = new Float32Array(total), r = new Float32Array(total);
  for (let i = 0; i < total; i += BLOCK) e.process(l.subarray(i, i + BLOCK), r.subarray(i, i + BLOCK), BLOCK);
  const wl = kWeight(l), wr = kWeight(r), win = SR * 0.4;
  let sum = 0, best = 0;
  for (let n = 0; n < total; n++) {
    sum += wl[n] ** 2 + wr[n] ** 2;
    if (n >= win) sum -= wl[n - win] ** 2 + wr[n - win] ** 2;
    best = Math.max(best, sum);
  }
  return 10 * Math.log10(best / win + 1e-12);
}
