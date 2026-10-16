import { describe, expect, it } from 'vitest';
import { Engine, hitToneCutoff, type RecordedMsg } from '../src/engine/Engine';
import { toNorm, toValue } from '../src/engine/params';
import { GLOBAL_PARAMS, MIX_PARAMS } from '../src/engine/mixParams';
import { emptyPattern, type Project } from '../src/engine/project';
import { fromStored, toStored } from '../src/engine/projectFile';
import { applyPreset, createDefaultProject } from '../src/engine/defaultProject';
import { CHORDS } from '../src/engine/chords';
import { INSTRUMENTS, presetSound } from '../src/instruments/registry';
import { Drum, KICK_PARAMS, SNARE_PARAMS } from '../src/instruments/Drum';
import { Synth, PAD_FIXED, PAD_PARAMS } from '../src/instruments/Synth';
import { Delay } from '../src/fx/Delay';
import { Distortion } from '../src/fx/Distortion';
import { MidCut } from '../src/fx/MidCut';
import { FX_PARAMS } from '../src/fx';
import { Chorus } from '../src/fx/Chorus';
import { Reverb } from '../src/fx/Reverb';
import { Flanger } from '../src/fx/Flanger';

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
  kick.sounds.kick = { ...presetSound('kick', 0), t_decay: 0.05, c_level: 0 };
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
    const all = [...Object.values(INSTRUMENTS).flatMap((i) => i.params), ...MIX_PARAMS, ...GLOBAL_PARAMS, ...FX_PARAMS];
    for (const spec of all) {
      const points = spec.options ? spec.options.map((_, i) => i / (spec.options!.length - 1)) : [0, 0.25, 0.5, 1];
      for (const n of points) expect(toNorm(spec, toValue(spec, n))).toBeCloseTo(n, 9);
      expect(spec.defaultValue).toBeGreaterThanOrEqual(spec.min);
      expect(spec.defaultValue).toBeLessThanOrEqual(spec.max);
    }
  });
});

