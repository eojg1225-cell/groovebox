/**
 * The engine's golden test: the lab's saved projects played through the Rust engine (native/,
 * the one the app and the web build both play), driven by the protocol's messages (load,
 * transport, pattern switches, knob moves, live playing and recording, a song with clip entries
 * and automation, a count-in), in both of its builds: the native one (native/examples/engine.rs,
 * as the Android app runs it) and the WebAssembly one (as the web build's worklet runs it).
 *  - The two builds play the same thing, sample by sample (under -100 dB: the maths library may
 *    round a last bit differently) and record the same notes.
 *  - What they play matches the fingerprint saved in golden.json: per scenario and 100 ms, the
 *    level of each side and of its first difference (its brightness), and what recording wrote.
 *    A sound change shows here: when it is meant, rewrite the file with
 *    `UPDATE_GOLDEN=1 npm run engine:golden` and commit it with the change.
 * Run: `npm run engine:golden` (builds both with cargo).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MainToWorklet, WorkletToMain } from '../../src/engine/protocol';
import type { Project } from '../../src/engine/project';
import { fromStored } from '../../src/engine/projectFile';
import stored from '../lab/project.json';
import stored3 from '../lab/project3.json';
import stored4 from '../lab/project4.json';
import stored8 from '../lab/project8.json';

const SR = 48000;
const BLOCK = 128;
const LIMIT_DB = -100;

type Timed = [number, MainToWorklet];
interface Scenario { name: string; sampleRate: number; frames: number; block: number; msgs: Timed[]; quiet?: boolean }

const at = (s: number) => Math.round(s * SR);

/** What the App sends when a project opens (App.syncMessages), then PLAY. */
function opening(p: Project, play: Partial<Extract<MainToWorklet, { type: 'transport' }>> = {}): Timed[] {
  return [
    [0, { type: 'loadProject', project: p }],
    [0, { type: 'setListenLatency', ms: 15 }],
    [0, { type: 'setChain', orders: p.channels.map(() => -1) }],
    [0, { type: 'setGlideCurve', curve: 0 }],
    [0, { type: 'setAutoFill', steps: 4, tracks: p.channels.map((c) => ['kick', 'snare', 'hat', 'perc'].includes(c.instrument)) }],
    [at(0.05), { type: 'transport', playing: true, gen: 1, ...play }],
  ];
}

/** A song over the project's patterns: rows, a kept clip, clip entries (glides, a fill), automation. */
function song(): Project['song'] {
  const all = (p: number) => Array.from({ length: 8 }, () => p);
  return {
    rows: [
      { bars: 2, patterns: all(0) },
      { bars: 2, patterns: [1, 1, 0, 1, 1, 1, -1, 1], keep: [0, 0, 1, 0, 0, 0, 0, 0], entry: [{ glideStart: -8, glideEnd: 4, fill: 2, fillLen: 4 }, null, null, { fill: 3, fillLen: 8 }, { glideStart: 2, glideEnd: 12 }] },
      { bars: 1, patterns: [2, -1, 2, 2, 0, 2, 2, 2], entry: [null, null, { glideStart: -16, glideEnd: 0 }] },
      { bars: 2, patterns: [3, 3, 3, -1, 3, 3, 3, 3], entry: [null, { fill: 0, fillLen: 2 }] },
    ],
    auto: {
      'm:0:volume': [[0, 0.8], [40, 0.3], [64, 0.9]],
      's:4:cutoff': [[8, 300], [56, 4000]],
      's:5:timbre': [[16, 0.1], [48, 0.9]],
      'b:1:dly_vol': [[0, 0], [32, 0.7]],
      'l:vol': [[24, 0], [72, 0.6]],
      'o:0:macro:decay': [[12, -0.5], [60, 0.8]],
      'a:6:mode': [[32, 1], [80, 3]],
    },
  };
}

