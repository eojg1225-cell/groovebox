/**
 * Loudness of one sound, rendered offline on the real engine: one default hit (synths: a
 * half-second note), BS.1770 K-weighted, then GATED: the mean over the samples whose 10 ms
 * loudness is within GATE_DB of the loudest moment (dB), so a sound's own tail and the silence after it don't
 * count. A short hat and a long kick are compared on how loud they are while they sound.
 * The same measure as the app's "every TIMBRE sound is equally loud" test.
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
  return gatedLoudness(l, r);
}

/** Samples whose 10 ms loudness is within this many dB of the loudest moment count. */
const GATE_DB = -20;
const WINDOW = SR / 100;

/**
 * Gated loudness of a stereo render (48 kHz), dB: the K-weighted power averaged over the
 * samples where the sound's 10 ms loudness (a sliding window centred on the sample) passes the
 * gate. Gated sample by sample, a decaying tail crossing the gate changes the result smoothly
 * (whole 10 ms slices made a short hat jump by ~1 dB per slice).
 */
export function gatedLoudness(l: Float32Array, r: Float32Array): number {
  const wl = kWeight(l), wr = kWeight(r), n = wl.length, half = WINDOW >> 1;
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) p[i] = wl[i] ** 2 + wr[i] ** 2;
  // 10 ms envelope by prefix sums.
  const sum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + p[i];
  const env = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n, i + half);
    env[i] = (sum[b] - sum[a]) / (b - a);
    if (env[i] > peak) peak = env[i];
  }
  const gate = peak * Math.pow(10, GATE_DB / 10);
  let total = 0, count = 0;
  for (let i = 0; i < n; i++) if (env[i] >= gate) { total += p[i]; count++; }
  return 10 * Math.log10(total / count + 1e-12);
}