describe('instruments', () => {
  for (const [kind, entry] of Object.entries(INSTRUMENTS)) {
    for (const [pi, preset] of entry.presets.entries()) {
      it(`${kind} ${preset.name}: sounds, stays finite and bounded, then dies away`, () => {
        const inst = entry.create(SR);
        const sound = presetSound(kind as keyof typeof INSTRUMENTS, pi);
        for (const id in sound) inst.setParam(id, sound[id]);
        const l = new Float32Array(SR * 5);
        const r = new Float32Array(SR * 5);
        inst.noteOn(48, 1, 48);
        inst.render(l, r, 0, SR / 4);
        inst.noteOff(48);
        inst.render(l, r, SR / 4, l.length);
        const head = stats(l.subarray(0, SR / 4));
        const tail = stats(l.subarray(l.length - SR / 10));
        expect(head.nan).toBe(false);
        expect(head.peak).toBeGreaterThan(0.05);
        expect(head.peak).toBeLessThan(2);
        expect(tail.peak).toBeLessThan(0.001);
      });
    }
  }

  it('each type fits one page of 12 knobs; coarse params are discrete; presets use real params', () => {
    for (const entry of Object.values(INSTRUMENTS)) {
      expect(entry.params.length).toBeLessThanOrEqual(12);
      for (const p of entry.params) if (p.options) expect(p.coarse).toBe(true);
      for (const preset of entry.presets) {
        for (const id of preset.live) {
          const spec = entry.params.find((p) => p.id === id);
          expect(spec).toBeDefined();
          expect(spec?.coarse).toBeFalsy();
        }
        for (const id in preset.values) expect(entry.params.some((p) => p.id === id)).toBe(true);
      }
    }
  });

  it('drum crush and drive keep the output bounded', () => {
    const d = new Drum(SR, SNARE_PARAMS);
    const sound = presetSound('snare', INSTRUMENTS.snare.presets.findIndex((p) => p.name === 'IND'));
    for (const id in sound) d.setParam(id, sound[id]);
    d.setParam('drive', 30);
    d.setParam('crush', 1);
    const l = new Float32Array(SR);
    d.noteOn(36, 1, 36);
    d.render(l, new Float32Array(SR), 0, SR);
    const st = stats(l);
    expect(st.nan).toBe(false);
    expect(st.peak).toBeLessThanOrEqual(1.01);
  });

  it('synth plays several voices at once (for chords)', () => {
    const one = new Synth(SR, PAD_PARAMS, PAD_FIXED);
    const four = new Synth(SR, PAD_PARAMS, PAD_FIXED);
    for (const s of [one, four]) { s.setParam('attack', 0.001); s.setParam('sustain', 1); s.setParam('level', 0.3); }
    one.noteOn(48, 1, 48);
    for (const n of CHORDS[1].intervals) four.noteOn(48 + n, 1, 48);
    const energy = (s: Synth) => {
      const l = new Float32Array(SR / 4);
      s.render(l, new Float32Array(SR / 4), 0, l.length);
      return l.reduce((a, v) => a + v * v, 0);
    };
    expect(energy(four)).toBeGreaterThan(energy(one) * 2);
  });
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

  it('starts with every pattern empty', () => {
    const p = createDefaultProject();
    expect(p.channels.every((c) => c.patterns.every((pat) => pat.steps.every((st) => !st.active)))).toBe(true);
  });

  it('plays a busy project loud enough, finite and inside [-1, 1]', () => {
    const p = createDefaultProject();
    p.channels.forEach((c) => [0, 3, 4, 7, 8, 10, 12, 14].forEach((i) => (c.patterns[0].steps[i].active = true)));
    const e = engineWith(p);
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
    p.channels[0].sounds.kick = { ...presetSound('kick', 0), t_decay: 1, c_level: 0, t_sweep: 0, t_pitch: 40 };
    p.channels[0].patterns[0].steps[0].locks = { t_pitch: 120 };
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
    e.handleMessage({ type: 'recordLock', channel: 0, id: 't_pitch', value: 90 });
    expect(got).toEqual([{ type: 'recordedLock', channel: 0, pattern: 0, index: 1, id: 't_pitch', value: 90 }]);
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

describe('chords and gates', () => {
  it('chord mode plays the chord and sequenced notes release after their gate', () => {
    const p = kickProject([]);
    applyPreset(p.channels[4], 'pad', INSTRUMENTS.pad.presets.findIndex((x) => x.name === 'STAB'));
    p.channels[4].sounds.pad!.release = 0.02;
    p.channels[4].sends = [0, 0, 0, 0, 0, 0];
    p.channels[4].chord = 0;
    p.channels[4].patterns[0].steps[0].active = true;
    const plain = engineWith(p);
    p.channels[4].chord = CHORDS.findIndex((c) => c.name === 'MIN9');
    const chord = engineWith(p);
    const energy = (e: Engine, sec: number) => render(e, sec).l.reduce((a, v) => a + v * v, 0);
    for (const e of [plain, chord]) e.handleMessage({ type: 'transport', playing: true });
    expect(energy(chord, 0.1)).toBeGreaterThan(energy(plain, 0.1) * 1.5);
    // The 16th is 6000 frames; after ~0.8 of it plus the release the note is gone.
    render(chord, 0.15);
    expect(stats(render(chord, 0.1).l).peak).toBeLessThan(0.01);
  });

  it('switching a channel instrument clears its locks', () => {
    const p = kickProject([0]);
    p.channels[0].patterns[0].steps[0].locks = { t_pitch: 300 };
    const e = engineWith(p);
    e.handleMessage({ type: 'setInstrument', channel: 0, kind: 'bass', sound: presetSound('bass', 0) });
    e.handleMessage({ type: 'transport', playing: true });
    const st = stats(render(e, 0.1).l);
    expect(st.nan).toBe(false);
    expect(st.peak).toBeGreaterThan(0.01);
  });
});

describe('drum layers', () => {
  it('a kick has no metal layer and a snare no click layer', () => {
    expect(KICK_PARAMS.some((p) => p.id.startsWith('m_'))).toBe(false);
    expect(SNARE_PARAMS.some((p) => p.id.startsWith('c_'))).toBe(false);
    expect(INSTRUMENTS.hat.params.some((p) => p.id.startsWith('t_'))).toBe(false);
  });

  it('the played note tunes a drum (chromatic play)', () => {
    const zc = (note: number) => {
      const d = new Drum(SR, KICK_PARAMS);
      d.setParam('t_sweep', 0); d.setParam('c_level', 0); d.setParam('t_decay', 2);
      const l = new Float32Array(SR / 4);
      d.noteOn(note, 1, note);
      d.render(l, new Float32Array(l.length), 0, l.length);
      let n = 0;
      for (let i = 1; i < l.length; i++) if (l[i - 1] < 0 && l[i] >= 0) n++;
      return n;
    };
    expect(zc(48) / zc(36)).toBeCloseTo(2, 0);
  });
});

describe('send effects', () => {
  const impulse = (len: number) => { const a = new Float32Array(len); a[0] = 1; return a; };

  it('delay repeats at the tempo-synced time and decays', () => {
    const d = new Delay(SR);
    d.setTempo(120);
    d.setParam('dly_time', 3); // 1/4 = 24000 frames
    d.setParam('dly_tone', 12000);
    d.setParam('dly_fdbk', 0.5);
    d.setParam('dly_return', 1);
    // Let the delay time glide to its target first.
    const pre = new Float32Array(SR);
    d.process(pre, pre, new Float32Array(SR), new Float32Array(SR), 0, SR);
    const n = SR * 2;
    const inL = impulse(n);
    const outL = new Float32Array(n);
    d.process(inL, new Float32Array(n), outL, new Float32Array(n), 0, n);
    const peakNear = (at: number) => Math.max(...Array.from(outL.subarray(at - 50, at + 50), Math.abs));
    expect(peakNear(24000)).toBeGreaterThan(0.3);
    expect(peakNear(48000)).toBeLessThan(peakNear(24000));
    expect(peakNear(48000)).toBeGreaterThan(0.01);
  });

  it('delay feedback above 1 stays bounded (runs away gracefully)', () => {
    const d = new Delay(SR);
    d.setTempo(170);
    d.setParam('dly_time', 0);
    d.setParam('dly_fdbk', 1.1);
    d.setParam('dly_return', 1);
    const n = SR * 6;
    const outL = new Float32Array(n);
    const noiseIn = Float32Array.from({ length: n }, (_, i) => (i < 2000 ? Math.sin(i * 0.3) : 0));
    d.process(noiseIn, noiseIn, outL, new Float32Array(n), 0, n);
    expect(stats(outL).nan).toBe(false);
    expect(stats(outL).peak).toBeLessThan(2.5);
  });

  it('distortion output is bounded at any drive', () => {
    const d = new Distortion(SR);
    d.setParam('dst_drive', 50);
    d.setParam('dst_return', 1);
    const n = SR / 4;
    const sine = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.05) * 2);
    const out = new Float32Array(n);
    d.process(sine, sine, out, new Float32Array(n), 0, n);
    expect(stats(out).peak).toBeLessThan(1);
  });

  it('mid-cut removes energy at its centre frequency', () => {
    const energyAt = (freq: number) => {
      const m = new MidCut(SR);
      m.setParam('mid_freq', 1000); m.setParam('mid_depth', 24); m.setParam('mid_return', 1);
      const n = SR / 2;
      const sine = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / SR));
      const out = new Float32Array(n);
      m.process(sine, sine, out, new Float32Array(n), 0, n);
      return out.subarray(n / 2).reduce((a, v) => a + v * v, 0) / (n / 2);
    };
    expect(energyAt(1000)).toBeLessThan(energyAt(100) * 0.1);
  });

  it('a channel send feeds its effect into the mix', () => {
    const dry = kickProject([0], { bpm: 120 });
    const wet = kickProject([0], { bpm: 120 });
    wet.fx.dly_time = 3; // a quarter note later
    wet.channels[0].sends = [1, 0, 0, 0, 0, 0];
    const tail = (p: Project) => {
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      return stats(render(e, 0.6).l.subarray(23000, 26000)).peak;
    };
    expect(tail(dry)).toBeLessThan(1e-4);
    expect(tail(wet)).toBeGreaterThan(0.01);
  });
});