function scenarios(): Scenario[] {
  const saves: [string, unknown][] = [['current', stored], ['p3', stored3], ['p4', stored4], ['p8', stored8]];
  const out: Scenario[] = [];
  let quiet = false;
  const push = (name: string, secs: number, msgs: Timed[]) =>
    out.push({ name, sampleRate: SR, frames: Math.ceil((secs * SR) / BLOCK) * BLOCK, block: BLOCK, msgs: msgs.sort((a, b) => a[0] - b[0]), quiet });
  for (const [name, save] of saves) {
    const p = fromStored((save as { project: unknown }).project)!;
    // A project with no notes (the app's working copy may be blank) only sounds where notes are played live.
    quiet = !p.channels.some((c) => c.patterns.some((pt) => pt.steps.some((st) => st.active)));
    push(`${name} play`, 6, opening(p));
    push(`${name} switches + AUTO-FILL`, 8, [
      ...opening(p),
      [at(1.5), { type: 'switchPatterns', channels: [0, 1, 2, 3, 4, 5, 6, 7], pattern: 1, quick: false }],
      [at(3.2), { type: 'selectPattern', channel: 4, pattern: 2, immediate: true }],
      [at(4.1), { type: 'selectPattern', channel: 0, pattern: 3, immediate: false }],
      [at(4.6), { type: 'selectPattern', channel: 0, pattern: 1, immediate: false }],
      [at(5.0), { type: 'switchPatterns', channels: [0, 1, 2, 3, 4, 5, 6, 7], pattern: 0, quick: true }],
      [at(6.0), { type: 'setPatch', channel: 5, pattern: 0, sound: { ...p.channels[5].sounds.pad, cutoff: 600 }, glide: true }],
    ]);
    const lockStep = { ...p.channels[4].patterns[0].steps[2], locks: { cutoff: 250, drive: 0.6 } };
    const lockStep2 = { ...p.channels[4].patterns[0].steps[10], locks: { cutoff: 5000 } };
    quiet = false;
    push(`${name} knobs, LFO, live playing + recording`, 9, [
      ...opening(p),
      [at(0.6), { type: 'setStep', channel: 4, pattern: 0, index: 2, step: lockStep }],
      [at(0.6), { type: 'setStep', channel: 4, pattern: 0, index: 10, step: lockStep2 }],
      [at(0.8), { type: 'setSound', channel: 4, id: 'cutoff', value: 900 }],
      [at(1.0), { type: 'setOffset', channel: 0, id: 'macro:decay', value: 0.6 }],
      [at(1.1), { type: 'setOffset', channel: 2, id: 'macro:grit', value: 0.9 }],
      [at(1.2), { type: 'setMix', channel: 1, id: 'pan', value: -0.6 }],
      [at(1.3), { type: 'setMix', channel: 6, id: 'send', value: 0.9 }],
      [at(1.4), { type: 'setMix', channel: 3, id: 'cut', value: 0.7 }],
      [at(1.5), { type: 'setLfoTrack', channel: 5, on: true }],
      [at(1.5), { type: 'setLfoTrack', channel: 4, on: true }],
      [at(1.5), { type: 'setLfo', id: 'vol', value: 0.7 }],
      [at(1.5), { type: 'setLfo', id: 'pitch', value: 2 }],
      [at(1.6), { type: 'setLfo', id: 'filter', value: 3 }],
      [at(1.6), { type: 'setLfo', id: 'smooth', value: 0.4 }],
      [at(1.7), { type: 'setLfo', id: 'shape', value: 5 }],
      [at(1.7), { type: 'setLfo', id: 'pan', value: 0.5 }],
      [at(1.8), { type: 'setLfo', id: 'fm', value: 0.5 }],
      [at(1.9), { type: 'setBus', bus: 1, id: 'dly_vol', value: 0.8 }],
      [at(2.0), { type: 'setBus', bus: 0, id: 'flt', value: 0.3 }],
      [at(2.2), { type: 'setGlobal', id: 'swing', value: 62 }],
      [at(2.4), { type: 'setPatternSpeed', channel: 2, pattern: 0, speed: 'double' }],
      [at(2.4), { type: 'setPatternSpeed', channel: 1, pattern: 0, speed: 'triplet' }],
      [at(2.5), { type: 'setPatternSpeed', channel: 4, pattern: 0, speed: 'half' }],
      [at(2.8), { type: 'holdRoll', channel: 2, on: true, note: 33 }],
      [at(3.6), { type: 'holdRoll', channel: 2, on: false, note: 33 }],
      [at(3.0), { type: 'setForce', channel: 1, ring: false, slide: true, velocity: 1 }],
      [at(4.0), { type: 'setForce', channel: 1, ring: false, slide: false }],
      [at(3.1), { type: 'trigger', channel: 6, note: 64, velocity: 0.9 }],
      [at(3.5), { type: 'trigger', channel: 6, note: 67, velocity: 0.9, slideFrom: 64 }],
      [at(3.9), { type: 'release', channel: 6, note: 67 }],
      [at(4.2), { type: 'recordNote', channel: 5, note: 60, velocity: 0.8, accent: false, chord: true }],
      [at(4.23), { type: 'recordNote', channel: 5, note: 64, velocity: 0.8, accent: false, chord: true }],
      [at(4.9), { type: 'release', channel: 5, note: 64 }],
      [at(5.3), { type: 'release', channel: 5, note: 60 }],
      [at(4.4), { type: 'recordNote', channel: 4, note: 40, velocity: 1, accent: true }],
      [at(4.7), { type: 'recordNote', channel: 4, note: 43, velocity: 0.8, accent: false, slide: true }],
      [at(5.1), { type: 'release', channel: 4, note: 43 }],
      [at(5.2), { type: 'recordLock', channel: 4, id: 'reso', value: 0.7 }],
      [at(5.5), { type: 'setGlobal', id: 'meter', value: 4 }],
      [at(6.0), { type: 'setGlobal', id: 'bpm', value: 140 }],
      [at(6.3), { type: 'setArp', channel: 7, id: 'on', value: 1 }],
      [at(6.3), { type: 'setArp', channel: 7, id: 'mode', value: 4 }],
      [at(6.3), { type: 'setChord', channel: 7, chord: 15 }],
      [at(6.5), { type: 'setMix', channel: 0, id: 'mute', value: 1 }],
      [at(7.0), { type: 'setMix', channel: 0, id: 'mute', value: 0 }],
      [at(7.2), { type: 'setInstrument', channel: 3, kind: 'bass', sound: {} }],
      [at(7.4), { type: 'swapNotes', channel: 2, pattern: 0, length: 16, steps: p.channels[0].patterns[0].steps.slice(0, 16) }],
      [at(8.0), { type: 'transport', playing: false, gen: 2 }],
      [at(8.3), { type: 'trigger', channel: 4, note: 45, velocity: 0.8 }],
    ]);
    push(`${name} song`, 12, [
      [0, { type: 'setClick', on: true, level: 0.7 }],
      ...opening({ ...p, song: song() }, { song: true, fromRow: 0, fromBar: 0 }),
      [at(9.0), { type: 'songJump', row: 1 }],
    ]);
    push(`${name} count-in, from bar 2, glide curve`, 6, [
      [0, { type: 'setClick', on: true, level: 0.5 }],
      [0, { type: 'setGlideCurve', curve: 3 }],
      ...opening(p, { countIn: 1, fromChannel: 0, fromStep: Math.min(16, p.channels[0].patterns[p.channels[0].activePattern].length - 1) }),
      [at(3.0), { type: 'switchPatterns', channels: [4, 5], pattern: 2, quick: true }],
    ]);
  }
  return out;
}

