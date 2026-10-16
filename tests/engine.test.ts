import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/Engine';
import { toNorm, toValue, type ParamSpec } from '../src/engine/params';
import { TEST_TONE_PARAMS } from '../src/instruments/TestTone';

const SR = 48000;
const BLOCK = 128;

/** Render `seconds` of audio in worklet-sized blocks, like the real host. */
function render(engine: Engine, seconds: number): { l: Float32Array; r: Float32Array } {
  const total = Math.floor(seconds * SR / BLOCK) * BLOCK;
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  for (let off = 0; off < total; off += BLOCK) {
    engine.process(l.subarray(off, off + BLOCK), r.subarray(off, off + BLOCK), BLOCK);
  }
  return { l, r };
}

function stats(buf: Float32Array, from = 0) {
  let peak = 0;
  let nan = false;
  let crossings = 0;
  for (let i = from; i < buf.length; i++) {
    const v = buf[i];
    if (!Number.isFinite(v)) nan = true;
    peak = Math.max(peak, Math.abs(v));
    if (i > from && buf[i - 1] < 0 && v >= 0) crossings++;
  }
  return { peak, nan, crossings };
}

describe('params', () => {
  it('round-trips normalised values on linear and exp curves', () => {
    for (const spec of TEST_TONE_PARAMS) {
      for (const n of [0, 0.25, 0.5, 1]) {
        expect(toNorm(spec, toValue(spec, n))).toBeCloseTo(n, 9);
      }
    }
  });

  it('clamps out-of-range input', () => {
    const spec: ParamSpec = { id: 'x', name: 'X', min: 1, max: 10, defaultValue: 1, unit: '', curve: 'linear' };
    expect(toValue(spec, 2)).toBe(10);
    expect(toNorm(spec, -5)).toBe(0);
  });
});

describe('engine test tone', () => {
  it('is silent until started', () => {
    const { l } = render(new Engine(SR), 0.2);
    expect(stats(l).peak).toBe(0);
  });

  it('plays a drone at the requested frequency without NaNs or clipping', () => {
    const e = new Engine(SR);
    e.handleMessage({ type: 'setParam', id: 'tone.freq', value: 440 });
    e.handleMessage({ type: 'transport', playing: true });
    const { l, r } = render(e, 1.1);
    // Skip the first 0.1 s while smoothers settle; one second remains.
    const s = stats(l, Math.floor(0.1 * SR));
    expect(s.nan).toBe(false);
    expect(s.peak).toBeGreaterThan(0.1);
    expect(s.peak).toBeLessThan(1);
    expect(Math.abs(s.crossings - 440)).toBeLessThanOrEqual(2);
    expect(r).toEqual(l);
  });

  it('a trigger produces a decaying blip', () => {
    const e = new Engine(SR);
    e.handleMessage({ type: 'setParam', id: 'tone.decay', value: 0.1 });
    e.handleMessage({ type: 'trigger', note: 60, velocity: 1 });
    const early = stats(render(e, 0.02).l).peak;
    render(e, 0.2);
    const late = stats(render(e, 0.05).l).peak;
    expect(early).toBeGreaterThan(0.1);
    expect(late).toBeLessThan(0.001);
  });

  it('stays bounded at extreme settings', () => {
    const e = new Engine(SR);
    e.handleMessage({ type: 'setParam', id: 'tone.drive', value: 20 });
    e.handleMessage({ type: 'setParam', id: 'tone.level', value: 1 });
    e.handleMessage({ type: 'setParam', id: 'master.volume', value: 1 });
    e.handleMessage({ type: 'transport', playing: true });
    e.handleMessage({ type: 'trigger', note: 60, velocity: 1 });
    const s = stats(render(e, 0.5).l);
    expect(s.nan).toBe(false);
    expect(s.peak).toBeLessThanOrEqual(1);
  });

  it('reports peaks and advances the frame counter', () => {
    const e = new Engine(SR);
    e.handleMessage({ type: 'transport', playing: true });
    render(e, 0.1);
    expect(e.peakL).toBeGreaterThan(0);
    expect(e.frame).toBe(Math.floor(0.1 * SR / BLOCK) * BLOCK);
  });
});
