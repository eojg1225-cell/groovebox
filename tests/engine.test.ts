import { describe, expect, it } from 'vitest';
import { Engine, hitToneCutoff, type RecordedMsg } from '../src/engine/Engine';
import { toNorm, toValue } from '../src/engine/params';
import { GLOBAL_PARAMS, MIX_PARAMS } from '../src/engine/mixParams';
import { createDefaultProject, emptyPattern, normalizeProject, type Project } from '../src/engine/project';
import { INSTRUMENTS } from '../src/instruments/registry';

const SR = 48000;
const BLOCK = 128;

function render(engine: Engine, seconds: number): { l: Float32Array; r: Float32Array } {
  const total = Math.floor((seconds * SR) / BLOCK) * BLOCK;
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  for (let off = 0; off < total; off += BLOCK) {
    engine.process(l.subarray(off, off + BLOCK), r.subarray(off, off + BLOCK), BLOCK);
  }
  return { l, r };
}

function stats(buf: Float32Array) {
  let peak = 0;
  let nan = false;
  for (const v of buf) {
    if (!Number.isFinite(v)) nan = true;
    peak = Math.max(peak, Math.abs(v));
  }
  return { peak, nan };
}

/** Sample indices where sound starts after at least `gap` quiet samples. */
function onsets(buf: Float32Array, threshold = 0.005, gap = 1000): number[] {
  const out: number[] = [];
  let quiet = gap;
  for (let i = 0; i < buf.length; i++) {
    if (Math.abs(buf[i]) > threshold) {
      if (quiet >= gap) out.push(i);
      quiet = 0;
    } else quiet++;
  }
  return out;
}

/** A project with only a short kick on channel 0, steps as given. */
function kickProject(steps: number[], opts: { length?: number; bpm?: number; swing?: number } = {}): Project {
  const p = createDefaultProject();
  p.bpm = opts.bpm ?? 120; // 6000 frames per 16th at 48 kHz
  p.swing = opts.swing ?? 50;
  p.channels.forEach((c) => {
    c.patterns = c.patterns.map(() => emptyPattern());
  });
  const kick = p.channels[0];
  kick.sound = { decay: 0.05, click: 0 };
  kick.patterns[0].length = opts.length ?? 16;
  for (const s of steps) kick.patterns[0].steps[s].active = true;
  return p;
}

function engineWith(p: Project): Engine {
  const e = new Engine(SR);
  e.handleMessage({ type: 'loadProject', project: p });
  return e;
}

const near = (actual: number[], expected: number[], tol = 4) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((a, i) => expect(Math.abs(a - expected[i])).toBeLessThanOrEqual(tol));
};

describe('params', () => {
  it('round-trips normalised values for every instrument, mix and global param', () => {
    const all = [...Object.values(INSTRUMENTS).flatMap((i) => i.params), ...MIX_PARAMS, ...GLOBAL_PARAMS];
    for (const spec of all) {
      for (const n of [0, 0.25, 0.5, 1]) expect(toNorm(spec, toValue(spec, n))).toBeCloseTo(n, 9);
      expect(spec.defaultValue).toBeGreaterThanOrEqual(spec.min);
      expect(spec.defaultValue).toBeLessThanOrEqual(spec.max);
    }
  });
});

describe('instruments', () => {
  for (const [kind, entry] of Object.entries(INSTRUMENTS)) {
    it(`${kind}: sounds when triggered, stays finite and bounded, then decays`, () => {
      const inst = entry.create(SR);
      for (const spec of entry.params) inst.setParam(spec.id, spec.defaultValue);
      const l = new Float32Array(SR * 3);
      const r = new Float32Array(SR * 3);
      inst.noteOn(36, 1);
      inst.render(l, r, 0, l.length);
      const head = stats(l.subarray(0, SR / 10));
      const tail = stats(l.subarray(l.length - SR / 10));
      expect(head.nan).toBe(false);
      expect(head.peak).toBeGreaterThan(0.05);
      expect(head.peak).toBeLessThan(2);
      expect(tail.peak).toBeLessThan(0.001);
    });
  }
});

describe('sequencer', () => {
  it('is silent until play is pressed', () => {
    const e = engineWith(createDefaultProject());
    expect(stats(render(e, 0.3).l).peak).toBe(0);
  });

  it('fires steps sample-accurately at the tempo', () => {
    const e = engineWith(kickProject([0, 4, 8, 12]));
    e.handleMessage({ type: 'transport', playing: true });
    // 120 BPM: a quarter note is 24000 frames.
    near(onsets(render(e, 2.1).l), [0, 24000, 48000, 72000, 96000]);
  });

  it('loops each channel at its own length (polymeter)', () => {
    const e = engineWith(kickProject([0], { length: 3 }));
    e.handleMessage({ type: 'transport', playing: true });
    near(onsets(render(e, 0.8).l), [0, 18000, 36000]);
  });

  it('applies swing to the off-beat 16ths', () => {
    const e = engineWith(kickProject([1], { swing: 75 }));
    e.handleMessage({ type: 'transport', playing: true });
    // Step 1 starts after a lengthened step 0: 6000 * 1.5.
    near(onsets(render(e, 0.5).l), [9000]);
  });

  it('switches pattern at the end of the loop, not immediately', () => {
    const p = kickProject([0]);
    p.channels[0].patterns[1].steps[2].active = true;
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    const first = render(e, 0.5).l; // 24000 frames: inside the first loop
    e.handleMessage({ type: 'selectPattern', channel: 0, pattern: 1, immediate: false });
    const rest = render(e, 2.0).l;
    near(onsets(first), [0]);
    // Loop ends at 96000; pattern B's step 2 is 12000 later. Offsets are relative to `rest`.
    near(onsets(rest), [96000 + 12000 - first.length]);
  });

  it('mute silences a channel', () => {
    const p = kickProject([0, 4]);
    p.channels[0].mute = true;
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    expect(stats(render(e, 0.5).l).peak).toBeLessThan(1e-4);
  });

  it('plays the demo project loud enough, finite and inside [-1, 1]', () => {
    const e = engineWith(createDefaultProject());
    e.handleMessage({ type: 'transport', playing: true });
    const s = stats(render(e, 4).l);
    expect(s.nan).toBe(false);
    expect(s.peak).toBeGreaterThan(0.2);
    expect(s.peak).toBeLessThanOrEqual(1);
  });

  it('reports the playing step per channel', () => {
    const e = engineWith(kickProject([0]));
    e.handleMessage({ type: 'transport', playing: true });
    render(e, (6000 * 2.5) / SR);
    expect(e.currentStep[0]).toBe(2);
    e.handleMessage({ type: 'transport', playing: false });
    expect(e.currentStep[0]).toBe(-1);
  });
});