type Recorded = Extract<WorkletToMain, { type: 'recordedNote' | 'recordedLock' | 'recordedChord' }>;

/**
 * The web build's engine: the same Rust compiled to WebAssembly, driven exactly as the worklet
 * drives it (src/worklet/wasmEngine.ts, through native/src/host.rs): messages queued as JSON
 * and handled at the start of the block they fall in, audio interleaved, what it wrote drained.
 */
async function renderWasm(list: Scenario[]): Promise<{ audio: Float32Array; recorded: Recorded[][] }> {
  execFileSync('node', ['scripts/build-wasm.mjs'], { stdio: 'inherit' });
  const { ENGINE_WASM } = await import('../../src/worklet/engineWasm.gen');
  const { WasmEngine, fromBase64 } = await import('../../src/worklet/wasmEngine');
  const bytes = fromBase64(ENGINE_WASM);
  const audio = new Float32Array(list.reduce((n, sc) => n + sc.frames * 2, 0));
  const recorded: Recorded[][] = [];
  let off = 0;
  for (const sc of list) {
    const engine = new WasmEngine(bytes, sc.sampleRate);
    const rec: Recorded[] = [];
    let next = 0;
    for (let pos = 0; pos < sc.frames; pos += sc.block) {
      const n = Math.min(sc.block, sc.frames - pos);
      while (next < sc.msgs.length && sc.msgs[next][0] < pos + n) engine.send(sc.msgs[next++][1]);
      engine.render(n);
      audio.set(engine.audio, off + pos * 2);
      for (const m of engine.drain() ?? []) {
        if (m.type === 'recordedNote') rec.push({ ...m, start: m.start === true });
        else if (m.type === 'recordedLock' || m.type === 'recordedChord') rec.push(m);
      }
    }
    recorded.push(rec);
    off += sc.frames * 2;
  }
  return { audio, recorded };
}

const GOLDEN = 'tools/native/golden.json';
/** Frames per fingerprint slice (100 ms). */
const SLICE = SR / 10;

interface Print { name: string; level: number[]; edge: number[]; recorded: Recorded[] }

