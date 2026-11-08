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
import { DRIVE_RISE } from '../../src/instruments/driveComp';
import {
  BASS_FIXED, BASS_PARAMS, BASS_PRESETS, LEAD_FIXED, LEAD_PARAMS, LEAD_PRESETS, PAD_FIXED, PAD_PARAMS, PLUCK_FIXED, PLUCK_PARAMS, Synth,
} from '../../src/instruments/Synth';

const SR = 48000;
/** Drums in the worklet's 128-frame blocks, synths in the engine's 64-frame chunks. */
const DRUM_BLOCK = 128;
const SYNTH_BLOCK = 64;
const LIMIT_DB = -100;

type Event = [number, string, ...(string | number | boolean)[]];
interface Scenario { name: string; kind: SoundKind | 'click'; sampleRate: number; frames: number; block: number; events: Event[] }

const DRUMS = {
  kick: [KICK_PARAMS, KICK_VOICE],
  snare: [SNARE_PARAMS, SNARE_VOICE],
  hat: [HAT_PARAMS, HAT_VOICE],
  perc: [PERC_PARAMS, PERC_VOICE],
} as const satisfies Partial<Record<SoundKind, readonly [readonly ParamSpec[], unknown]>>;
type DrumKind = keyof typeof DRUMS;
const SYNTHS = {
  bass: [BASS_PARAMS, BASS_FIXED],
  pad: [PAD_PARAMS, PAD_FIXED],
  lead: [LEAD_PARAMS, LEAD_FIXED],
  pluck: [PLUCK_PARAMS, PLUCK_FIXED],
} as const;
type SynthKind = keyof typeof SYNTHS;

const at = (s: number) => Math.round(s * SR);
const frames = (s: number) => Math.ceil((s * SR) / DRUM_BLOCK) * DRUM_BLOCK;

/** A sound's parameters as the engine sends them (TIMBRE / INT through the macros). */
function sound(kind: DrumKind | SynthKind, timbre: number, intensity: number): Event[] {
  const specs = kind in DRUMS ? DRUMS[kind as DrumKind][0] : SYNTHS[kind as SynthKind][0];
  return Object.entries(macroSound(kind, timbre, intensity, specs)).map(([id, v]) => [0, 'param', id, v] as Event);
}

/** A synth note: [frame, 'on', note, velocity, group, ring, slideFrom, slide]. */
const on = (t: number, note: number, vel: number, group: number, ring = false, slideFrom = -1, slide = false): Event =>
  [at(t), 'on', note, vel, group, ring, slideFrom, slide];
const off = (t: number, group: number): Event => [at(t), 'off', group];

