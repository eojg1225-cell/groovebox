/**
 * Null tests of the native engine (native/, Rust) against the TypeScript engine: the same
 * scenarios (sounds, hits, chokes, cuts, modulation, FX order) rendered by both, sample by
 * sample subtracted. The plan's bar is -100 dB; the port aims at bit-identical.
 * Run: `npm run native:null` (builds native/examples/render.rs with cargo).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SoundKind } from '../../src/engine/project';
import type { ParamSpec } from '../../src/engine/params';
import { Click } from '../../src/instruments/Click';
import {
  DRUM_ROOT, Drum, HAT_PARAMS, HAT_VOICE, KICK_PARAMS, KICK_VOICE, PERC_PARAMS, PERC_VOICE, SNARE_PARAMS, SNARE_VOICE,
} from '../../src/instruments/Drum';
import { MACROS, anchorPosition, macroSound } from '../../src/instruments/macros';

const SR = 48000;
const BLOCK = 128;
const LIMIT_DB = -100;

type Event = [number, string, ...(string | number | boolean)[]];
interface Scenario { name: string; kind: SoundKind | 'click'; sampleRate: number; frames: number; events: Event[] }

const DRUMS = {
  kick: [KICK_PARAMS, KICK_VOICE],
  snare: [SNARE_PARAMS, SNARE_VOICE],
  hat: [HAT_PARAMS, HAT_VOICE],
  perc: [PERC_PARAMS, PERC_VOICE],
} as const satisfies Partial<Record<SoundKind, readonly [readonly ParamSpec[], unknown]>>;
type DrumKind = keyof typeof DRUMS;

const at = (s: number) => Math.round(s * SR);
const frames = (s: number) => Math.ceil((s * SR) / BLOCK) * BLOCK;

/** A sound's parameters as the engine sends them (TIMBRE / INT through the macros). */
function sound(kind: DrumKind, timbre: number, intensity: number): Event[] {
  return Object.entries(macroSound(kind, timbre, intensity, DRUMS[kind][0])).map(([id, v]) => [0, 'param', id, v] as Event);
}

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const kind of Object.keys(DRUMS) as DrumKind[]) {
    const n = MACROS[kind].anchors.length;
    for (let a = 0; a < n; a++) {
      for (const int of [0, 0.5, 1]) {
        // A hit, an accent, a RING hit choked by noteOff, a quick retrigger over its tail.
        out.push({
          name: `${kind} ${MACROS[kind].anchors[a].name} INT ${int}`, kind, sampleRate: SR, frames: frames(1.3),
          events: [
            ...sound(kind, anchorPosition(kind, a), int),
            [0, 'on', DRUM_ROOT, 0.8, false],
            [at(0.3), 'on', DRUM_ROOT + 3, 1, false],
            [at(0.55), 'on', DRUM_ROOT, 0.8, true],
            [at(0.9), 'off'],
            [at(0.93), 'on', DRUM_ROOT - 5, 0.45, false],
          ],
        });
      }
    }
    // Between the sounds, AIR in both FX orders, DRIVE / CRUSH, the LFO's pitch and filter,
    // RING length, OCTAVE, BALANCE, a REST mid-hit, a fast roll.
    const base = sound(kind, 0.37, 0.62);
    const hits = (gap: number, count: number, ring = false): Event[] =>
      Array.from({ length: count }, (_, i) => [at(0.01 + i * gap), 'on', DRUM_ROOT + (i % 3) * 2, 0.6 + 0.1 * (i % 4), ring] as Event);
    const variant = (name: string, extra: Event[], ev: Event[] = hits(0.25, 4), secs = 1.5) =>
      out.push({ name: `${kind} ${name}`, kind, sampleRate: SR, frames: frames(secs), events: [...base, ...extra, ...ev].sort((x, y) => x[0] - y[0]) });
    for (const chain of [0, 1]) {
      variant(`AIR chain ${chain}`, [[0, 'param', 'air', 0.8], [0, 'param', 'airsize', 0.2], [0, 'param', 'hairsize', 0.3], [0, 'chain', chain], [0, 'param', 'drive', 6], [0, 'param', 'crush', 0.55]], hits(0.3, 4), 2.5);
      variant(`AIR tail chain ${chain}`, [[0, 'param', 'air', 0.5], [0, 'param', 'airsize', 0.9], [0, 'param', 'hairsize', 0.9], [0, 'chain', chain], [at(0.7), 'param', 'air', 0]], hits(0.2, 3), 1.5);
    }
    variant('DRIVE CRUSH', [[0, 'param', 'drive', 40], [0, 'param', 'crush', 0.8], [at(0.4), 'param', 'crush', 0.3]]);
    variant('LFO', [[0, 'pitchMod', 3], [at(0.2), 'filterMod', -2.5], [at(0.6), 'pitchMod', -7], [at(0.8), 'filterMod', 0]]);
    variant('RING x3', [[0, 'ringLength', 3]], [...hits(0.4, 3, true), [at(1.0), 'off']], 2);
    variant('OCTAVE BALANCE', [[0, 'param', 'octave', 6], [0, 'param', 'balance', 0.15], [at(0.5), 'param', 'balance', 0.9]]);
    variant('REST', [], [...hits(0.2, 2), [at(0.27), 'cut'], [at(0.3), 'cut']]);
    variant('ROLL', [[0, 'param', 'drive', 3]], hits(0.03, 20), 1);
  }
  out.push({ name: 'click', kind: 'click', sampleRate: SR, frames: frames(1), events: [[0, 'tick', true], [at(0.25), 'tick', false], [at(0.26), 'tick', false]] });
  return out;
}