/** A scenario's fingerprint: per slice, each side's RMS and its first difference's RMS (L, R alternating). */
function print(name: string, audio: Float32Array, recorded: Recorded[]): Print {
  const frames = audio.length / 2;
  const level: number[] = [], edge: number[] = [];
  for (let at = 0; at < frames; at += SLICE) {
    const end = Math.min(frames, at + SLICE);
    for (let c = 0; c < 2; c++) {
      let p = 0, d = 0, prev = at > 0 ? audio[(at - 1) * 2 + c] : 0;
      for (let i = at; i < end; i++) {
        const x = audio[i * 2 + c];
        p += x * x;
        d += (x - prev) ** 2;
        prev = x;
      }
      level.push(Number(Math.sqrt(p / (end - at)).toPrecision(9)));
      edge.push(Number(Math.sqrt(d / (end - at)).toPrecision(9)));
    }
  }
  return { name, level, edge, recorded };
}

/** Within 1e-5 relative (about -100 dB), or 1e-7 absolute near silence. */
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7 + 1e-5 * Math.max(Math.abs(a), Math.abs(b));

describe('the engine golden test: whole projects', () => {
  it('the native and the WebAssembly builds play the same, and what the golden file says', async () => {
    const list = scenarios();
    const dir = mkdtempSync(join(tmpdir(), 'engine-golden-'));
    writeFileSync(join(dir, 'scenarios.json'), JSON.stringify(list));
    execFileSync('cargo', ['run', '--quiet', '--release', '--manifest-path', 'native/Cargo.toml', '--example', 'engine', '--', join(dir, 'scenarios.json'), join(dir, 'out.f32'), join(dir, 'recorded.json')], { stdio: 'inherit' });
    const buf = readFileSync(join(dir, 'out.f32'));
    const native = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const nativeRec = readFileSync(join(dir, 'recorded.json'), 'utf8').trim().split('\n').map((x) => JSON.parse(x) as Recorded[]);
    const wasm = await renderWasm(list);
    expect(native.length).toBe(wasm.audio.length);

    const failures: string[] = [];
    const prints: Print[] = [];
    let off = 0;
    list.forEach((sc, k) => {
      const n = sc.frames * 2;
      const a = native.subarray(off, off + n), b = wasm.audio.subarray(off, off + n);
      off += n;
      let diff = 0, peak = 0;
      for (let i = 0; i < n; i++) {
        diff = Math.max(diff, Math.abs(a[i] - b[i]));
        peak = Math.max(peak, Math.abs(a[i]));
      }
      if (a.some(Number.isNaN) || b.some(Number.isNaN)) diff = Infinity;
      const db = diff === 0 ? -Infinity : 20 * Math.log10(diff);
      if (!(db < -100)) failures.push(`${sc.name}: native and WebAssembly ${db.toFixed(1)} dB apart`);
      if (JSON.stringify(nativeRec[k]) !== JSON.stringify(wasm.recorded[k])) failures.push(`${sc.name}: recorded ${JSON.stringify(nativeRec[k])} vs ${JSON.stringify(wasm.recorded[k])}`);
      if (peak <= 1e-3 && !sc.quiet) failures.push(`${sc.name}: silent`);
      prints.push(print(sc.name, a, nativeRec[k]));
    });

    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(prints, null, 0).replace(/\},\{/g, '},\n{')}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Print[];
    expect(golden.map((g) => g.name)).toEqual(prints.map((p) => p.name));
    prints.forEach((p, k) => {
      const g = golden[k];
      const slice = (i: number) => `${((Math.floor(i / 2) * SLICE) / SR).toFixed(1)} s ${i % 2 ? 'R' : 'L'}`;
      const lv = p.level.findIndex((x, i) => !close(x, g.level[i]));
      const ed = p.edge.findIndex((x, i) => !close(x, g.edge[i]));
      if (p.level.length !== g.level.length) failures.push(`${p.name}: ${p.level.length} slices, golden ${g.level.length}`);
      else if (lv >= 0) failures.push(`${p.name}: level at ${slice(lv)} ${p.level[lv]}, golden ${g.level[lv]}`);
      else if (ed >= 0) failures.push(`${p.name}: brightness at ${slice(ed)} ${p.edge[ed]}, golden ${g.edge[ed]}`);
      if (JSON.stringify(p.recorded) !== JSON.stringify(g.recorded)) failures.push(`${p.name}: recorded differs from golden`);
    });
    console.log(`${list.length} engine scenarios: native and WebAssembly agree, ${failures.length ? `${failures.length} differences` : 'golden matches'}`);
    expect(failures).toEqual([]);
  });
});