describe('note lengths', () => {
  /** Lead track (mono, short release) with one note at step 0 of the given gate. */
  const leadProject = (gate: number) => {
    const p = kickProject([]);
    p.channels.forEach((c) => (c.sends = [0, 0, 0, 0, 0, 0]));
    const lead = p.channels[5];
    lead.sounds.lead = { ...presetSound('lead', 0), attack: 0.001, sustain: 1, release: 0.005 };
    lead.patterns[0].steps[0].active = true;
    lead.patterns[0].steps[0].gate = gate;
    return p;
  };
  const level = (l: Float32Array, from: number, to: number) => stats(l.subarray(from, to)).peak;

  it('a note lasts exactly one step by default', () => {
    const e = engineWith(leadProject(1));
    e.handleMessage({ type: 'transport', playing: true });
    const { l } = render(e, 0.3); // steps are 6000 frames
    expect(level(l, 4000, 5900)).toBeGreaterThan(0.05);
    expect(level(l, 7000, 11000)).toBeLessThan(0.002);
  });

  it('a tied note sustains until the step where it is released', () => {
    const e = engineWith(leadProject(3));
    e.handleMessage({ type: 'transport', playing: true });
    const { l } = render(e, 0.5);
    expect(level(l, 16000, 17900)).toBeGreaterThan(0.05); // still in step 2
    expect(level(l, 19000, 23000)).toBeLessThan(0.002); // released at step 3
  });

  it('live recording sets the note length from how long the key was held', () => {
    const e = engineWith(leadProject(1));
    const got: RecordedMsg[] = [];
    e.onRecorded = (m) => got.push(m);
    e.handleMessage({ type: 'transport', playing: true });
    render(e, 6500 / SR); // early in step 1
    e.handleMessage({ type: 'recordNote', channel: 5, note: 50, velocity: 0.8, accent: false });
    render(e, 24000 / SR); // hold ~4 steps
    e.handleMessage({ type: 'release', channel: 5, note: 50 });
    const last = got[got.length - 1];
    expect(last.type === 'recordedNote' && [last.index, last.gate]).toEqual([1, 4]);
  });
});