/** The TypeScript engine's render, block by block as the Rust renderer does it. */
function renderTs(sc: Scenario): Float32Array {
  const out = new Float32Array(sc.frames * 2);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  const click = sc.kind === 'click' ? new Click(sc.sampleRate) : null;
  const drum = sc.kind === 'click' ? null : new Drum(sc.sampleRate, ...(DRUMS[sc.kind as DrumKind] as unknown as [readonly ParamSpec[], typeof KICK_VOICE]));
  const apply = (e: Event) => {
    const [, op, a, b, c] = e;
    if (click) { click.trigger(a as boolean); return; }
    const d = drum!;
    switch (op) {
      case 'param': d.setParam(a as string, b as number); break;
      case 'on': d.noteOn(a as number, b as number, 0, c as boolean); break;
      case 'off': d.noteOff(0); break;
      case 'cut': d.cut(); break;
      case 'ringLength': d.setRingLength(a as number); break;
      case 'pitchMod': d.setPitchMod(a as number); break;
      case 'filterMod': d.setFilterMod(a as number); break;
      case 'chain': d.setChain(a as number); break;
    }
  };
  let next = 0;
  for (let block = 0; block < sc.frames; block += BLOCK) {
    const n = Math.min(BLOCK, sc.frames - block);
    l.fill(0); r.fill(0);
    let pos = 0;
    for (;;) {
      const due = next < sc.events.length && sc.events[next][0] < block + n ? sc.events[next] : null;
      const until = due ? due[0] - block : n;
      if (until > pos) {
        if (drum) drum.render(l, r, pos, until);
        else click!.render(l, pos, until - pos);
        pos = until;
      }
      if (!due) break;
      apply(due);
      next++;
    }
    if (drum) drum.post?.(l, r, n);
    else r.set(l);
    for (let i = 0; i < n; i++) { out[(block + i) * 2] = l[i]; out[(block + i) * 2 + 1] = r[i]; }
  }
  return out;
}

describe('native engine null tests', () => {
  it('drums and click: the Rust engine renders what the TypeScript engine renders', () => {
    const list = scenarios();
    const dir = mkdtempSync(join(tmpdir(), 'native-null-'));
    writeFileSync(join(dir, 'scenarios.json'), JSON.stringify(list));
    execFileSync('cargo', ['run', '--quiet', '--release', '--manifest-path', 'native/Cargo.toml', '--example', 'render', '--', join(dir, 'scenarios.json'), join(dir, 'out.f32')], { stdio: 'inherit' });
    const buf = readFileSync(join(dir, 'out.f32'));
    const rust = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    let off = 0;
    const rows: string[] = [];
    let worstDb = -Infinity;
    let identical = 0;
    for (const sc of list) {
      const ts = renderTs(sc);
      const ours = rust.subarray(off, off + ts.length);
      off += ts.length;
      let diff = 0, peak = 0;
      for (let i = 0; i < ts.length; i++) {
        diff = Math.max(diff, Math.abs(ts[i] - ours[i]));
        peak = Math.max(peak, Math.abs(ts[i]));
      }
      if (Number.isNaN(diff) || ours.some(Number.isNaN)) diff = Infinity;
      const db = diff === 0 ? -Infinity : 20 * Math.log10(diff);
      if (diff === 0) identical++;
      worstDb = Math.max(worstDb, db);
      if (diff !== 0) rows.push(`${sc.name.padEnd(34)} peak ${peak.toFixed(3)}  diff ${db.toFixed(1)} dB`);
      expect(peak, `${sc.name}: silent`).toBeGreaterThan(sc.kind === 'click' ? 0.1 : 1e-4);
      expect(db, sc.name).toBeLessThan(LIMIT_DB);
    }
    expect(off).toBe(rust.length);
    console.log(`${list.length} scenarios: ${identical} bit-identical, worst ${worstDb === -Infinity ? 'none' : `${worstDb.toFixed(1)} dB`}\n${rows.join('\n')}`);
  });
});
