/**
 * The maths A / B benchmark (a Web Worker: the same JavaScript engine and CPU as the audio
 * thread, with a precise clock): renders a project offline through the exact engine (A) and
 * the fast one (B) in turn, 2 s of audio each, best of three rounds after a warm-up, and
 * reports each as a share of real time (one core).
 */
import { Engine } from '../../src/engine/Engine';
import { Engine as FastEngine } from './fastEngine';
import type { Project } from '../../src/engine/project';

const SR = 48000;
const BLOCK = 128;

function time(engine: Engine, seconds: number): number {
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  const blocks = Math.round((seconds * SR) / BLOCK);
  const t = performance.now();
  for (let i = 0; i < blocks; i++) { l.fill(0); r.fill(0); engine.process(l, r, BLOCK); }
  return (performance.now() - t) / (seconds * 1000);
}

self.onmessage = (e: MessageEvent<Project>) => {
  const start = (E: typeof Engine) => {
    const engine = new E(SR);
    engine.handleMessage({ type: 'loadProject', project: e.data });
    engine.handleMessage({ type: 'transport', playing: true });
    return engine;
  };
  const a = start(Engine), b = start(FastEngine);
  time(a, 2); time(b, 2); // warm-up (the JIT)
  let bestA = Infinity, bestB = Infinity;
  for (let round = 0; round < 3; round++) {
    bestA = Math.min(bestA, time(a, 2));
    bestB = Math.min(bestB, time(b, 2));
  }
  self.postMessage({ a: bestA, b: bestB });
};