describe('more send effects', () => {
  const run = (fx: { process: Chorus['process'] }, seconds = 1) => {
    const n = Math.floor(SR * seconds);
    const input = Float32Array.from({ length: n }, (_, i) => (i < SR / 10 ? Math.sin(i * 0.05) * 0.8 : 0));
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    fx.process(input, input, l, r, 0, n);
    return { l, r };
  };

  it('reverb produces a decaying stereo tail, bounded', () => {
    const rv = new Reverb(SR);
    rv.setParam('rev_return', 1);
    const { l, r } = run(rv, 3);
    expect(stats(l).nan).toBe(false);
    expect(stats(l.subarray(SR / 2, SR)).peak).toBeGreaterThan(0.001); // tail after the input stops
    expect(stats(l.subarray(SR * 2.8)).peak).toBeLessThan(stats(l.subarray(SR / 2, SR)).peak);
    expect(stats(l).peak).toBeLessThan(2);
    let diff = 0;
    for (let i = 0; i < l.length; i++) diff += Math.abs(l[i] - r[i]);
    expect(diff).toBeGreaterThan(0); // stereo
  });

  it('chorus and flanger stay bounded, even with high flanger feedback', () => {
    const ch = new Chorus(SR);
    ch.setParam('cho_return', 1);
    const fl = new Flanger(SR);
    fl.setParam('flg_return', 1);
    fl.setParam('flg_fdbk', 0.95);
    for (const out of [run(ch), run(fl)]) {
      expect(stats(out.l).nan).toBe(false);
      expect(stats(out.l).peak).toBeGreaterThan(0.1);
      expect(stats(out.l).peak).toBeLessThan(2);
    }
  });
});