describe('dynamics, locks and motion recording', () => {
  it('accent hits are louder and brighter than ghost notes', () => {
    expect(hitToneCutoff(1)).toBeGreaterThan(19000);
    expect(hitToneCutoff(0.8)).toBeLessThan(hitToneCutoff(1));
    expect(hitToneCutoff(0.45)).toBeLessThan(6000);
    // Same hat, accent vs ghost: compare level and high-frequency content.
    const hit = (velocity: number) => {
      const p = kickProject([]);
      const e = engineWith(p);
      e.handleMessage({ type: 'trigger', channel: 2, note: 36, velocity });
      const { l } = render(e, 0.05);
      let energy = 0;
      let diffEnergy = 0; // first difference emphasises highs
      for (let i = 1; i < l.length; i++) { energy += l[i] ** 2; diffEnergy += (l[i] - l[i - 1]) ** 2; }
      return { energy, brightness: diffEnergy / energy };
    };
    const accent = hit(1);
    const ghost = hit(0.45);
    expect(accent.energy).toBeGreaterThan(ghost.energy * 2);
    expect(accent.brightness).toBeGreaterThan(ghost.brightness * 1.2);
  });

  it('a step lock applies on its step and reverts on the next', () => {
    const p = kickProject([0, 1]);
    p.channels[0].sound = { decay: 1, click: 0, punch: 0, tune: 40 };
    p.channels[0].patterns[0].steps[0].locks = { tune: 120 };
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    const { l } = render(e, 0.25); // steps 0 and 1 (6000 frames each)
    const crossings = (a: number, b: number) => {
      let n = 0;
      for (let i = a + 1; i < b; i++) if (l[i - 1] < 0 && l[i] >= 0) n++;
      return n;
    };
        // 4000-frame windows (1/12 s): ~10 cycles at 120 Hz vs ~3 at 40 Hz.
    expect(crossings(1000, 5000)).toBeGreaterThanOrEqual(9);
    expect(crossings(7000, 11000)).toBeLessThanOrEqual(4);
  });

  it('motion-recorded notes land on the nearest step and do not double-trigger', () => {
    const p = kickProject([]);
    const e = engineWith(p);
    const got: RecordedMsg[] = [];
    e.onRecorded = (m) => got.push(m);
    e.handleMessage({ type: 'transport', playing: true });
    render(e, 1000 / SR); // ~1000 frames into step 0 -> nearest is step 0
    e.handleMessage({ type: 'recordNote', channel: 3, note: 40, velocity: 1, accent: true });
    render(e, 4000 / SR); // now ~5000 frames in -> nearest is the next step (1)
    e.handleMessage({ type: 'recordNote', channel: 3, note: 43, velocity: 0.8, accent: false });
    expect(got.map((m) => m.type === 'recordedNote' && [m.index, m.note])).toEqual([[0, 40], [1, 43]]);
  });

  it('motion-recorded knob moves lock the step playing now', () => {
    const e = engineWith(kickProject([0]));
    const got: RecordedMsg[] = [];
    e.onRecorded = (m) => got.push(m);
    e.handleMessage({ type: 'transport', playing: true });
    render(e, 6500 / SR); // inside step 1
    e.handleMessage({ type: 'recordLock', channel: 0, id: 'tune', value: 90 });
    expect(got).toEqual([{ type: 'recordedLock', channel: 0, pattern: 0, index: 1, id: 'tune', value: 90 }]);
  });

  it('pattern length can grow to 64 steps', () => {
    const p = kickProject([0]);
    const e = engineWith(p);
    e.handleMessage({ type: 'setPatternLength', channel: 0, pattern: 0, length: 32 });
    e.handleMessage({ type: 'transport', playing: true });
    // Kick on step 1 of a 32-step loop: hits at 0 and 32 * 6000.
    near(onsets(render(e, 4.2).l), [0, 192000]);
  });
});

describe('project', () => {
  it('survives a JSON round trip', () => {
    const p = createDefaultProject();
    expect(normalizeProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('rejects malformed data', () => {
    expect(normalizeProject({ version: 99 })).toBeNull();
    expect(normalizeProject(null)).toBeNull();
  });
});
