/**
 * Reference outputs of the engine's building blocks, for the native engine's null tests
 * (native/tests/blocks.rs reads native/tests/vectors/blocks.json and expects the same
 * numbers from its Rust port). This test fails if the file no longer matches the
 * TypeScript code: rewrite it with `UPDATE_VECTORS=1 npx vitest run tests/nativeVectors.test.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exp2, pow10, sinTurn, tanh } from '../src/instruments/math';
import { IdleGate, Noise, Svf, crushLevels, crushStep, decayMul, midiToHz, polyBlep } from '../src/instruments/dsp';
import { Smoother } from '../src/engine/smoother';
import { DRIVE_RISE, driveCompGain } from '../src/instruments/driveComp';

const FILE = 'native/tests/vectors/blocks.json';
const SR = 48000;

const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

function vectors() {
  // Inputs over the ranges used, plus the edges the tables guard.
  const turns = [...range(400, (i) => i / 97 - 2.1), -1e-17, 1 - 1e-17, 0, 0.25, 0.5, 1e6 + 0.3];
  const tanhIn = [...range(400, (i) => (i - 200) / 17), 9.999, 10, 10.5, -10, 1e-9, -1e-9];
  const expIn = [...range(400, (i) => (i - 200) / 7.3), -1e-17, 3 - 1e-15, -1022.5, -1023, 1023.9, 1024];
  const pow10In = range(200, (i) => (i - 100) / 25);

  const noise = (seed?: number) => { const n = new Noise(seed); return range(2000, () => n.next()); };

  // The filter on noise, with its settings changed partway as the engine does.
  const svfCase = (settings: [number, number][]) => {
    const f = new Svf();
    const src = new Noise(12345);
    const low: number[] = [], band: number[] = [], high: number[] = [];
    settings.forEach(([cutoff, reso]) => {
      f.setup(cutoff, reso, SR);
      for (let i = 0; i < 500; i++) {
        f.process(src.next());
        low.push(f.low); band.push(f.band); high.push(f.high);
      }
    });
    return { settings, low, band, high };
  };

  const smootherCase = () => {
    const s = new Smoother(0.2, 0.01, SR);
    const out: number[] = [];
    s.setTarget(0.9);
    for (let i = 0; i < 300; i++) out.push(s.next());
    s.advance(700);
    out.push(s.value);
    s.setTarget(-0.5);
    for (let i = 0; i < 300; i++) out.push(s.next());
    s.setTime(0, SR);
    s.setTarget(0.1);
    out.push(s.next());
    return out;
  };

  // IdleGate over blocks of sound then silence (the tail dying out).
  const gateCase = () => {
    const g = new IdleGate(0.01, SR);
    const n = 128;
    const l = new Float32Array(n), r = new Float32Array(n);
    const skips: boolean[] = [];
    for (let b = 0; b < 12; b++) {
      for (let i = 0; i < n; i++) {
        l[i] = b < 2 ? 0.5 : 0;
        r[i] = b === 4 && i === 7 ? 1e-5 : 0; // a late echo coming out
      }
      skips.push(g.skip(l, r, n));
      g.done(l, r, n);
    }
    return skips;
  };

  const drives = [0.5, 1, 1.2, 1.5, 2.7, 4, 9, 33, 100, 150, 200, 500];
  return {
    sinTurn: { input: turns, output: turns.map(sinTurn) },
    tanh: { input: tanhIn, output: tanhIn.map(tanh) },
    exp2: { input: expIn, output: expIn.map(exp2) },
    pow10: { input: pow10In, output: pow10In.map(pow10) },
    decayMul: [0, 1e-5, 0.003, 0.1, 1, 4.7].map((s) => [s, decayMul(s, SR)]),
    noiseDefault: noise(),
    noiseSeeded: noise(777),
    noiseZero: noise(0),
    svf: [
      svfCase([[1000, 0]]),
      svfCase([[200, 0.5], [8000, 0.9], [30000, 0.99]]),
      svfCase([[60, 0.98], [60, 0.2]]),
    ],
    polyBlep: range(101, (i) => i / 100).map((t) => [t, 0.03, polyBlep(t, 0.03)]),
    midiToHz: range(128, (n) => midiToHz(n)),
    crush: range(21, (i) => i / 20).map((k) => [k, crushStep(k), crushLevels(k)]),
    smoother: smootherCase(),
    idleGate: gateCase(),
    driveComp: Object.fromEntries(Object.entries(DRIVE_RISE).map(([k, rise]) => [k, drives.map((d) => [d, driveCompGain(rise, d)])])),
  };
}

describe('native engine reference vectors', () => {
  it(`${FILE} matches the TypeScript building blocks`, () => {
    const text = JSON.stringify(vectors());
    if (process.env.UPDATE_VECTORS) writeFileSync(FILE, text + '\n');
    expect(readFileSync(FILE, 'utf8').trim()).toBe(text);
  });
});