function synthScenarios(): Scenario[] {
  const out: Scenario[] = [];
  const push = (kind: SynthKind, name: string, events: Event[], secs = 1.6) =>
    out.push({ name: `${kind} ${name}`, kind, sampleRate: SR, frames: frames(secs), block: SYNTH_BLOCK, events: events.sort((x, y) => x[0] - y[0]) });
  for (const kind of Object.keys(SYNTHS) as SynthKind[]) {
    const mono = kind === 'bass' || kind === 'lead';
    // Mono: a note sliding into the next, a RING note, a quick retrigger over a release.
    // Poly: a chord, a RING note over it, then more notes than voices (stealing).
    const play: Event[] = mono
      ? [on(0, 45, 0.8, 0, false, -1, true), on(0.25, 50, 0.9, 1, false, 0), off(0.5, 1), on(0.55, 43, 1, 2, true), off(0.8, 2), on(0.82, 48, 0.45, 3), off(1.05, 3)]
      : [on(0, 57, 0.8, 0), on(0, 60, 0.8, 1), on(0, 64, 0.8, 2), off(0.4, -1), on(0.45, 52, 1, 3, true),
        ...Array.from({ length: 7 }, (_, i) => on(0.7 + i * 0.05, 60 + i * 2, 0.7, 4 + i)), off(1.1, -1)];
    const n = MACROS[kind].anchors.length;
    for (let a = 0; a < n; a++) {
      for (const int of [0, 0.5, 1]) {
        push(kind, `${MACROS[kind].anchors[a].name} INT ${int}`, [...sound(kind, anchorPosition(kind, a), int), ...play]);
      }
    }
    const presets = kind === 'bass' ? BASS_PRESETS : kind === 'lead' ? LEAD_PRESETS : [];
    for (const p of presets) {
      const { timbre, intensity, ...rest } = p.values;
      push(kind, `preset ${p.name}`, [...sound(kind, timbre, intensity), ...Object.entries(rest).map(([id, v]) => [0, 'param', id, v] as Event), ...play]);
    }
    const base = [...sound(kind, 0.4, 0.7), [0, 'tempo', 128] as Event];
    const variant = (name: string, extra: Event[], secs?: number) => push(kind, name, [...base, ...extra, ...play], secs);
    for (const chain of mono ? [0, 1] : [0, 1, 2]) {
      variant(`chain ${chain} DRIVE CRUSH`, [[0, 'chain', chain], [0, 'param', 'drive', 8], [0, 'param', 'crush', 0.6], [at(0.6), 'param', 'cutoff', 300]]);
    }
    variant('UNISON DETUNE SHAPE', [[0, 'param', 'unison', 1.2], [0, 'param', 'detune', 0.5], [0, 'param', 'shape', 2.5], [at(0.5), 'param', 'shape', mono ? 3.6 : 2.9]]);
    variant('FM LFO', [[0, 'param', 'fm', 0.75], [at(0.1), 'fmMod', 0.2], [at(0.3), 'pitchMod', 1.5], [at(0.4), 'filterMod', -1.5], [at(0.9), 'fmMod', -0.4], [at(1), 'pitchMod', 0], [at(1), 'filterMod', 0]]);
    variant('envelopes RESO FENV', [[0, 'param', 'reso', 0.9], [0, 'param', 'fenv', 1.6], [0, 'param', 'fattack', 0.05], [0, 'param', 'fmattack', 0.1], [0, 'param', 'attack', 0.02], [0, 'param', 'release', 0.4]]);
    variant('REST OCTAVE', [[0, 'param', 'octave', 3], [at(0.15), 'cut'], [at(0.6), 'cut']]);
    if (mono) {
      variant('FM RATIO 3:2 SUB GLIDE', [[0, 'param', 'fmpair', 3], [0, 'param', 'fm', 0.5], [0, 'param', 'sub', 1], [0, 'param', 'glide', 0.2]]);
      variant('FM RATIO 1:5 squelch', [[0, 'param', 'fmpair', 6], [0, 'param', 'fm', 0.95], [0, 'param', 'fmcomp', 3]]);
    }
    if (kind === 'bass') variant('DUCK', [[0, 'param', 'duck', 0.8], [0, 'param', 'duckrel', 0.15], [at(0.1), 'duck'], [at(0.3), 'duck'], [at(0.32), 'duck']]);
    if (kind === 'lead') variant('VIBRATO BEND', [[0, 'param', 'vibrato', 0.6], [0, 'param', 'vibdelay', 0.1], [0, 'param', 'vibrate', 7], [0, 'param', 'bend', -12], [0, 'param', 'bendtime', 0.05]]);
    if (kind === 'pad') {
      for (const mt of [0, 1, 2]) variant(`LOW CUT MOD ${mt} VERB`, [[0, 'param', 'lowcut', 300], [0, 'param', 'modmix', 0.7], [0, 'param', 'modtype', mt], [0, 'param', 'verb', 0.5], [at(0.9), 'param', 'modmix', 0]], 2.5);
      variant('FEEDBACK CARRIERS CAR FB', [[0, 'param', 'feedback', 0.8], [0, 'param', 'carriers', 1], [0, 'param', 'cfeedback', 0.7], [0, 'param', 'fm', 0.6], [0, 'param', 'fm2', 0.4]]);
    }
    if (kind === 'pluck') variant('DELAY ROOM', [[0, 'param', 'dmix', 0.6], [0, 'param', 'dfdbk', 0.7], [0, 'param', 'dtime', 3], [0, 'param', 'verb', 0.6], [at(0.8), 'tempo', 90]], 3);
  }
  return out;
}

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const kind of Object.keys(DRUMS) as DrumKind[]) {
    const n = MACROS[kind].anchors.length;
    for (let a = 0; a < n; a++) {
      for (const int of [0, 0.5, 1]) {
        // A hit, an accent, a RING hit choked by noteOff, a quick retrigger over its tail.
        out.push({
          name: `${kind} ${MACROS[kind].anchors[a].name} INT ${int}`, kind, sampleRate: SR, frames: frames(1.3), block: DRUM_BLOCK,
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
      out.push({ name: `${kind} ${name}`, kind, sampleRate: SR, frames: frames(secs), block: DRUM_BLOCK, events: [...base, ...extra, ...ev].sort((x, y) => x[0] - y[0]) });
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
  out.push({ name: 'click', kind: 'click', sampleRate: SR, frames: frames(1), block: DRUM_BLOCK, events: [[0, 'tick', true], [at(0.25), 'tick', false], [at(0.26), 'tick', false]] });
  return [...out, ...synthScenarios()];
}

/** The TypeScript engine's render, block by block as the Rust renderer does it. */
function renderTs(sc: Scenario): Float32Array {
  const BLOCK = sc.block;
  const out = new Float32Array(sc.frames * 2);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  const click = sc.kind === 'click' ? new Click(sc.sampleRate) : null;
  const synthKind = sc.kind in SYNTHS ? (sc.kind as SynthKind) : null;
  const synth = synthKind ? new Synth(sc.sampleRate, SYNTHS[synthKind][0], SYNTHS[synthKind][1], DRIVE_RISE[synthKind]) : null;
  const drum = click || synth ? null : new Drum(sc.sampleRate, ...(DRUMS[sc.kind as DrumKind] as unknown as [readonly ParamSpec[], typeof KICK_VOICE]));
  const inst = drum ?? synth;
  const apply = (e: Event) => {
    const [, op, a, b, c, d5, e6, f7] = e;
    if (click) { click.trigger(a as boolean); return; }
    if (synth) {
      switch (op) {
        case 'param': synth.setParam(a as string, b as number); break;
        case 'on': synth.noteOn(a as number, b as number, c as number, d5 as boolean, e6 as number, f7 as boolean); break;
        case 'off': synth.noteOff(a as number); break;
        case 'cut': synth.cut(); break;
        case 'pitchMod': synth.setPitchMod(a as number); break;
        case 'filterMod': synth.setFilterMod(a as number); break;
        case 'fmMod': synth.setFmMod(a as number); break;
        case 'chain': synth.setChain(a as number); break;
        case 'tempo': synth.setTempo(a as number); break;
        case 'duck': synth.duck(); break;
      }
      return;
    }
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
        if (inst) inst.render(l, r, pos, until);
        else click!.render(l, pos, until - pos);
        pos = until;
      }
      if (!due) break;
      apply(due);
      next++;
    }
    if (inst) inst.post?.(l, r, n);
    else r.set(l);
    for (let i = 0; i < n; i++) { out[(block + i) * 2] = l[i]; out[(block + i) * 2 + 1] = r[i]; }
  }
  return out;
}

describe('native engine null tests', () => {
  it('drums, synths and click: the Rust engine renders what the TypeScript engine renders', () => {
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