describe('project', () => {
  const busy = () => {
    const p = createDefaultProject();
    p.bpm = 172.5;
    p.channels[0].patterns[0].steps[0].active = true;
    p.channels[0].patterns[0].steps[4].active = true;
    p.channels[0].patterns[0].steps[4].accent = true;
    p.channels[0].patterns[0].steps[4].velocity = 1;
    p.channels[3].patterns[1].length = 32;
    const s = p.channels[3].patterns[1].steps[20];
    Object.assign(s, { active: true, note: 41, gate: 3, velocity: 0.45, locks: { cutoff: 900 } });
    p.channels[4].sends[4] = 0.7;
    p.channels[1].mute = true;
    return p;
  };

  it('survives a round trip through the stored format', () => {
    const p = busy();
    expect(fromStored(JSON.parse(JSON.stringify(toStored(p))))).toEqual(p);
  });

  it('stores only steps with notes (compact)', () => {
    const stored = toStored(busy());
    const total = stored.channels.reduce((n, c) => n + c.patterns.reduce((m, pat) => m + pat.steps.length, 0), 0);
    expect(total).toBe(3);
    expect(JSON.stringify(stored).length).toBeLessThan(20000);
  });

  it('starts with every pattern empty', () => {
    const p = createDefaultProject();
    expect(p.channels.every((c) => c.patterns.every((pat) => pat.steps.every((st) => !st.active)))).toBe(true);
  });

  it('loads notes from an old full-format project (v4 object)', () => {
    const p = busy();
    const old = JSON.parse(JSON.stringify(p)); // the pre-compact format: full step arrays
    const loaded = fromStored(old)!;
    expect(loaded.channels[3].patterns[1].steps[20]).toMatchObject({ active: true, note: 41, gate: 3 });
    expect(loaded.channels[3].patterns[1].length).toBe(32);
    expect(loaded.channels[1].mute).toBe(true);
  });

  it('keeps the notes even from an older, different format', () => {
    // A version-1 style project: other instrument kinds, a "sound" field, no sends or fx.
    const steps = Array.from({ length: 64 }, (_, i) => ({ active: i % 4 === 0, note: 36 + i, velocity: 0.8, gate: 1, slide: false, accent: false }));
    const v1 = {
      version: 1, bpm: 140, swing: 54, master: 0.8,
      channels: [
        { instrument: 'kick', sound: { tune: 50 }, volume: 0.9, pan: 0, mute: false, activePattern: 1, patterns: [{ length: 16, steps }, { length: 12, steps }, { length: 16, steps }] },
        { instrument: 'bass', sound: {}, volume: 0.7, pan: 0.2, mute: false, activePattern: 0, patterns: [{ length: 16, steps }] },
      ],
    };
    const p = fromStored(v1)!;
    expect(p.bpm).toBe(140);
    expect(p.channels[0].activePattern).toBe(1);
    expect(p.channels[0].patterns[1].length).toBe(12);
    expect(p.channels[0].patterns[0].steps.filter((s) => s.active).length).toBe(16);
    expect(p.channels[1].instrument).toBe('bass');
    expect(p.channels[1].patterns[0].steps[8]).toMatchObject({ active: true, note: 44 });
    expect(p.channels[1].pan).toBe(0.2);
    // Unknown things fall back to defaults.
    expect(p.channels[1].sends).toHaveLength(6);
    expect(p.fx.dly_time).toBeDefined();
  });

  it('rejects data with no channels', () => {
    expect(fromStored({ version: 99 })).toBeNull();
    expect(fromStored(null)).toBeNull();
    expect(fromStored('nonsense')).toBeNull();
  });
});
