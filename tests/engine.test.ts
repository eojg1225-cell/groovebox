import { DRIVE_RISE, driveCompGain } from '../src/instruments/driveComp';
import { CHORD_NAMES as CHORD_LIST, chordVoicing } from '../src/engine/chords';
import { dynVelocity } from '../src/engine/mixParams';
import { describe, expect, it } from 'vitest';
import { Engine, LOCK_SLOTS, hitToneCutoff, type RecordedMsg } from '../src/engine/Engine';
import { djCutoff, formatValue, toNorm, toValue } from '../src/engine/params';
import { GLOBAL_PARAMS, MIX_PARAMS } from '../src/engine/mixParams';
import { DYNAMIC_VELOCITY, METERS, NUM_PATTERNS, stepPlays, editPattern, emptyPattern, initPatterns, lockProject, patchOf, type Project, type SoundKind } from '../src/engine/project';
import { fromStored, toStored } from '../src/engine/projectFile';
import { applyPreset, createDefaultProject, createStartProject } from '../src/engine/defaultProject';
import { CHORDS } from '../src/engine/chords';
import { INSTRUMENTS, isDrum, LIVE_MACROS, SOUND_KINDS, liveContribution, liveTargets, presetSound } from '../src/instruments/registry';
import { Drum, ROLL_DIVS, HAT_PARAMS, HAT_VOICE, KICK_PARAMS, KICK_VOICE, PERC_PARAMS, PERC_VOICE, SNARE_PARAMS, SNARE_VOICE } from '../src/instruments/Drum';
import { Synth, BASS_FIXED, PAD_FIXED, PAD_PARAMS, LEAD_FIXED, LEAD_PARAMS, dx7Index } from '../src/instruments/Synth';
import { midiToHz } from '../src/instruments/dsp';
import { Delay } from '../src/fx/Delay';
import { Distortion } from '../src/fx/Distortion';

import { Chorus } from '../src/fx/Chorus';
import { Reverb } from '../src/fx/Reverb';
import { CEILING, Limiter } from '../src/fx/Limiter';
import { LFO_RATES, lfoValue } from '../src/engine/lfo';

/** An LFO rate's index by name. */
const RATE = (name: string) => LFO_RATES.findIndex((r) => r.name === name);
import { HALF_STEPS, MACROS, RATIO_STEPS, anchorPosition, macroIds, macroSound, remapPadTimbreV31, remapTimbreV18, timbreName } from '../src/instruments/macros';
import { applyTrim, deriveTrims, hiddenSound, trimFor } from '../src/instruments/trims';
import { paramSpec } from '../src/instruments/registry';
import { drumPage, soundPage, stepsOnStrip } from '../src/instruments/registry';
import { DRUM_BUS_PARAMS, DrumBus, REVERSE_LENGTHS } from '../src/fx/DrumBus';
import { SendBus } from '../src/fx/SendBus';

const SR = 48000;
const BLOCK = 128;

const primed = new WeakSet<Engine>();

/**
 * Render from where the engine is. The first render of an engine first drops the master
 * limiter's look-ahead, so frame 0 of the result is musical time 0.
 */
function render(engine: Engine, seconds: number): { l: Float32Array; r: Float32Array } {
  if (!primed.has(engine)) {
    primed.add(engine);
    const n = engine.latency;
    engine.process(new Float32Array(n), new Float32Array(n), n);
  }
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
    const all = [...Object.values(INSTRUMENTS).flatMap((i) => i.params), ...MIX_PARAMS, ...GLOBAL_PARAMS];
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
        inst.noteOn(48, 1, 48, false);
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

  it('each type has a 16-knob SOUND page of its own params; coarse params are discrete; presets use real params', () => {
    for (const entry of Object.values(INSTRUMENTS)) {
      expect(entry.layout).toHaveLength(16);
      for (const id of entry.layout) expect(id !== null && (id.includes(':') || entry.params.some((p) => p.id === id)), String(id)).toBe(true);
      for (const p of entry.params) if (p.options) expect(p.coarse).toBe(true);
      for (const preset of entry.presets) {
        for (const id in preset.values) expect(entry.params.some((p) => p.id === id)).toBe(true);
      }
    }
  });

  it('sound page frame: the sound, then DRIVE / CRUSH (7), then the performance pair (8)', () => {
    expect(soundPage(['a1', 'd1', 'a2', 'd2'], ['p1', 'p2'])).toEqual([
      'timbre', 'a1', 'a2', 'cutoff', 'fattack', 'fenv', 'drive', 'p1',
      'intensity', 'd1', 'd2', 'reso', 'fdecay', 'fm', 'crush', 'p2',
    ]);
    expect(drumPage(['a1', 'd1', 'a2', 'd2'], ['p1', 'p2'], ['f1', 'f2'], ['s1', 's2'])).toEqual([
      'timbre', 'a1', 'a2', 'p1', 'f1', 's1', 'drive', 'rolldiv',
      'intensity', 'd1', 'd2', 'p2', 'f2', 's2', 'crush', 'balance',
    ]);
    expect(INSTRUMENTS.kick.layout.slice(1, 3)).toEqual(['t_attack', 'c_attack']);
    expect([INSTRUMENTS.kick.layout[4], INSTRUMENTS.kick.layout[12]]).toEqual(['t_sweep', 't_stime']); // the sweep together
    expect([INSTRUMENTS.snare.layout[3], INSTRUMENTS.snare.layout[11]]).toEqual(['t_pitch', 'm_pitch']); // both layers tuned
    expect([INSTRUMENTS.perc.layout[3], INSTRUMENTS.perc.layout[11]]).toEqual(['detune', 'm_interval']);
    expect(INSTRUMENTS.hat.layout.slice(9, 11)).toEqual(['c_len', 'm_decay']);
    // BASS / PLUCK: one envelope for both oscillators; BASS has its own FLT ATK / DEC (v38) on
    // column 3, SUSTAIN / RELEASE under ATTACK / DECAY with FUNC, SIDECHAIN on column 5.
    expect([INSTRUMENTS.bass.layout[1], INSTRUMENTS.bass.layout[9]]).toEqual(['attack', 'decay']);
    expect([INSTRUMENTS.bass.layout[2], INSTRUMENTS.bass.layout[10]]).toEqual(['fattack', 'fdecay']);
    expect([INSTRUMENTS.bass.funcLayout[1], INSTRUMENTS.bass.funcLayout[9]]).toEqual(['sustain', 'release']);
    expect([INSTRUMENTS.bass.layout[4], INSTRUMENTS.bass.layout[12]]).toEqual(['duck', 'duckrel']);
    expect([INSTRUMENTS.pluck.layout[2], INSTRUMENTS.pluck.layout[10]]).toEqual(['dtime', 'dfdbk']);
    expect(INSTRUMENTS.pluck.funcLayout.slice(2, 3).concat(INSTRUMENTS.pluck.funcLayout.slice(10, 11))).toEqual(['dmix', 'verb']);
    expect([INSTRUMENTS.bass.layout[7], INSTRUMENTS.bass.layout[15]]).toEqual(['glide', 'sub']);
    expect([INSTRUMENTS.lead.layout[7], INSTRUMENTS.lead.layout[15]]).toEqual(['glide', 'detune']);
    expect([INSTRUMENTS.pad.layout[7], INSTRUMENTS.pad.layout[15]]).toEqual(['track:chord', 'detune']);
    expect([INSTRUMENTS.pluck.layout[7], INSTRUMENTS.pluck.layout[15]]).toEqual(['track:chord', 'detune']);
    // Drums: no sound FUNC layer, only the track setup (PRESET, LIVE, MID FREQ).
    for (const k of ['kick', 'snare', 'hat', 'perc'] as const) expect(INSTRUMENTS[k].funcLayout.every((id) => id === null || id === 'midfreq' || id.startsWith('track:')), k).toBe(true);
    // PAD / LEAD hold their notes: ATTACK / RELEASE on the page, DECAY / SUSTAIN on FUNC.
    for (const k of ['pad', 'lead'] as const) {
      const l = INSTRUMENTS[k].layout;
      expect([l[1], l[9], l[2], l[10]], k).toEqual(['attack', 'release', 'attack2', 'release2']);
      const f = INSTRUMENTS[k].funcLayout;
      expect([f[1], f[9], f[2], f[10]], k).toEqual(['decay', 'sustain', 'decay2', 'sustain2']);
    }
    for (const k of ['bass', 'pad', 'lead', 'pluck'] as const) {
      expect(INSTRUMENTS[k].funcLayout, k).not.toContain('shape'); // TIMBRE's
    }
    expect(INSTRUMENTS.lead.funcLayout).not.toContain('feedback');
    expect(INSTRUMENTS.lead.funcLayout).not.toContain('carriers');
    expect(INSTRUMENTS.pad.layout).not.toContain('fmratio');
  });

  it('drum crush and drive keep the output bounded', () => {
    const d = new Drum(SR, SNARE_PARAMS, SNARE_VOICE);
    const sound = presetSound('snare', INSTRUMENTS.snare.presets.findIndex((p) => p.name === 'INDUSTRIAL'));
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

  it('a held note changing dynamic (slide ghost -> accent) moves its level smoothly', () => {
    const p = kickProject([]);
    const c = p.channels[4];
    c.sounds.bass = { ...c.sounds.bass!, drive: 1, crush: 0 };
    const a = c.patterns[0].steps[0];
    Object.assign(a, { active: true, note: 45, slide: true, velocity: DYNAMIC_VELOCITY.ghost });
    Object.assign(c.patterns[0].steps[1], { active: true, note: 45, accent: true, velocity: DYNAMIC_VELOCITY.accent });
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    const { l } = render(e, 0.25);
    // The biggest sample-to-sample step around the change vs. just before it.
    const jump = (from: number, to: number) => {
      let m = 0;
      for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(l[i] - l[i - 1]));
      return m;
    };
    expect(jump(6000, 6200)).toBeLessThan(jump(5000, 5990) * 2.5);
  });

  it('CRUSH lowers the sample rate smoothly (no jump at a whole-sample hold)', () => {
    const hat = (crush: number) => {
      const p = kickProject([]);
      p.channels[2].sounds.hat = { ...p.channels[2].sounds.hat!, crush };
      p.channels[2].patterns[0].steps[0].active = true;
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      return render(e, 0.1).l;
    };
    const clean = hat(0);
    const err = (c: number) => {
      const x = hat(c);
      let d = 0, n = 0;
      for (let i = 0; i < x.length; i++) { d += (x[i] - clean[i]) ** 2; n += clean[i] ** 2; }
      return Math.sqrt(d / n);
    };
    const errs = [0.17, 0.19, 0.2, 0.21, 0.23].map(err);
    for (let i = 1; i < errs.length; i++) expect(errs[i] / errs[i - 1]).toBeLessThan(1.6);
  });

  describe('pattern patches', () => {
    const specs = INSTRUMENTS.bass.params;
    const slot = (id: string) => specs.findIndex((q) => q.id === id);
    const coarse = specs.find((q) => q.coarse || q.options)!;
    const base = (e: Engine, id: string) => (e as unknown as { baseValue: Float32Array }).baseValue[4 * LOCK_SLOTS + slot(id)];
    /** BASS (track 5): pattern A cutoff 200 Hz, pattern B 2 kHz and another coarse setting. */
    const setup = () => {
      const p = kickProject([0]);
      const c = p.channels[4];
      c.sounds.bass = { ...c.sounds.bass!, cutoff: 200 };
      p.channels.forEach(initPatterns);
      c.patterns[1].patch = { sound: { ...c.sounds.bass, cutoff: 2000, [coarse.id]: coarse.max === c.sounds.bass[coarse.id] ? coarse.min : coarse.max }, trims: {} };
      return { p, e: engineWith(p), b: c.patterns[1].patch.sound };
    };

    it('glides from the switch to the loop end, coarse settings at the loop end', () => {
      const { e, b } = setup();
      const a = base(e, coarse.id);
      e.handleMessage({ type: 'transport', playing: true });
      render(e, 0.5); // 24000 of the 96000-frame loop
      e.handleMessage({ type: 'selectPattern', channel: 4, pattern: 1, immediate: false });
      render(e, 0.5); // a third of the way to the loop end
      const n = toNorm(specs[slot('cutoff')], base(e, 'cutoff'));
      const from = toNorm(specs[slot('cutoff')], 200);
      const to = toNorm(specs[slot('cutoff')], 2000);
      expect((n - from) / (to - from)).toBeGreaterThan(0.25);
      expect((n - from) / (to - from)).toBeLessThan(0.42);
      expect(base(e, coarse.id)).toBe(a);
      render(e, 1.1); // past the loop end
      expect(base(e, 'cutoff')).toBeCloseTo(2000, 3);
      expect(base(e, coarse.id)).toBe(b[coarse.id]);
    });

    it('glides back when the switch is cancelled', () => {
      const { e } = setup();
      e.handleMessage({ type: 'transport', playing: true });
      render(e, 0.25);
      e.handleMessage({ type: 'selectPattern', channel: 4, pattern: 1, immediate: false });
      render(e, 1);
      expect(base(e, 'cutoff')).toBeGreaterThan(300);
      e.handleMessage({ type: 'selectPattern', channel: 4, pattern: 0, immediate: false });
      render(e, 0.5);
      expect(base(e, 'cutoff')).toBeCloseTo(200, 3);
      render(e, 1.5); // the loop end passes: still pattern A
      expect(base(e, 'cutoff')).toBeCloseTo(200, 3);
    });

    it('switches at once when stopped, and edits only the pattern they name', () => {
      const { e } = setup();
      e.handleMessage({ type: 'setSound', channel: 4, pattern: 1, id: 'cutoff', value: 3000 });
      expect(base(e, 'cutoff')).toBeCloseTo(200, 3);
      e.handleMessage({ type: 'selectPattern', channel: 4, pattern: 1, immediate: false });
      expect(base(e, 'cutoff')).toBeCloseTo(3000, 3);
    });

    it('glides a song row change over the row\'s last bar', () => {
      const { e } = setup();
      e.handleMessage({ type: 'setSong', song: { rows: [{ bars: 2, patterns: [0, 0, 0, 0, 0, 0, 0, 0] }, { bars: 2, patterns: [0, 0, 0, 0, 1, 0, 0, 0] }] } });
      e.handleMessage({ type: 'transport', playing: true, song: true, fromRow: 0 });
      render(e, 2.1); // into bar 2 (the last of row 1)
      const mid = base(e, 'cutoff');
      expect(mid).toBeGreaterThan(200);
      expect(mid).toBeLessThan(2000);
      render(e, 2); // row 2
      expect(base(e, 'cutoff')).toBeCloseTo(2000, 3);
    });

    it('RESET with notes swaps a pattern\'s notes in at the next bar line', () => {
      const p = kickProject([]);
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      const first = render(e, 0.5).l;
      const steps = emptyPattern().steps;
      steps[0].active = true;
      e.handleMessage({ type: 'swapNotes', channel: 0, pattern: 0, length: 16, steps });
      near(onsets(render(e, 2).l), [96000 - first.length]);
    });
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

  it('live notes land where they were heard: the listen latency is allowed for', () => {
    // 120 BPM: a step is 6000 frames. A tap 5000 frames into step 0 goes to step 1 with no
    // latency, but heard 60 ms (2880 frames) late it was meant for step 0.
    const run = (ms: number) => {
      const e = engineWith(kickProject([]));
      const got: RecordedMsg[] = [];
      e.onRecorded = (m) => got.push(m);
      e.handleMessage({ type: 'setListenLatency', ms });
      e.handleMessage({ type: 'transport', playing: true });
      render(e, 5000 / SR);
      e.handleMessage({ type: 'recordNote', channel: 3, note: 40, velocity: 1, accent: false });
      render(e, 5500 / SR); // 10500 frames: step 2 by the engine, step 1 by ear
      e.handleMessage({ type: 'recordNote', channel: 3, note: 43, velocity: 1, accent: false });
      return got.map((m) => m.type === 'recordedNote' && m.index);
    };
    expect(run(0)).toEqual([1, 2]);
    expect(run(60)).toEqual([0, 1]);
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
    applyPreset(p.channels[5], 'pad', INSTRUMENTS.pad.presets.findIndex((x) => x.name === 'WARM'));
    p.channels[5].sounds.pad!.release = 0.02;
    p.channels[5].sounds.pad!.release2 = 0.02;
    p.channels[5].sounds.pad!.attack = 0.002;
    p.channels[5].fxSend = 0;
    p.channels[5].chord = 0;
    p.channels[5].patterns[0].steps[0].active = true;
    const plain = engineWith(p);
    p.channels[5].chord = CHORDS.findIndex((c) => c.name === 'MIN9');
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
      const d = new Drum(SR, KICK_PARAMS, KICK_VOICE);
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

  it('a track routed to a send gets that send\'s effects (FX 3 delay = 1/4 note)', () => {
    const dry = kickProject([0], { bpm: 120 });
    const wet = kickProject([0], { bpm: 120 });
    wet.channels[0].fxSend = 3;
    wet.channels[0].sendLevel = 1;
    wet.sendWet[2] = [1, 0, 0, 0, 0, 0]; // only the delay, full
    const tail = (p: Project) => {
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      return stats(render(e, 0.6).l.subarray(23000, 26000)).peak;
    };
    expect(tail(dry)).toBeLessThan(1e-4);
    expect(tail(wet)).toBeGreaterThan(0.01);
  });

  it('routing can be changed and removed live', () => {
    const p = kickProject([0], { bpm: 120 });
    p.sendWet[1] = [1, 0, 0, 0, 0, 0];
    const e = engineWith(p);
    e.handleMessage({ type: 'setRouting', channel: 0, send: 2 });
    e.handleMessage({ type: 'setMix', channel: 0, id: 'send', value: 1 });
    e.handleMessage({ type: 'transport', playing: true });
    render(e, 0.05);
    e.handleMessage({ type: 'setRouting', channel: 0, send: 0 });
    // FX 2's delay is 3/16 = 18000 frames: with the route removed right after the hit
    // the echo still comes (it was already in the delay line), so check nothing new feeds it.
    expect(stats(render(e, 1).l).nan).toBe(false);
  });

  it('CUTOFF (the sound filter) darkens the track', () => {
    const bright = (cutoff: number) => {
      const p = kickProject([], { bpm: 120 });
      p.channels[4].patterns[0].steps[0].active = true; // bass
      p.channels[4].sounds.bass = { ...p.channels[4].sounds.bass!, cutoff, fenv: 0 };
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      const { l } = render(e, 0.05);
      let d = 0;
      for (let i = 1; i < l.length; i++) d += (l[i] - l[i - 1]) ** 2;
      return d;
    };
    expect(bright(300)).toBeLessThan(bright(20000) * 0.25);
  });
});

describe('note lengths', () => {
  /** Lead track (mono, short release) with one note at step 0 of the given gate. */
  const leadProject = (gate: number) => {
    const p = kickProject([]);
    p.channels.forEach((c) => (c.fxSend = 0));
    const lead = p.channels[6];
    lead.sounds.lead = { ...presetSound('lead', 0), attack: 0.001, sustain: 1, sustain2: 1, release: 0.005, release2: 0.005 };
    lead.patterns[0].steps[0].active = true;
    lead.patterns[0].steps[0].gate = gate;
    return p;
  };
  const level = (l: Float32Array, from: number, to: number) => stats(l.subarray(from, to)).peak;

  it('a note lasts exactly one step by default', () => {
    const e = engineWith(leadProject(1));
    e.handleMessage({ type: 'transport', playing: true });
    const { l } = render(e, 0.3); // steps are 6000 frames
    expect(level(l, 4000, 5900)).toBeGreaterThan(0.01);
    expect(level(l, 7000, 11000)).toBeLessThan(0.002);
  });

  it('a tied note sustains until the step where it is released', () => {
    const e = engineWith(leadProject(3));
    e.handleMessage({ type: 'transport', playing: true });
    const { l } = render(e, 0.5);
    expect(level(l, 16000, 17900)).toBeGreaterThan(0.01); // still in step 2
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

  it('chorus stays bounded', () => {
    const ch = new Chorus(SR);
    ch.setParam('cho_return', 1);
    for (const out of [run(ch)]) {
      expect(stats(out.l).nan).toBe(false);
      expect(stats(out.l).peak).toBeGreaterThan(0.1);
      expect(stats(out.l).peak).toBeLessThan(2);
    }
  });
});

describe('LFO', () => {
  /** Pad holding a long note, on the LFO set as given; returns the output. */
  const padWithLfo = (lfo: { rate: number; shape: number; vol: number; pitch: number }, seconds: number, on = true) => {
    const p = kickProject([], { bpm: 120 });
    const pad = p.channels[5];
    pad.fxSend = 0;
    pad.chord = 0;
    pad.sounds.pad = { ...presetSound('pad', 0), attack: 0.001, sustain: 1, sustain2: 1, release: 0.01, release2: 0.01 };
    pad.patterns[0].steps[0].active = true;
    pad.patterns[0].steps[0].gate = 16;
    p.lfo = { ...p.lfo, ...lfo };
    pad.lfoOn = on;
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    return render(e, seconds).l;
  };

  it('volume modulation follows the tempo-synced rate (square, 1/4 = 24000 frames at 120 BPM)', () => {
    const l = padWithLfo({ rate: RATE('1/4'), shape: 1, vol: 1, pitch: 0 }, 1);
    const peak = (a: number, b: number) => stats(l.subarray(a, b)).peak;
    // Square starts high: first half-cycle (0-12000) loud, second (12000-24000) silent,
    // allowing ~1 ms for the track filters to ring out after the edge.
    expect(peak(6000, 12000)).toBeGreaterThan(0.01);
    expect(peak(13000, 24000)).toBeLessThan(1e-3);
    expect(peak(24000, 30000)).toBeGreaterThan(0.01); // next cycle
  });

  it('pitch modulation moves the pitch up and down', () => {
    const l = padWithLfo({ rate: RATE('1/4'), shape: 1, vol: 0, pitch: 12 }, 0.5);
    const zc = (a: number, b: number) => {
      let n = 0;
      for (let i = a + 1; i < b; i++) if (l[i - 1] < 0 && l[i] >= 0) n++;
      return n;
    };
    // High half (+12) vs low half (-12): about 4x the crossings.
    expect(zc(2000, 10000) / zc(14000, 22000)).toBeGreaterThan(3);
  });

  it('only tracks put on the LFO are modulated', () => {
    const l = padWithLfo({ rate: RATE('1/4'), shape: 1, vol: 1, pitch: 0 }, 1, false);
    expect(stats(l.subarray(13000, 24000)).peak).toBeGreaterThan(0.01);
  });

  it('old per-track LFOs become the shared LFO with those tracks on it', () => {
    const old = JSON.parse(JSON.stringify(toStored(createDefaultProject())));
    old.version = 7;
    delete old.lfo;
    for (const c of old.channels) { delete c.lfoOn; c.lfo = { rate: 4, shape: 0, vol: 0, pitch: 0 }; }
    old.channels[5].lfo = { rate: 7, shape: 5, vol: 0.4, pitch: 3 }; // old layout: track 6 = LEAD
    const p = fromStored(old)!;
    expect(p.channels.map((c) => c.lfoOn)).toEqual([false, false, false, false, false, false, true, false]); // now track 7
    expect(p.lfo).toMatchObject({ rate: RATE('1/8T'), shape: 5, vol: 0.4, pitch: 3 }); // old index 7 = 1/8T
  });

  it('every shape stays within -1..1', () => {
    for (let shape = 0; shape < 6; shape++) {
      for (let k = 0; k <= 100; k++) {
        const v = lfoValue(shape, k / 100, 0.3);
        expect(Math.abs(v)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('TIMBRE and INTENSITY macros', () => {
  const kinds = Object.keys(MACROS) as (keyof typeof MACROS)[];

  it('every anchor and excite parameter belongs to its track type', () => {
    for (const kind of kinds) {
      const ids = new Set(INSTRUMENTS[kind].params.map((p) => p.id));
      for (const a of MACROS[kind].anchors) for (const id in a.values) expect(ids.has(id), `${kind} ${a.name} ${id}`).toBe(true);
      for (const e of MACROS[kind].excite) expect(ids.has(e.id), `${kind} ${e.id}`).toBe(true);
    }
  });

  it('TIMBRE lands exactly on each named sound (intensity neutral)', () => {
    for (const kind of kinds) {
      const specs = INSTRUMENTS[kind].params;
      MACROS[kind].anchors.forEach((a, i) => {
        const out = macroSound(kind, anchorPosition(kind, i), 0.5, specs);
        for (const id in a.values) expect(out[id]).toBeCloseTo(a.values[id], 3);
      });
    }
  });

  it('every TIMBRE / INTENSITY position plays, finite and bounded', () => {
    for (const kind of kinds) {
      const entry = INSTRUMENTS[kind];
      for (const t of [0, 0.2, 0.5, 0.8, 1]) {
        for (const x of [0, 0.5, 1]) {
          const inst = entry.create(SR);
          const sound = macroSound(kind, t, x, entry.params);
          for (const id in sound) inst.setParam(id, sound[id]);
          const l = new Float32Array(SR / 2);
          inst.noteOn(entry.drum ? 36 : 45, 1, 45, false);
          inst.render(l, new Float32Array(l.length), 0, l.length);
          const st = stats(l);
          expect(st.nan, `${kind} t=${t} i=${x}`).toBe(false);
          expect(st.peak, `${kind} t=${t} i=${x}`).toBeGreaterThan(0.02);
          expect(st.peak, `${kind} t=${t} i=${x}`).toBeLessThan(2);
        }
      }
    }
  });

  it('turning INTENSITY down softens without making a hit weak', () => {
    for (const kind of kinds) {
      for (const t of [0, 0.5, 1]) {
        const level = (x: number) => {
          const entry = INSTRUMENTS[kind];
          const inst = entry.create(SR);
          const sound = macroSound(kind, t, x, entry.params);
          for (const id in sound) inst.setParam(id, sound[id]);
          const l = new Float32Array(SR / 10);
          inst.noteOn(entry.drum ? 36 : 45, 1, 45, false);
          inst.render(l, new Float32Array(l.length), 0, l.length);
          return stats(l).peak;
        };
        expect(level(0), `${kind} t=${t}`).toBeGreaterThan(level(0.5) * 0.4);
      }
    }
  });

  it('the snare starts as a high rimshot', () => {
    const rim = macroSound('snare', 0, 0.5, INSTRUMENTS.snare.params);
    const brk = macroSound('snare', anchorPosition('snare', MACROS.snare.anchors.findIndex((a) => a.name === 'BREAK')), 0.5, INSTRUMENTS.snare.params);
    expect(rim.t_pitch).toBeGreaterThan(brk.t_pitch);
  });

  it('TIMBRE never changes tail lengths or the CHORD / LEAD amp ADSR: they are the type\'s own', () => {
    const tails = ['t_decay', 'm_decay', 'detune', 'unison', 'attack', 'attack2', 'decay', 'decay2', 'sustain', 'sustain2', 'release', 'release2'];
    for (const k of SOUND_KINDS.filter((k) => k !== 'bass' && k !== 'pluck')) {
      const ids = macroIds(k, INSTRUMENTS[k].params);
      for (const id of tails) expect(ids.has(id), `${k} ${id}`).toBe(false);
      for (const e of MACROS[k].excite) expect(tails.includes(e.id), `${k} INTENSITY ${e.id}`).toBe(false);
    }
  });

  it('BASS and PLUCK sounds bring their own envelope and width', () => {
    for (const k of ['bass', 'pluck'] as const) {
      const specs = INSTRUMENTS[k].params;
      const sounds = [0, 0.25, 0.5, 0.75, 1].map((t) => macroSound(k, t, 0.5, specs));
      expect(new Set(sounds.map((s) => s.decay.toFixed(3))).size, `${k} decay`).toBeGreaterThan(2);
      expect(new Set(sounds.map((s) => s.detune.toFixed(3))).size, `${k} detune`).toBeGreaterThan(1);
      // One envelope for both oscillators: no OSC 2 envelope knobs of their own.
      for (const id of ['attack2', 'decay2', 'sustain2', 'release2']) expect(specs.some((p) => p.id === id), `${k} ${id}`).toBe(false);
    }
  });
});

describe('RING and REST', () => {
  const level = (l: Float32Array, a: number, b: number) => stats(l.subarray(a, b)).peak;

  it('a RING hat rings long (open hat) and is choked by the next hit', () => {
    const run = (ring: boolean, nextHitAt: number) => {
      const p = kickProject([], { bpm: 120 });
      const hat = p.channels[2];
      hat.fxSend = 0;
      hat.patterns[0].steps[0].active = true;
      hat.patterns[0].steps[0].ring = ring;
      if (nextHitAt >= 0) hat.patterns[0].steps[nextHitAt].active = true;
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      return render(e, 0.5).l;
    };
    // Closed hat (0.05 s) has died by ~0.15 s; the ringing one (~0.4 s) is still sounding.
    const closed = run(false, -1);
    const open = run(true, -1);
    expect(level(closed, 6000, 8000)).toBeLessThan(level(closed, 0, 1000) * 0.01);
    expect(level(open, 6000, 8000)).toBeGreaterThan(level(open, 0, 1000) * 0.03);
    // A closed hit at step 1 (6000) chokes the open hat: once that short hit has died
    // away, nothing of the open hat is left, unlike when it rings on uninterrupted.
    expect(level(run(true, 1), 9500, 11500)).toBeLessThan(level(run(true, -1), 9500, 11500) * 0.2);
  });

  it('a RING synth note holds over empty steps until a rest', () => {
    const p = kickProject([], { bpm: 120 });
    p.channels.forEach((c) => (c.fxSend = 0));
    const lead = p.channels[6];
    lead.sounds.lead = { ...presetSound('lead', 0), attack: 0.001, sustain: 1, sustain2: 1, release: 0.005, release2: 0.005 };
    lead.patterns[0].steps[0].active = true;
    lead.patterns[0].steps[0].ring = true;
    lead.patterns[0].steps[5].rest = true;
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    const { l } = render(e, 0.8);
    expect(level(l, 26000, 29900)).toBeGreaterThan(0.01); // still ringing in step 4
    expect(level(l, 31000, 40000)).toBeLessThan(0.002); // stopped by the rest at step 5
  });
});

describe('send intensity', () => {
  it('delay intensity sets the feedback (more repeats)', () => {
    const tail = (intensity: number) => {
      const p = kickProject([0], { bpm: 120 });
      p.channels[0].fxSend = 3; // FX 3: delay 1/4 = 24000 frames
      p.channels[0].sendLevel = 1;
      p.sendWet[2] = [1, 0, 0, 0, 0, 0];
      p.sendInt[2][0] = intensity;
      p.channels[0].patterns[0].steps.forEach((s) => (s.active = false));
      p.channels[0].patterns[0].steps[0].active = true;
      p.channels[0].patterns[0].length = 64; // only one kick in the window
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      return stats(render(e, 2.2).l.subarray(95000, 98000)).peak; // 4th repeat
    };
    expect(tail(0.9)).toBeGreaterThan(tail(0.1) * 5);
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
    p.channels[4].patterns[1].length = 32;
    const s = p.channels[4].patterns[1].steps[20];
    Object.assign(s, { active: true, note: 41, gate: 3, velocity: 0.45, locks: { cutoff: 900 } });
    p.channels[5].fxSend = 3;
    p.channels[5].sendLevel = 0.7;
    p.sendWet[2][3] = 0.9;
    p.sendComp[1].cmp_ratio = 4;
    p.sendComp[2].cmp_thresh = -30;
    p.sendInt[1][0] = 0.8;
    p.fx1.rev_len = 3;
    p.fx1.flt = 0.3;
    p.channels[4].fx1 = true;
    p.lfo = { rate: 7, shape: 5, morph: 0.3, fm: 0.4, vol: 0.4, pitch: 3, filter: 2, pan: 0.5, phase: 0.25, smooth: 0.3, fade: 1, retrig: 1, send: 0.6, spread: 0.5 };
    p.channels[6].lfoOn = true;
    p.channels[2].patterns[0].steps[6].active = true;
    p.channels[2].patterns[0].steps[6].ring = true;
    p.channels[2].patterns[0].steps[9].rest = true;
    p.channels[5].chord = 6;
    p.channels[1].mute = true;
    return p;
  };

  it('survives a round trip through the stored format', () => {
    const p = busy();
    p.channels.forEach(initPatterns);
    lockProject(p);
    expect(fromStored(JSON.parse(JSON.stringify(toStored(p))))).toEqual(p);
  });

  it('keeps each pattern its own patch and its unsaved edits through the stored format', () => {
    const p = busy();
    p.channels.forEach(initPatterns);
    lockProject(p);
    const c = p.channels[4];
    editPattern(c, 1);
    c.sounds.bass!.cutoff = 333;
    c.patterns[1].patchDirty = true;
    c.patterns[1].steps[3].active = true;
    c.patterns[1].notesDirty = true;
    editPattern(c, 0);
    expect(patchOf(c, 1).sound.cutoff).toBe(333);
    expect(patchOf(c, 0).sound.cutoff).not.toBe(333);
    const back = fromStored(JSON.parse(JSON.stringify(toStored(p))))!;
    expect(back).toEqual(p);
    expect(back.channels[4].patterns[1].savedPatch!.sound.cutoff).not.toBe(333);
    expect(back.channels[4].patterns[1].savedNotes!.steps[3].active).toBe(false);
  });

  it('gives every pattern of an older project the track sound, saved as it is', () => {
    const stored = toStored(busy()) as unknown as { version: number; channels: { patterns: Record<string, unknown>[] }[] };
    stored.version = 30;
    for (const c of stored.channels) for (const pat of c.patterns) delete pat.patch;
    const p = fromStored(JSON.parse(JSON.stringify(stored)))!;
    const c = p.channels[4];
    for (let i = 0; i < NUM_PATTERNS; i++) {
      expect(patchOf(c, i).sound).toEqual(c.sounds.bass);
      expect(c.patterns[i].notesDirty).toBe(false);
      expect(c.patterns[i].patchDirty).toBe(false);
    }
  });

  it('stores only steps with notes (compact)', () => {
    const stored = toStored(busy());
    const total = stored.channels.reduce((n, c) => n + c.patterns.reduce((m, pat) => m + pat.steps.length, 0), 0);
    expect(total).toBe(3 + 2); // + the ring hit and the rest marker
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
    expect(loaded.channels[4].patterns[1].steps[20]).toMatchObject({ active: true, note: 41, gate: 3 });
    expect(loaded.channels[4].patterns[1].length).toBe(32);
    expect(loaded.channels[1].mute).toBe(true);
  });

  it('maps old chord numbers and send amounts into the v6 model', () => {
    const old = JSON.parse(JSON.stringify(toStored(createDefaultProject())));
    old.version = 5;
    old.channels[4].chord = 4; // MIN9 in the v5 list (old layout: track 5 = PAD)
    old.sendFx = old.sendWet;
    delete old.sendWet;
    delete old.sendInt;
    old.sendFx[0][0] = 0.33; // the old dub delay send is today's FX 2
    const p = fromStored(old)!;
    expect(CHORDS[p.channels[5].chord].name).toBe('MIN9');
    expect(p.sendWet[1][0]).toBe(0.33);
    expect(p.sendInt[1][0]).toBe(0.5);
  });

  it('maps the old per-effect sends onto the new routing', () => {
    const old = JSON.parse(JSON.stringify(toStored(createDefaultProject())));
    for (const c of old.channels) { delete c.fxSend; delete c.sendLevel; c.sends = [0, 0, 0, 0, 0, 0]; }
    old.channels[5].sends[4] = 0.3; // reverb
    old.channels[6].sends[0] = 0.4; // delay
    old.channels[2].sends[1] = 0.6; // distortion
    const p = fromStored(old)!;
    expect([p.channels[5].fxSend, p.channels[6].fxSend, p.channels[2].fxSend, p.channels[0].fxSend]).toEqual([3, 2, 3, 0]);
    expect(p.channels[6].sendLevel).toBe(0.4);
  });

  it('projects before v15 take each type\'s default live knobs; later choices are kept', () => {
    const old = { ...toStored(createDefaultProject()), version: 14 };
    old.channels[0].live = ['mix:volume', 'mix:cutoff'];
    old.channels[0].liveOffset = { t_decay: 0.5 };
    old.channels[0].liveFunc = ['mix:pan', 'mix:send'];
    const k = fromStored(old)!.channels[0];
    expect(k.live).toEqual(['macro:attack', 'macro:decay']);
    expect(k.liveFunc).toEqual(['mix:volume', 'macro:grit']);
    const now = toStored(createDefaultProject());
    now.channels[0].live = ['t_decay', 'mix:pan'];
    expect(fromStored(now)!.channels[0].live).toEqual(['t_decay', 'mix:pan']);
  });

  it('the start project holds the sequence in progress, with each type\'s live knobs (VOLUME on FUNC)', () => {
    const p = createStartProject();
    expect(p.channels[4].patterns[0].length).toBe(64);
    expect(p.channels.some((c) => c.patterns.some((pat) => pat.steps.some((st) => st.active)))).toBe(true);
    expect(p.channels[4].live).toEqual(['cutoff', 'macro:env']);
    // PLUCK: SUSTAIN / SPACE with FUNC (its VOLUME is on the MIX page).
    expect(p.channels.every((c) => c.liveFunc[0] === (c.instrument === 'pluck' ? 'macro:sustain' : 'mix:volume'))).toBe(true);
    // Every synth's first live knob is its CUTOFF.
    expect(p.channels.filter((c) => !isDrum(c.instrument)).every((c) => c.live[0] === 'cutoff')).toBe(true);
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
    expect(p.channels[1].fxSend).toBe(0);
    expect(p.sendWet).toHaveLength(3);
  });

  it('rejects data with no channels', () => {
    expect(fromStored({ version: 99 })).toBeNull();
    expect(fromStored(null)).toBeNull();
    expect(fromStored('nonsense')).toBeNull();
  });
});

describe('FX 1 drum bus', () => {
  const withBus = (fx1: Record<string, number>, steps = [4]) => {
    const p = kickProject(steps, { bpm: 120, length: 64 });
    p.channels[0].fx1 = true;
    Object.assign(p.fx1, fx1);
    return p;
  };

  it('is transparent at its defaults (drums route through it)', () => {
    const through = render((() => { const e = engineWith(withBus({})); e.handleMessage({ type: 'transport', playing: true }); return e; })(), 0.8).l;
    const direct = withBus({});
    direct.channels[0].fx1 = false;
    const e = engineWith(direct);
    e.handleMessage({ type: 'transport', playing: true });
    const plain = render(e, 0.8).l;
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff = Math.max(diff, Math.abs(plain[i] - through[i]));
    expect(stats(plain).peak).toBeGreaterThan(0.05);
    expect(diff).toBeLessThan(1e-4);
  });

  /** The bus's wet signal (with REVERSE settings) for a short decaying burst at t = 0. */
  const reverseWet = (fx: Record<string, number>, seconds: number) => {
    const run = (mix: number) => {
      const bus = new DrumBus(SR);
      bus.setClock(0, 1 / 6000); // 120 BPM
      for (const [id, v] of Object.entries({ ...fx, rev_mix: mix })) bus.setParam(id, v);
      bus.settle();
      const n = Math.round(SR * seconds);
      const x = Float32Array.from({ length: n }, (_, i) => (i < 4800 ? Math.sin(i * 0.3) * Math.exp(-i / 700) : 0));
      const out = new Float32Array(n);
      for (let o = 0; o < n; o += 128) bus.process(x.subarray(o, o + 128), x.subarray(o, o + 128), out.subarray(o, o + 128), new Float32Array(128), 0, Math.min(128, n - o));
      return out;
    };
    const dry = run(0);
    const wet = run(1);
    return wet.map((v, i) => v - dry[i]);
  };

  it('REVERSE plays slices backwards: a hit swells in instead of starting hard', () => {
    const len = REVERSE_LENGTHS.findIndex((g) => g.name === '1/8'); // 12000 frames
    const w = reverseWet({ rev_len: len, rev_fdbk: 0, rev_smear: 0 }, 1);
    const env = (a: number) => stats(w.subarray(a, a + 480)).peak;
    let peakAt = 0;
    for (let a = 0; a < w.length - 480; a += 480) if (env(a) > env(peakAt)) peakAt = a;
    let firstAt = 0;
    while (env(firstAt) < env(peakAt) * 0.1) firstAt += 480;
    expect(env(peakAt)).toBeGreaterThan(0.05);
    expect(peakAt - firstAt).toBeGreaterThan(SR * 0.02); // rises over 20 ms+ (a forward hit peaks at once)
  });

  it('REV FDBK keeps reversed echoes going; SMEAR stays bounded', () => {
    const len = REVERSE_LENGTHS.findIndex((g) => g.name === '1/16');
    const late = (fx: Record<string, number>) => stats(reverseWet({ rev_len: len, ...fx }, 1.5).subarray(SR, SR * 1.5)).peak;
    expect(late({ rev_fdbk: 0.9, rev_smear: 0 })).toBeGreaterThan(late({ rev_fdbk: 0, rev_smear: 0 }) * 5 + 1e-4);
    const smeared = reverseWet({ rev_len: len, rev_fdbk: 1.1, rev_smear: 1 }, 2);
    expect(stats(smeared).nan).toBe(false);
    expect(stats(smeared).peak).toBeLessThan(4);
  });

  it('the low-pass darkens what passes through; DRIVE stays bounded', () => {
    const energy = (fx1: Record<string, number>) => {
      const p = withBus(fx1, []);
      p.channels[2].fx1 = true;
      p.channels[2].patterns[0].steps[0].active = true; // hat
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      const { l } = render(e, 0.3);
      return { e: l.reduce((a, v) => a + v * v, 0), s: stats(l) };
    };
    expect(energy({ flt: 0.15 }).e).toBeLessThan(energy({}).e * 0.2);
    const loud = energy({ dst_drive: 60, dst_level: 2, lp_reso: 1, flt: 0.3 });
    expect(loud.s.nan).toBe(false);
    expect(loud.s.peak).toBeLessThanOrEqual(1);
  });

  it('a lone bus keeps working with odd input (no NaN at extreme settings)', () => {
    const bus = new DrumBus(SR);
    for (const [id, v] of Object.entries({ rev_mix: 1, rev_len: 0, rev_fdbk: 1.1, rev_smear: 1, dst_drive: 60, dst_crush: 1, lp_env: 1, lp_reso: 1 })) bus.setParam(id, v);
    const n = 4096;
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.05) * 2);
    const out = new Float32Array(n);
    bus.setClock(0, 1 / 6000);
    for (let k = 0; k < 30; k++) bus.process(x, x, out, out, 0, n);
    expect(stats(out).nan).toBe(false);
  });
});

describe('drum element envelopes', () => {
  const hit = (sound: Record<string, number>) => {
    const d = new Drum(SR, KICK_PARAMS, KICK_VOICE);
    const base = presetSound('kick', 1);
    for (const id in base) d.setParam(id, base[id]);
    for (const id in sound) d.setParam(id, sound[id]);
    d.noteOn(36, 1, 36);
    const l = new Float32Array(SR * 2);
    d.render(l, new Float32Array(SR * 2), 0, l.length);
    return l;
  };
  it('each element has its own ATTACK and DECAY', () => {
    const tailOf = (l: Float32Array) => stats(l.subarray(SR * 0.6, SR * 0.7)).peak;
    expect(tailOf(hit({ t_decay: 4 }))).toBeGreaterThan(tailOf(hit({})) * 10 + 1e-4);
    const start = (l: Float32Array) => stats(l.subarray(0, 480)).peak;
    expect(start(hit({ t_attack: 0.2, c_attack: 0.2 }))).toBeLessThan(start(hit({})) * 0.2);
    // A slow tone attack still peaks later (the attack rises, then the decay starts).
    expect(stats(hit({ t_attack: 0.2, c_level: 0 }).subarray(SR * 0.18, SR * 0.22)).peak).toBeGreaterThan(0.3);
  });

});

describe('slides and rolls', () => {
  it('consecutive ROLL steps roll as one run at ROLL RATE, ramping from the first step to the last', () => {
    const p = kickProject([0, 1, 2, 3, 6], { bpm: 120 });
    p.channels[0].sounds.kick = { ...p.channels[0].sounds.kick, t_decay: 0.01, c_level: 0, rolldiv: 1 }; // 1:2
    const steps = p.channels[0].patterns[0].steps;
    for (const i of [0, 1, 2, 3]) steps[i].slide = true;
    Object.assign(steps[0], { velocity: DYNAMIC_VELOCITY.ghost });
    Object.assign(steps[3], { velocity: DYNAMIC_VELOCITY.accent, accent: true });
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    const l = render(e, 0.8).l;
    // 4 steps x 2 = 8 hits, 3000 frames apart, then the plain hit on step 7.
    near(onsets(l, 0.005, 1500), [0, 3000, 6000, 9000, 12000, 15000, 18000, 21000, 36000]);
    const peak = (at: number) => stats(l.subarray(at, at + 500)).peak;
    expect(peak(21000)).toBeGreaterThan(peak(0) * 1.3); // ghost ... accent: a crescendo
    expect(peak(12000)).toBeGreaterThan(peak(0));
    expect(peak(12000)).toBeLessThan(peak(21000));
  });

  it('a run rolls evenly straight through swing', () => {
    const p = kickProject([0, 1], { bpm: 120, swing: 66 });
    p.channels[0].sounds.kick = { ...p.channels[0].sounds.kick, t_decay: 0.01, c_level: 0, rolldiv: 1 };
    for (const i of [0, 1]) p.channels[0].patterns[0].steps[i].slide = true;
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    near(onsets(render(e, 0.2).l, 0.005, 1500).slice(0, 4), [0, 3000, 6000, 9000], 8);
  });

  const bass = () => {
    const s = new Synth(SR, INSTRUMENTS.bass.params, BASS_FIXED);
    for (const [id, v] of Object.entries({ shape: 0, fm: 0, sub: 0, detune: 0, cutoff: 20000, fenv: 0, sustain: 1, glide: 0.06, drive: 1 })) s.setParam(id, v);
    return s;
  };
  const crossings = (s: Synth, seconds: number) => {
    const n = Math.round(SR * seconds);
    const l = new Float32Array(n);
    s.render(l, new Float32Array(n), 0, n);
    let c = 0;
    for (let i = 1; i < n; i++) if ((l[i - 1] < 0) !== (l[i] < 0)) c++;
    return c;
  };

  it('a SLIDE glides the held voice to the new pitch instead of jumping', () => {
    const jump = bass();
    jump.noteOn(45, 1, 45);
    crossings(jump, 0.2);
    jump.noteOn(57, 1, 57);
    const slide = bass();
    slide.noteOn(45, 1, 45);
    crossings(slide, 0.2);
    slide.noteOn(57, 1, 57, false, 45);
    const early = (s: Synth) => crossings(s, 0.02);
    expect(early(slide)).toBeLessThan(early(jump) * 0.85);
    expect(crossings(slide, 0.1)).toBeGreaterThan(crossings(bass(), 0) + 15); // arrives up there
  });

  it('a sequenced SLIDE glides from the held note into the next step', () => {
    const p = kickProject([], { bpm: 120 });
    const b = p.channels[4];
    b.sounds.bass = { ...b.sounds.bass!, shape: 0, fm: 0, sub: 0, detune: 0, cutoff: 20000, fenv: 0, sustain: 1, glide: 0.06, drive: 1 };
    const pat = b.patterns[0];
    Object.assign(pat.steps[0], { active: true, note: 45, gate: 1, slide: true }); // slides into step 2
    Object.assign(pat.steps[1], { active: true, note: 57, gate: 1 });
    b.fxSend = 0;
    const crossingsAfterBoundary = (slide: boolean) => {
      pat.steps[0].slide = slide;
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      const l = render(e, 0.2).l.subarray(6000, 6960); // first 20 ms of step 2
      let c = 0;
      for (let i = 1; i < l.length; i++) if ((l[i - 1] < 0) !== (l[i] < 0)) c++;
      return c;
    };
    expect(crossingsAfterBoundary(true)).toBeLessThan(crossingsAfterBoundary(false) * 0.85);
  });

  it('on drum tracks the SLIDE flag is ROLL at the sound\'s ROLL RATE (hits per step)', () => {
    const p = kickProject([0, 4], { bpm: 120 });
    p.channels[0].sounds.kick = { ...p.channels[0].sounds.kick, t_decay: 0.01, c_level: 0, rolldiv: 2 }; // 1:3
    Object.assign(p.channels[0].patterns[0].steps[0], { slide: true });
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    near(onsets(render(e, 0.6).l, 0.005, 1500), [0, 2000, 4000, 24000]);
    // ROLL RATE changes the roll.
    const e2 = engineWith(p);
    e2.handleMessage({ type: 'setSound', channel: 0, id: 'rolldiv', value: 1 }); // 1:2
    e2.handleMessage({ type: 'transport', playing: true });
    const o2 = onsets(render(e2, 0.6).l, 0.005, 1500);
    near(o2, [0, 3000, 24000]);
  });

  it('a mono note that is not a SLIDE starts on pitch (SLIDE time only applies to slides)', () => {
    const slow = bass();
    slow.setParam('glide', 0.5);
    slow.noteOn(45, 1, 45);
    crossings(slow, 0.2);
    slow.noteOn(57, 1, 57);
    const fast = bass();
    fast.noteOn(45, 1, 45);
    crossings(fast, 0.2);
    fast.noteOn(57, 1, 57);
    expect(Math.abs(crossings(slow, 0.05) - crossings(fast, 0.05))).toBeLessThanOrEqual(1);
  });

  it('a slide is one held note: full level through the slide and the note it lands on, until released', () => {
    const stab = () => {
      const s = bass();
      s.setParam('decay', 0.05);
      s.setParam('decay2', 0.05);
      s.setParam('sustain', 0);
      return s;
    };
    const level = (s: Synth, seconds: number) => {
      const n = Math.round(SR * seconds);
      const l = new Float32Array(n);
      s.render(l, new Float32Array(n), 0, n);
      return stats(l.subarray(n - 2000)).peak;
    };
    const plain = stab();
    plain.noteOn(45, 1, 45);
    const held = stab();
    held.noteOn(45, 1, 45, false, -1, true);
    expect(level(plain, 0.3)).toBeLessThan(0.02);
    expect(level(held, 0.3)).toBeGreaterThan(0.2);
    held.noteOn(52, 1, 52, false, 45); // lands, not sliding on: still held
    expect(level(held, 0.4)).toBeGreaterThan(0.2);
    held.noteOff(52);
    expect(level(held, 0.4)).toBeLessThan(0.02);
  });

  it('older projects keep their slide time (GLIDE 0 used to mean a 60 ms slide)', () => {
    const p = createDefaultProject();
    p.channels[4].sounds.bass = { ...p.channels[4].sounds.bass!, glide: 0 };
    const old = JSON.parse(JSON.stringify(toStored(p)));
    old.version = 12;
    expect(fromStored(old)!.channels[4].sounds.bass!.glide).toBeCloseTo(0.06);
    expect(fromStored(JSON.parse(JSON.stringify(toStored(p))))!.channels[4].sounds.bass!.glide).toBe(0);
  });

  it('slides and rolls survive the stored format', () => {
    const p = createDefaultProject();
    Object.assign(p.channels[4].patterns[0].steps[2], { active: true, note: 50, slide: true });
    Object.assign(p.channels[1].patterns[0].steps[5], { active: true, roll: 4 });
    expect(fromStored(JSON.parse(JSON.stringify(toStored(p))))!.song).toEqual(p.song);
  });
});

describe('synth elements', () => {
  it('OSC 1 and OSC 2 have their own ATTACK (a slow OSC 2 swells in under OSC 1)', () => {
    const level = (attack2: number, at: number) => {
      const s = new Synth(SR, INSTRUMENTS.bass.params, { voice: 1 });
      for (const [id, v] of Object.entries({ shape: 0, fm: 0, sub: 0, detune: 0, cutoff: 20000, fenv: 0, sustain: 1, drive: 1, attack: 0.001, attack2 })) s.setParam(id, v);
      s.noteOn(57, 1, 57);
      const l = new Float32Array(SR);
      s.render(l, new Float32Array(SR), 0, SR);
      return stats(l.subarray(at, at + 2000)).peak;
    };
    expect(level(1, 2000)).toBeLessThan(level(0.001, 2000) * 0.7); // OSC 2 still rising
    expect(level(1, 46000)).toBeGreaterThan(level(0.001, 46000) * 0.9); // both in
  });
});

describe('LFO options', () => {
  const pad = (lfo: Partial<Project['lfo']>, notes: number[]) => {
    const p = kickProject([], { bpm: 120 });
    const c = p.channels[5];
    c.fxSend = 0;
    c.chord = 0;
    c.sounds.pad = { ...presetSound('pad', 0), attack: 0.001, attack2: 0.001, sustain: 1, sustain2: 1, release: 0.01, release2: 0.01 };
    for (const s of notes) Object.assign(c.patterns[0].steps[s], { active: true, gate: 2 });
    p.lfo = { ...p.lfo, rate: RATE('1/4'), shape: 1, vol: 1, ...lfo }; // square, 1/4 = 24000 frames
    c.lfoOn = true;
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    return render(e, 0.6).l;
  };
  const peak = (l: Float32Array, a: number, b: number) => stats(l.subarray(a, b)).peak;

  it('RETRIG NOTE restarts the LFO on each note', () => {
    expect(peak(pad({ retrig: 0 }, [0, 2]), 13000, 23000)).toBeLessThan(1e-3); // song-locked: low half
    expect(peak(pad({ retrig: 1 }, [0, 2]), 13000, 23000)).toBeGreaterThan(0.01); // restarted: high half
  });

  it('FADE IN brings the modulation in gradually', () => {
    expect(peak(pad({ fade: 4 }, [0, 2]), 13000, 23000)).toBeGreaterThan(0.01);
  });
});

describe('hat head and RING', () => {
  const hat = (name: string, ring = false, extra: Record<string, number> = {}) => {
    const d = new Drum(SR, HAT_PARAMS, HAT_VOICE);
    const sound: Record<string, number> = { ...presetSound('hat', INSTRUMENTS.hat.presets.findIndex((p) => p.name === name)), c_level: 0, ...extra };
    for (const id in sound) d.setParam(id, sound[id]);
    d.noteOn(36, 1, 36, ring);
    const l = new Float32Array(SR * 2);
    d.render(l, new Float32Array(SR * 2), 0, l.length);
    return l;
  };
  const diff = (a: Float32Array, b: Float32Array, from: number, to: number) => {
    let d = 0, e = 0;
    for (let i = from; i < to; i++) { d += (a[i] - b[i]) ** 2; e += a[i] ** 2 + b[i] ** 2; }
    return d / e;
  };

  it('every hat timbre starts as a hat; the tail is the cymbal', () => {
    const h = hat('HAT', false, { m_decay: 2 });
    const c = hat('CRASH', false, { m_decay: 2 });
    expect(diff(h, c, 0, 240)).toBeLessThan(diff(h, c, 9600, 12000) * 0.5);
  });

  it('RING adds the type\'s fixed extension to the decay (not a blown-out multiple)', () => {
    const tail = (l: Float32Array, t: number) => stats(l.subarray(SR * t, SR * t + 2400)).peak;
    const plain = hat('HAT', false);
    const ring = hat('HAT', true);
    expect(tail(plain, 0.3)).toBeLessThan(1e-3);
    expect(tail(ring, 0.3)).toBeGreaterThan(1e-3); // an open hat
    expect(tail(ring, 1.9)).toBeLessThan(tail(ring, 0.3) * 0.1); // ... fading out
  });
});

describe('ETHEREAL chord', () => {
  const chord = (name: string) => {
    const s = new Synth(SR, PAD_PARAMS, PAD_FIXED);
    const sound: Record<string, number> = { ...presetSound('pad', INSTRUMENTS.pad.presets.findIndex((p) => p.name === name)), sustain: 0.8, sustain2: 0.8 };
    for (const id in sound) s.setParam(id, sound[id]);
    for (const n of [57, 60, 64, 67]) s.noteOn(n, 0.8, 57);
    const l = new Float32Array(SR);
    s.render(l, new Float32Array(SR), 0, l.length);
    return { sound, l };
  };
  // Share of high-frequency energy (sample-to-sample differences against the signal).
  const brightness = (l: Float32Array) => {
    let d = 0, e = 0;
    for (let i = 1; i < l.length; i++) { d += (l[i] - l[i - 1]) ** 2; e += l[i] ** 2; }
    return d / e;
  };

  it('a 7x modulator over the body, stack 2 at 3x under 5x: a high shimmer, rendering cleanly', () => {
    const { sound, l } = chord('ETHEREAL');
    expect([sound.fmratio, sound.ratio2, sound.ratio3]).toEqual([7, 3, 5]);
    const st = stats(l);
    expect(st.nan).toBe(false);
    expect(st.peak).toBeGreaterThan(0.05);
    expect(st.peak).toBeLessThan(3);
    // The brightest of the bells (STRINGS is a saw: bright in another way).
    for (const other of ['WARM', 'TINE', 'GLASS']) expect(brightness(l), other).toBeGreaterThan(brightness(chord(other).l));
  });

  it('width is the type\'s own: every sound has the same DETUNE / UNISON', () => {
    for (const p of INSTRUMENTS.pad.presets) {
      const s = presetSound('pad', INSTRUMENTS.pad.presets.indexOf(p));
      expect([s.detune, s.unison], p.name).toEqual([0.25, 0]);
    }
  });
});

describe('no stab rule: SUSTAIN and RELEASE do what they say', () => {
  const padChord = (decay: number, releaseAt = SR) => {
    const s = new Synth(SR, PAD_PARAMS, PAD_FIXED);
    const sound = presetSound('pad', INSTRUMENTS.pad.presets.findIndex((p) => p.name === 'WARM'));
    for (const id in sound) s.setParam(id, sound[id]);
    s.setParam('attack', 0.001); s.setParam('attack2', 0.001);
    s.setParam('sustain', 0.8); s.setParam('sustain2', 0.8); // a held pad (CHORD defaults to stabs)
    s.setParam('decay', decay); s.setParam('decay2', decay);
    for (const n of [57, 60, 64]) s.noteOn(n, 1, 57);
    const l = new Float32Array(SR * 2);
    s.render(l, new Float32Array(SR * 2), 0, releaseAt);
    s.noteOff(57);
    s.render(l, new Float32Array(SR * 2), releaseAt, l.length);
    return l;
  };
  const at = (l: Float32Array, t: number) => stats(l.subarray(Math.round(SR * t), Math.round(SR * t) + 960)).peak;

  it('a short DECAY falls to SUSTAIN and holds there; RELEASE is as set', () => {
    const held = padChord(1.2);
    const short = padChord(0.1);
    expect(at(short, 0.5)).toBeGreaterThan(0.05);
    expect(at(short, 0.5)).toBeGreaterThan(at(held, 0.5) * 0.5);
    // Released at 50 ms: WARM's own RELEASE rings it out, not the short DECAY.
    const early = padChord(0.1, SR * 0.05);
    expect(at(early, 0.1)).toBeGreaterThan(1e-3);
  });
});

describe('bar position (for RESET)', () => {
  it('runs 0..1 over 16 steps and wraps', () => {
    const e = engineWith(kickProject([], { bpm: 120 })); // 6000 frames per step
    expect(e.barPhase).toBe(0);
    e.handleMessage({ type: 'transport', playing: true });
    render(e, 0.25); // 12000 frames = 2 steps
    expect(e.barPhase).toBeCloseTo(2 / 16, 1);
    render(e, 1.75); // 96000 frames total = 16 steps
    const p = e.barPhase; // at the bar line: just before or just after the wrap
    expect(Math.min(p, 1 - p)).toBeLessThan(0.01);
  });
});

describe('notes held past the loop end', () => {
  it('a note tied over the end of a 16-step loop keeps sounding into the next bar', () => {
    const p = kickProject([], { bpm: 120 }); // 6000 frames per step, loop = 96000
    const b = p.channels[4];
    b.fxSend = 0;
    b.sounds.bass = { ...b.sounds.bass!, attack: 0.002, attack2: 0.002, decay: 5, decay2: 5, sustain: 1, sustain2: 1, release: 0.005, release2: 0.005 };
    Object.assign(b.patterns[0].steps[14], { active: true, note: 45, gate: 4 }); // steps 14, 15, 0, 1
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    const { l } = render(e, 2.6);
    const level = (a: number) => stats(l.subarray(a, a + 2000)).peak;
    expect(level(97000)).toBeGreaterThan(0.05); // step 0 of the second time round: still held
    expect(level(104000)).toBeGreaterThan(0.05); // step 1
    expect(level(110000)).toBeLessThan(1e-3); // released at step 2
  });
});

describe('pattern D', () => {
  it('older 3-pattern saves load with an empty D; D plays when selected', () => {
    const p = kickProject([0]);
    const old = JSON.parse(JSON.stringify(toStored(p)));
    for (const c of old.channels) c.patterns = c.patterns.slice(0, 3);
    const loaded = fromStored(old)!;
    expect(loaded.channels[0].patterns).toHaveLength(4);
    expect(loaded.channels[0].patterns[3].steps.some((s) => s.active)).toBe(false);
    loaded.channels[0].patterns[3].steps[2].active = true;
    const e = engineWith(loaded);
    e.handleMessage({ type: 'selectPattern', channel: 0, pattern: 3, immediate: true });
    e.handleMessage({ type: 'transport', playing: true });
    near(onsets(render(e, 0.5).l), [12000]);
  });
});

describe('PERC track', () => {
  it('is pitched from the sequencer (keyboard step entry) and has its five sounds', () => {
    expect(stepsOnStrip('perc')).toBe(false);
    expect(stepsOnStrip('snare')).toBe(true);
    expect(INSTRUMENTS.perc.presets.map((p) => p.name)).toEqual(['LOW TOM', 'SYN DRUM', 'CONGA', 'COWBELL', 'CLAVE']);
    const crossings = (note: number) => {
      const d = new Drum(SR, PERC_PARAMS, PERC_VOICE);
      const sound = presetSound('perc', 0);
      for (const id in sound) d.setParam(id, sound[id]);
      d.setParam('c_level', 0);
      d.noteOn(note, 1, note);
      const l = new Float32Array(SR / 4);
      d.render(l, new Float32Array(SR / 4), 0, l.length);
      let c = 0;
      for (let i = 1; i < l.length; i++) if ((l[i - 1] < 0) !== (l[i] < 0)) c++;
      return c;
    };
    expect(crossings(48) / crossings(36)).toBeGreaterThan(1.8); // an octave up
  });

  it('a new project has 8 tracks: track 4 PERC, track 8 PLUCK', () => {
    const p = createDefaultProject();
    expect(p.channels.map((c) => c.instrument)).toEqual(['kick', 'snare', 'hat', 'perc', 'bass', 'pad', 'lead', 'pluck']);
    // Nothing routed: no FX 1-3, no LFO, PLUCK's delay / room dry.
    expect(p.channels.every((c) => !c.fx1 && c.fxSend === 0 && !c.lfoOn)).toBe(true);
    expect(p.channels[7].sounds.pluck!.dmix).toBe(0);
    expect(p.channels[7].sounds.pluck!.verb).toBe(0);
  });
});

describe('song mode', () => {
  // 120 BPM: a bar is 16 x 6000 = 96000 frames.
  const BAR = 96000;
  const songProject = (rows: { bars: number; patterns: number[] }[]) => {
    const p = kickProject([], { bpm: 120 });
    const k = p.channels[0];
    k.sounds.kick = { ...k.sounds.kick, t_decay: 0.01 };
    k.patterns[0].steps[0].active = true; // A: hit on step 1
    k.patterns[1].steps[4].active = true; // B: hit on step 5
    p.song = { rows: rows.map((r) => ({ bars: r.bars, patterns: [...r.patterns, -1, -1, -1, -1, -1, -1, -1].slice(0, 8) })) };
    return p;
  };
  const play = (p: Project, seconds: number, fromRow = 0) => {
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true, song: true, fromRow });
    return { e, l: render(e, seconds).l };
  };

  it('plays its rows in order for their bars, each restarting the row patterns', () => {
    const { l } = play(songProject([{ bars: 2, patterns: [0] }, { bars: 1, patterns: [1] }]), 6.1); // 2 s per bar
    near(onsets(l, 0.005, 1000), [0, BAR, 2 * BAR + 24000, 3 * BAR], 8); // A, A, B, then back to the top
  });

  it('a track set to off is silent for its row', () => {
    const { l } = play(songProject([{ bars: 1, patterns: [-1] }, { bars: 1, patterns: [0] }]), 2.1);
    near(onsets(l, 0.005, 1000), [BAR], 8);
  });

  it('starts from the chosen row and jumps at the next bar line', () => {
    const p = songProject([{ bars: 4, patterns: [0] }, { bars: 4, patterns: [1] }]);
    const { e, l } = play(p, 0.6, 1);
    expect(e.songRow).toBe(1);
    near(onsets(l, 0.005, 1000), [24000], 8);
    e.handleMessage({ type: 'songJump', row: 0 });
    const next = render(e, 1.6).l; // the jump lands at the next bar line (frame 96000)
    near(onsets(next, 0.005, 1000), [BAR - 28800], 8); // 28800 frames already played
    expect(e.songRow).toBe(0);
  });

  it('pattern mode ignores the song; songs survive the stored format', () => {
    const p = songProject([{ bars: 1, patterns: [1] }]);
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    near(onsets(render(e, 0.5).l, 0.005, 1000), [0]); // pattern A as usual
    expect(fromStored(JSON.parse(JSON.stringify(toStored(p))))!.song).toEqual(p.song);
  });
});

describe('v10 track order', () => {
  it('older projects move PERC from track 7 to track 4, with their patterns and song cells', () => {
    const old = JSON.parse(JSON.stringify(toStored(createDefaultProject())));
    old.version = 9;
    const kinds = ['kick', 'snare', 'hat', 'bass', 'pad', 'lead', 'perc', 'lead'];
    old.channels.forEach((c: { instrument: string; patterns: { len: number; steps: unknown[] }[] }, i: number) => {
      c.instrument = kinds[i];
      c.patterns[0].len = 16 + i; // a fingerprint per old track
    });
    old.song = { rows: [{ b: 2, p: [0, 1, 2, 3, 0, 1, 2, 3] }] };
    const p = fromStored(old)!;
    expect(p.channels.map((c) => c.instrument)).toEqual(['kick', 'snare', 'hat', 'perc', 'bass', 'pad', 'lead', 'pluck']); // track 8 became the PLUCK (v11)
    expect(p.channels.map((c) => c.patterns[0].length)).toEqual([16, 17, 18, 22, 19, 20, 21, 23]);
    expect(p.song.rows[0].patterns).toEqual([0, 1, 2, 2, 3, 0, 1, 3]);
  });
});

describe('drum RING follows the decay knobs', () => {
  it('a longer metal DECAY gives a longer ring tail', () => {
    const tail = (mDecay: number) => {
      const d = new Drum(SR, HAT_PARAMS, HAT_VOICE);
      const sound: Record<string, number> = { ...presetSound('hat', INSTRUMENTS.hat.presets.findIndex((p) => p.name === 'HAT')), c_level: 0, m_decay: mDecay };
      for (const id in sound) d.setParam(id, sound[id]);
      d.noteOn(36, 1, 36, true);
      const l = new Float32Array(SR * 3);
      d.render(l, new Float32Array(SR * 3), 0, l.length);
      return stats(l.subarray(SR * 1.2, SR * 1.3)).peak;
    };
    expect(tail(0.4)).toBeGreaterThan(tail(0.07) * 3); // a longer DECAY rings longer
  });
});

describe('PLUCK and ARP', () => {
  it('has its five sounds, from steel to the FM donk, with CHORD and ARP on the SOUND page', () => {
    expect(INSTRUMENTS.pluck.presets.map((p) => p.name)).toEqual(['STEEL', 'GLASS PLUCK', 'SAW PLUCK', 'SQUARE PLUCK', 'RAGE DONK']);
    const l = INSTRUMENTS.pluck.layout;
    const f = INSTRUMENTS.pluck.funcLayout;
    expect([l[7], l[15], f[7], f[15], f[14]]).toEqual(['track:chord', 'detune', 'arp', 'arprate', 'arpoct']);
    const s = new Synth(SR, INSTRUMENTS.pluck.params, { voice: 0 });
    const donk = presetSound('pluck', 3);
    for (const id in donk) s.setParam(id, donk[id]);
    s.noteOn(45, 1, 45);
    const out = new Float32Array(SR);
    s.render(out, new Float32Array(SR), 0, out.length);
    expect(stats(out).nan).toBe(false);
    expect(stats(out).peak).toBeLessThan(2);
  });

  it('GLIDE: fully left is off, with fine control over short glides', () => {
    const spec = INSTRUMENTS.lead.params.find((p) => p.id === 'glide')!;
    expect(toValue(spec, 0)).toBe(0);
    expect(toValue(spec, 0.25)).toBeLessThan(0.2);
    expect(toNorm(spec, toValue(spec, 0.4))).toBeCloseTo(0.4, 6);
  });

  it('CASCADE plays overlapping skips up (1 5 3 7) and down from the top', () => {
    const notesOf = (arp: number, chord: string) => {
      const p = kickProject([], { bpm: 120 });
      const t = p.channels[7];
      t.chord = CHORDS.findIndex((c) => c.name === chord);
      t.sounds.pluck = { ...t.sounds.pluck!, arp, arprate: 3, arpoct: 0 };
      const e = engineWith(p);
      const played: number[] = [];
      const inst = (e as unknown as { current: { noteOn(n: number): void }[] }).current[7];
      const orig = inst.noteOn.bind(inst);
      inst.noteOn = (n: number, ...rest: unknown[]) => { played.push(n); (orig as (...a: unknown[]) => void)(n, ...rest); };
      e.handleMessage({ type: 'trigger', channel: 7, note: 48, velocity: 0.8 });
      render(e, 0.95); // 1/16 = 6000 frames: about 8 notes
      return played.slice(0, 8).map((n) => n - 48);
    };
    expect(notesOf(4, 'MAJ7')).toEqual([0, 7, 4, 11, 0, 7, 4, 11]); // 1 5 3 7
    expect(notesOf(5, 'MIN11')).toEqual([17, 10, 14, 7, 10, 3, 7, 0]); // 11 7 9 5 7 3 5 1
  });

  it('ARP steps through the held chord at its rate', () => {
    const p = kickProject([], { bpm: 120 }); // 1/16 = 6000 frames
    const t = p.channels[7];
    t.fxSend = 0;
    t.chord = CHORDS.findIndex((c) => c.name === 'MAJOR');
    t.sounds.pluck = { ...t.sounds.pluck!, arp: 1, arprate: 3, decay: 0.03, decay2: 0.03, release: 0.01, release2: 0.01 };
    Object.assign(t.patterns[0].steps[0], { active: true, note: 45, gate: 4 });
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    const l = render(e, 0.5).l;
    near(onsets(l, 0.005, 1500), [0, 6000, 12000, 18000], 40); // three chord notes, then round again; stops with the gate
  });
});

describe('v12 slide flag', () => {
  it('older projects move SLIDE from the note slid into to the note that slides', () => {
    const p = createDefaultProject();
    const pat = p.channels[4].patterns[0];
    Object.assign(pat.steps[0], { active: true, note: 45 });
    Object.assign(pat.steps[2], { active: true, note: 52, slide: true }); // old meaning: slid into
    const old = JSON.parse(JSON.stringify(toStored(p)));
    old.version = 11;
    const q = fromStored(old)!;
    expect(q.channels[4].patterns[0].steps[0].slide).toBe(true);
    expect(q.channels[4].patterns[0].steps[2].slide).toBe(false);
  });

  it('a SLIDE note holds into the next note even after a gap', () => {
    const p = kickProject([], { bpm: 120 });
    const b = p.channels[4];
    b.fxSend = 0;
    b.sounds.bass = { ...b.sounds.bass!, sustain: 1, sustain2: 1, decay: 2, decay2: 2, release: 0.005, release2: 0.005 };
    Object.assign(b.patterns[0].steps[0], { active: true, note: 45, gate: 1, slide: true });
    Object.assign(b.patterns[0].steps[3], { active: true, note: 52, gate: 1 });
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    const l = render(e, 0.4).l;
    expect(stats(l.subarray(9000, 15000)).peak).toBeGreaterThan(0.05); // held through steps 2-3
  });
});

describe('FUNC layer and per-oscillator SUSTAIN / RELEASE', () => {
  it('every FUNC slot names a parameter of its type (16 slots)', () => {
    for (const k of SOUND_KINDS) {
      const entry = INSTRUMENTS[k];
      expect(entry.funcLayout.length).toBe(16);
      for (const id of entry.funcLayout) if (id && !id.startsWith('track:')) expect(entry.params.some((p) => p.id === id), `${k}:${id}`).toBe(true);
      // Every type's FUNC layer holds its setup in the same slots.
      expect([entry.funcLayout[0], entry.funcLayout[11], entry.funcLayout[4], entry.funcLayout[12], entry.funcLayout[5], entry.funcLayout[13]], k)
        .toEqual(['track:preset', 'midfreq', 'track:live1', 'track:live2', 'track:live3', 'track:live4']);
    }
  });

  it('each oscillator releases on its own RELEASE', () => {
    const tail = (release2: number) => {
      const s = new Synth(SR, INSTRUMENTS.bass.params, { voice: 1 });
      for (const [id, v] of Object.entries({ shape: 0, fm: 0, sub: 0, detune: 0, cutoff: 20000, fenv: 0, sustain: 1, sustain2: 1, release: 0.005, release2, drive: 1 })) s.setParam(id, v);
      s.noteOn(45, 1, 45);
      const n = SR / 10;
      s.render(new Float32Array(n), new Float32Array(n), 0, n);
      s.noteOff(45);
      const l = new Float32Array(n);
      s.render(l, new Float32Array(n), 0, n);
      return stats(l.subarray(2000, 3000)).peak;
    };
    expect(tail(0.005)).toBeLessThan(1e-3);
    expect(tail(2)).toBeGreaterThan(0.05);
  });

  it('presets and older projects give OSC 2 the OSC 1 SUSTAIN / RELEASE; LIVE 3 / 4 are saved', () => {
    const lead = presetSound('lead', 1);
    expect(lead.sustain2).toBe(lead.sustain);
    expect(lead.release2).toBe(lead.release);
    const p = createDefaultProject();
    p.channels[6].sounds.lead = { ...p.channels[6].sounds.lead!, sustain: 0.2, release: 3 };
    p.channels[6].liveFunc = ['fm', 'mix:pan'];
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    const q = fromStored(stored)!;
    expect(q.channels[6].liveFunc).toEqual(['fm', 'mix:pan']);
    delete stored.channels[6].sounds.lead.sustain2;
    delete stored.channels[6].sounds.lead.release2;
    stored.version = 13;
    const old = fromStored(stored)!.channels[6].sounds.lead!;
    expect(old.sustain2).toBe(0.2);
    expect(old.release2).toBe(3);
  });
});

describe('relative live knobs', () => {
  const kickTail = (offset: number, viaProject = false) => {
    const p = kickProject([0], { bpm: 120 });
    p.channels[0].fx1 = false;
    p.channels[0].sounds.kick = { ...p.channels[0].sounds.kick!, t_decay: 0.3 };
    if (viaProject && offset) p.channels[0].liveOffset = { 'macro:decay': offset };
    const e = engineWith(p);
    if (!viaProject) e.handleMessage({ type: 'setOffset', channel: 0, id: 'macro:decay', value: offset });
    e.handleMessage({ type: 'transport', playing: true });
    return stats(render(e, 0.3).l.subarray(8000, 14000)).peak;
  };

  it('every macro target is a parameter of its type; CUTOFF / RESO / mixer stay absolute', () => {
    for (const k of SOUND_KINDS) {
      for (const m of LIVE_MACROS[k]) for (const t of m.targets) expect(INSTRUMENTS[k].params.some((p) => p.id === t.id), `${k} ${m.id} ${t.id}`).toBe(true);
      expect(liveTargets(k, 'cutoff')).toEqual([]);
      expect(liveTargets(k, 'reso')).toEqual([]);
      expect(liveTargets(k, 'mix:volume')).toEqual([]);
      for (const id of [...INSTRUMENTS[k].live, ...INSTRUMENTS[k].liveFunc]) {
        if (id.startsWith('macro:')) expect(LIVE_MACROS[k].some((m) => m.id === id), `${k} ${id}`).toBe(true);
      }
    }
  });

  it('a full turn reaches 60 % of the range; halfway gives 40 % of that (gentle log taper)', () => {
    const t = { id: 'x', amount: 1 };
    expect(liveContribution(t, 1)).toBeCloseTo(0.6);
    expect(liveContribution(t, -1)).toBeCloseTo(-0.6);
    expect(liveContribution(t, 0.5)).toBeCloseTo(0.24);
    expect(liveContribution({ ...t, top: true }, 0.5)).toBe(0);
    expect(liveContribution({ ...t, top: true }, 1)).toBeCloseTo(0.6);
  });

  it('DECAY pushes the kick longer / shorter around the sound as set', () => {
    const centre = kickTail(0);
    expect(kickTail(1)).toBeGreaterThan(centre * 1.5);
    expect(kickTail(-1)).toBeLessThan(centre * 0.5);
  });

  it('offsets load with the project, clamp at the limits and clear on a type change', () => {
    expect(kickTail(1, true)).toBeCloseTo(kickTail(1), 3);
    const p = kickProject([0], { bpm: 120 });
    p.channels[0].sounds.kick = { ...p.channels[0].sounds.kick!, t_decay: 20 }; // at the top already
    p.channels[0].liveOffset = { 'macro:decay': 1, 'macro:punch': -1 };
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    expect(stats(render(e, 0.3).l).nan).toBe(false);
    const sound = { ...p.channels[0].sounds.kick!, t_decay: 0.3 };
    e.handleMessage({ type: 'setInstrument', channel: 0, kind: 'kick', sound });
    e.handleMessage({ type: 'transport', playing: false });
    e.handleMessage({ type: 'transport', playing: true });
    const after = stats(render(e, 0.3).l.subarray(8000, 14000)).peak;
    const q = kickProject([0], { bpm: 120 });
    q.channels[0].sounds.kick = sound;
    const fresh = engineWith(q);
    fresh.handleMessage({ type: 'transport', playing: true });
    expect(after).toBeCloseTo(stats(render(fresh, 0.3).l.subarray(8000, 14000)).peak, 2); // centred again (within the limiter's look-ahead)
  });

  it('live offsets are saved; projects before v16 take the new defaults', () => {
    const p = createDefaultProject();
    expect(p.channels[0].live).toEqual(['macro:attack', 'macro:decay']);
    p.channels[0].liveOffset = { 'macro:decay': 0.4 };
    expect(fromStored(JSON.parse(JSON.stringify(toStored(p))))!.channels[0].liveOffset).toEqual({ 'macro:decay': 0.4 });
    const old = { ...JSON.parse(JSON.stringify(toStored(p))), version: 15 };
    expect(fromStored(old)!.channels[0].liveOffset).toEqual({});
  });
});

describe('layers: TIMBRE > INTENSITY (hidden) < SOUND page trims < live', () => {
  const at = (kind: 'pluck' | 'perc' | 'pad', anchor: string, intensity: number) => {
    const t = anchorPosition(kind, MACROS[kind].anchors.findIndex((a) => a.name === anchor));
    return macroSound(kind, t, intensity, INSTRUMENTS[kind].params);
  };
  const octaves = (a: number, b: number) => Math.abs(Math.log2(a / b));

  it('INTENSITY 0 pulls SAW PLUCK and GLASS PLUCK together without making them the same', () => {
    const mid = octaves(at('pluck', 'SAW PLUCK', 0.5).cutoff, at('pluck', 'GLASS PLUCK', 0.5).cutoff);
    const low = octaves(at('pluck', 'SAW PLUCK', 0).cutoff, at('pluck', 'GLASS PLUCK', 0).cutoff);
    expect(low).toBeLessThan(mid * 0.12 + 1e-9);
    expect(at('pluck', 'SAW PLUCK', 0).drive).toBeLessThan(at('pluck', 'SAW PLUCK', 0.5).drive);
    // TIMBRE still matters at 0: FM keeps a tenth of each sound's own amount.
    expect(at('pluck', 'RAGE DONK', 0).fm).toBeGreaterThan(at('pluck', 'GLASS PLUCK', 0).fm);
    expect(at('pluck', 'RAGE DONK', 0).fm).toBeGreaterThan(0);
  });

  it('INTENSITY 0.5 is the sound as designed; 0 makes PERC dull thuds (less sweep, click, drive)', () => {
    const conga = at('perc', 'CONGA', 0.5);
    expect(conga.t_sweep).toBeCloseTo(MACROS.perc.anchors.find((a) => a.name === 'CONGA')!.values.t_sweep);
    const dull = at('perc', 'CONGA', 0);
    for (const id of ['t_sweep', 'c_level', 'c_tone']) expect(dull[id], id).toBeLessThan(conga[id]);
    expect(dull.drive).toBeLessThanOrEqual(conga.drive);
  });

  it('a SOUND page trim stays on top when TIMBRE moves', () => {
    const specs = INSTRUMENTS.pad.params;
    const spec = paramSpec('pad', 'cutoff')!;
    const sound: Record<string, number> = { ...presetSound('pad', 0) };
    const hiddenA = hiddenSound('pad', sound, specs).cutoff;
    const darker = hiddenA / 4; // two octaves down
    const trim = trimFor(spec, darker, hiddenA);
    sound.timbre = 0.6;
    const hiddenB = hiddenSound('pad', sound, specs).cutoff;
    expect(octaves(applyTrim(spec, hiddenB, trim), hiddenB)).toBeCloseTo(2, 1);
  });

  it('older saves derive trims that reproduce their values exactly', () => {
    // (On the LEAD: the PAD's engine changed in v32, so its old sounds are rebuilt.)
    const p = createDefaultProject();
    const sound = { ...p.channels[6].sounds.lead!, cutoff: 333, intensity: 0.2 };
    p.channels[6].sounds.lead = sound;
    const old = { ...JSON.parse(JSON.stringify(toStored(p))), version: 16 };
    delete old.channels[6].trims;
    const q = fromStored(old)!.channels[6];
    expect(q.sounds.lead!.cutoff).toBeCloseTo(333);
    const trims = q.trims.lead!;
    const hidden = hiddenSound('lead', q.sounds.lead!, INSTRUMENTS.lead.params);
    for (const id of macroIds('lead', INSTRUMENTS.lead.params)) {
      const spec = paramSpec('lead', id)!;
      expect(applyTrim(spec, hidden[id], trims[id]), id).toBeCloseTo(q.sounds.lead![id], 4);
    }
    expect(deriveTrims('lead', presetSound('lead', 1), INSTRUMENTS.lead.params)).toEqual({});
  });

  it('live macros only push SOUND page parameters', () => {
    for (const k of SOUND_KINDS) {
      const page = new Set([...INSTRUMENTS[k].layout, ...INSTRUMENTS[k].funcLayout]);
      for (const m of LIVE_MACROS[k]) for (const t of m.targets) expect(page.has(t.id), `${k} ${m.id} ${t.id}`).toBe(true);
    }
  });
});

describe('master limiter', () => {
  const sine = (amp: number, n: number) => {
    const l = new Float32Array(n);
    for (let i = 0; i < n; i++) l[i] = amp * Math.sin((2 * Math.PI * 110 * i) / SR);
    return l;
  };

  it('leaves a signal under the ceiling untouched (only delayed by the look-ahead)', () => {
    const lim = new Limiter(SR);
    const src = sine(0.8, SR);
    const l = src.slice();
    const r = src.slice();
    lim.process(l, r, l.length);
    let err = 0;
    for (let i = lim.len; i < l.length; i++) err = Math.max(err, Math.abs(l[i] - src[i - lim.len]));
    expect(err).toBeLessThan(1e-6);
  });

  it('holds a hot signal at the ceiling without overshoot', () => {
    const lim = new Limiter(SR);
    const l = sine(3, SR);
    const r = sine(3, SR);
    for (let i = 20000; i < 20100; i++) l[i] = 8; // a spike
    lim.process(l, r, l.length);
    expect(Math.max(...Array.from(l, Math.abs))).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(lim.reduction).toBeLessThan(0.2);
  });

  it('the start project never goes over the ceiling', () => {
    const e = new Engine(SR);
    e.handleMessage({ type: 'loadProject', project: createStartProject() });
    e.handleMessage({ type: 'transport', playing: true });
    expect(stats(render(e, 4).l).peak).toBeLessThanOrEqual(CEILING + 1e-6);
  });
});

describe('LEAD: 3 carriers on a feedback modulator', () => {
  const leadAt = (timbre: number, intensity: number) => {
    const s = new Synth(SR, LEAD_PARAMS, LEAD_FIXED);
    const sound = macroSound('lead', timbre, intensity, LEAD_PARAMS);
    for (const id in sound) s.setParam(id, id === 'cutoff' ? 20000 : id === 'fenv' ? 0 : sound[id]);
    s.noteOn(45, 1, 45, false);
    const l = new Float32Array(SR / 4);
    s.render(l, new Float32Array(l.length), 0, l.length);
    return l;
  };
  /** High-frequency share: energy of the first difference over the energy. */
  const edge = (l: Float32Array) => {
    let d = 0, e = 0;
    for (let i = 1; i < l.length; i++) { d += (l[i] - l[i - 1]) ** 2; e += l[i] ** 2; }
    return d / e;
  };

  it('DX7 level curve: subtle for most of FM, brutal at the top', () => {
    expect(dx7Index(0)).toBe(0);
    expect(dx7Index(0.6)).toBeGreaterThan(0.3);
    expect(dx7Index(0.6)).toBeLessThan(0.6);
    expect(dx7Index(1)).toBeCloseTo(13);
  });

  it('INTENSITY: 75 % reaches level 60, the top quarter goes on to 99', () => {
    const fm = (x: number) => macroSound('lead', 0, x, LEAD_PARAMS).fm;
    expect(fm(0.75)).toBeCloseTo(0.6, 2);
    expect(fm(1)).toBeCloseTo(1, 2);
    expect(fm(0)).toBeLessThan(0.02);
  });

  it('every TIMBRE is a plain lead at INTENSITY 0 and bites at 100 %', () => {
    for (const t of [0, 1 / 3, 2 / 3, 1]) {
      const plain = leadAt(t, 0);
      const wild = leadAt(t, 1);
      expect(stats(wild).nan).toBe(false);
      expect(edge(wild), `t=${t}`).toBeGreaterThan(edge(plain) * 1.5);
    }
  });

  it('INTENSITY 0 is one clear note (carrier 1 alone); the stack comes in with INTENSITY', () => {
    const c = (x: number) => macroSound('lead', 0, x, LEAD_PARAMS).carriers;
    expect(c(0)).toBeLessThan(0.01);
    expect(c(0.75)).toBeCloseTo(0.6, 2);
    expect(c(1)).toBeCloseTo(1, 2);
    // ODD 2:3 (first): at 0 the wave repeats at the note's period; fully up it does not.
    const period = SR / midiToHz(45 + 12); // OCTAVE +1
    const repeat = (l: Float32Array) => {
      const k = Math.round(period * 7); // an odd number of periods (sub-octave content does not line up)
      let num = 0, den = 0;
      for (let i = SR / 10; i < l.length - k; i++) { num += l[i] * l[i + k]; den += l[i] * l[i]; }
      return num / den;
    };
    expect(repeat(leadAt(0, 0))).toBeGreaterThan(0.95);
    expect(repeat(leadAt(0, 1))).toBeLessThan(repeat(leadAt(0, 0)) - 0.2);
  });

  it('TIMBRE steps FM ratios through related ratios between sounds', () => {
    for (let t = 0; t <= 1; t += 0.05) {
      const s = macroSound('lead', t, 0.5, LEAD_PARAMS);
      for (const id of ['fmratio', 'ratio2', 'ratio3']) expect(RATIO_STEPS.some((r) => Math.abs(r - s[id]) < 1e-9), `${id} @${t}`).toBe(true);
    }
  });
});

describe('LFO: odd rates, MORPH, FM MOD', () => {
  it('has odd and dotted rates; older saves keep their rate by name', () => {
    for (const n of ['3 BAR', '1.5 BAR', '3/4', '3/8', '5/16', '3/16']) expect(RATE(n), n).toBeGreaterThanOrEqual(0);
    const p = createDefaultProject();
    const old = { ...JSON.parse(JSON.stringify(toStored(p))), version: 17 };
    old.lfo.rate = 4; // '1/4' in the old list
    expect(LFO_RATES[fromStored(old)!.lfo.rate].name).toBe('1/4');
  });

  it('MORPH blends the shape into the next one', () => {
    const at = 0.1;
    const half = lfoValue(0, at, 0, 0.5);
    expect(half).toBeCloseTo((lfoValue(0, at, 0) + lfoValue(1, at, 0)) / 2);
    expect(lfoValue(5, at, 0.3, 1)).toBeCloseTo(lfoValue(0, at, 0)); // S+H wraps to SINE
  });

  it('FM MOD swings the synths modulation level', () => {
    const render1 = (fmMod: number) => {
      const p = kickProject([], { bpm: 120 });
      const c = p.channels[6]; // LEAD
      c.fxSend = 0;
      c.sounds.lead = { ...presetSound('lead', 0), fm: 0.5 };
      c.patterns[0].steps[0].active = true;
      c.patterns[0].steps[0].gate = 16;
      c.lfoOn = true;
      p.lfo = { ...p.lfo, rate: RATE('1 BAR'), shape: 1, fm: fmMod };
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      return render(e, 0.4).l;
    };
    const a = render1(0);
    const b = render1(0.5);
    let diff = 0, level = 0;
    for (let i = 2000; i < a.length; i++) { diff += Math.abs(a[i] - b[i]); level += Math.abs(a[i]); }
    expect(diff / level).toBeGreaterThan(0.1);
    expect(stats(b).nan).toBe(false);
  });
});

describe('LFO shapes for stabs', () => {
  it('every shape starts at its peak, except SAW UP which ends there', () => {
    for (const shape of [0, 1, 2, 3]) expect(lfoValue(shape, 0, 0), `shape ${shape}`).toBeCloseTo(1);
    expect(lfoValue(4, 0, 0)).toBeCloseTo(-1);
    expect(lfoValue(4, 0.9999, 0)).toBeCloseTo(1, 3);
  });
});

describe('a fifth TIMBRE sound (v19)', () => {
  it('every type has five sounds, the new one where it blends', () => {
    const names = (k: SoundKind) => MACROS[k].anchors.map((a) => a.name);
    expect(names('hat')).toEqual(['RIDE', 'HAT', 'SPLASH', 'CRASH', 'CHINA']);
    expect(names('bass')).toEqual(['SINE SUB', 'GROWL', 'ACID', 'SOLID', 'FM 2:3']);
    expect(names('snare')[1]).toBe('PICCOLO');
    expect(names('lead')[1]).toBe('ORGAN');
    for (const k of SOUND_KINDS) expect(MACROS[k].anchors.length, k).toBe(5);
  });

  it('older saves keep each sound: TIMBRE moves onto the same sound, values play exactly as saved', () => {
    const p = createDefaultProject();
    const ch = p.channels[2]; // hat
    // Saved at old CRASH (2/3 with four sounds) with a tweak.
    ch.sounds.hat = { ...ch.sounds.hat!, timbre: 2 / 3, m_tone: 3333 };
    ch.presets.hat = 4; // a user patch (after the four factory presets)
    const old = { ...JSON.parse(JSON.stringify(toStored(p))), version: 18 };
    const q = fromStored(old)!.channels[2];
    expect(timbreName('hat', q.sounds.hat!.timbre)).toBe('CRASH');
    expect(q.sounds.hat!.m_tone).toBeCloseTo(3333);
    expect(q.presets.hat).toBe(5);
    const hidden = hiddenSound('hat', q.sounds.hat!, INSTRUMENTS.hat.params);
    expect(applyTrim(paramSpec('hat', 'm_tone')!, hidden.m_tone, q.trims.hat!.m_tone)).toBeCloseTo(3333, 3);
  });
});

describe('PAD on the 3 carrier engine', () => {
  it('plays chords cleanly on every sound; INTENSITY 0 is carrier 1 alone', () => {
    for (let i = 0; i < 5; i++) {
      const s = new Synth(SR, PAD_PARAMS, PAD_FIXED);
      const sound = presetSound('pad', i);
      for (const id in sound) s.setParam(id, sound[id]);
      for (const n of [57, 60, 64, 67, 71]) s.noteOn(n, 0.8, 57);
      const l = new Float32Array(SR);
      s.render(l, new Float32Array(SR), 0, l.length);
      const st = stats(l);
      expect(st.nan, `pad ${i}`).toBe(false);
      expect(st.peak, `pad ${i}`).toBeGreaterThan(0.02);
    }
    expect(macroSound('pad', 0.5, 0, PAD_PARAMS).carriers).toBeLessThan(0.01);
  });

  it('older saves take the new carrier ratios of their own TIMBRE position', () => {
    const p = createDefaultProject();
    const warm = MACROS.pad.anchors.findIndex((a) => a.name === 'WARM') / 4;
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    const sound = stored.channels[5].sounds.pad;
    sound.timbre = warm;
    for (const id of ['ratio2', 'ratio3', 'feedback', 'carriers']) delete sound[id];
    const q = fromStored(stored)!.channels[5].sounds.pad!;
    expect(q.ratio3).toBe(0.5);
    expect(q.carriers).toBeCloseTo(0.25);
  });
});

describe('CHORD / LEAD / PLUCK level, CHORD stabs, FLT DEC curve', () => {
  it('saves from before the v20 synth trim scale VOLUME up (PAD / LEAD / PLUCK only)', () => {
    const p = createDefaultProject();
    expect(p.channels[5].volume).toBe(0.5);
    p.channels[6].volume = 0.1; // LEAD at 10 % before the trim
    p.channels[0].volume = 0.8;
    const old = { ...JSON.parse(JSON.stringify(toStored(p))), version: 19 };
    const q = fromStored(old)!;
    expect(q.channels[6].volume).toBeCloseTo(0.5);
    expect(q.channels[0].volume).toBeCloseTo(0.8);
  });

  it('PAD holds its chords, fading in and out quickly', () => {
    expect(INSTRUMENTS.pad.name).toBe('PAD');
    const s = presetSound('pad', 0);
    expect(s.sustain).toBeGreaterThan(0.5);
    expect(s.attack).toBeLessThan(0.05);
    expect(s.release).toBeLessThan(0.3);
  });

  it('FLT DEC: 1 s sits at the middle of the knob, the range is unchanged', () => {
    const spec = paramSpec('pad', 'fdecay')!;
    expect(toValue(spec, 0.5)).toBeCloseTo(1, 3);
    expect(toValue(spec, 0)).toBeCloseTo(0.002);
    expect(toValue(spec, 1)).toBeCloseTo(10);
    expect(toNorm(spec, 1)).toBeCloseTo(0.5, 3);
  });
});

describe('PERC: INTENSITY at the top makes warped clangs', () => {
  const hit = (t: number, x: number) => {
    const d = new Drum(SR, PERC_PARAMS, PERC_VOICE);
    const sound = { ...presetSound('perc', 0), ...macroSound('perc', t, x, PERC_PARAMS) };
    for (const id in sound) d.setParam(id, sound[id]);
    d.noteOn(36, 1, 36);
    const l = new Float32Array(SR / 2);
    d.render(l, new Float32Array(l.length), 0, l.length);
    return l;
  };
  const edge = (l: Float32Array) => {
    let d = 0, e = 0;
    for (let i = 1; i < l.length; i++) { d += (l[i] - l[i - 1]) ** 2; e += l[i] ** 2; }
    return d / (e || 1);
  };

  it('every sound turns metallic and wild in the top quarter, and renders cleanly', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const top = macroSound('perc', t, 1, PERC_PARAMS);
      expect(top.m_level, `t=${t}`).toBeGreaterThanOrEqual(0.8 - 1e-9);
      expect(top.t_sweep, `t=${t}`).toBeGreaterThan(20);
      expect(top.t_sweep, `t=${t}`).toBeLessThanOrEqual(24); // gnarly, not out of control
      expect(top.drive, `t=${t}`).toBeLessThanOrEqual(6 + 1e-9);
      const wild = hit(t, 1);
      expect(stats(wild).nan).toBe(false);
      expect(edge(wild), `t=${t}`).toBeGreaterThan(edge(hit(t, 0.5)) * 2);
    }
    // ... but up to 75 % it stays close to the designed sound.
    expect(macroSound('perc', 0, 0.75, PERC_PARAMS).m_level).toBeCloseTo(0.15, 2);
  });
});

describe('bus compressors (FX 1 shown; FX 2 / 3 use the same one)', () => {
  const run = (amount: number) => {
    const bus = new DrumBus(SR);
    bus.setParam('cmp_thresh', -30);
    bus.setParam('cmp_ratio', 1 + 7 * amount);
    bus.setParam('cmp_attack', 0.0005);
    const n = SR;
    // Loud hits with quiet tails: compression brings the tail up against the peak.
    const inL = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.05) * ((i % 12000) < 600 ? 0.9 : 0.1));
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    bus.process(inL, inL.slice(), outL, outR, 0, n);
    return { inL, outL };
  };

  it('is transparent at 0 and squeezes the dynamics when turned up', () => {
    const off = run(0);
    let err = 0;
    for (let i = 0; i < off.outL.length; i++) err = Math.max(err, Math.abs(off.outL[i] - off.inL[i]));
    expect(err).toBeLessThan(1e-6);
    const on = run(1).outL;
    const range = (l: Float32Array) => stats(l.subarray(24000, 24500)).peak / stats(l.subarray(30000, 36000)).peak;
    expect(range(on)).toBeLessThan(range(off.outL) * 0.8);
    expect(stats(on).nan).toBe(false);
  });
});

describe('send bus compressor', () => {
  const level = (bus: SendBus, amp: number) => {
    const n = SR / 2;
    const l = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.05) * amp);
    const r = l.slice();
    bus.comp.process(l, r, 0, n);
    return 20 * Math.log10(stats(l.subarray(n / 2)).peak); // settled
  };

  it('evens out levels: two tones 20 dB apart come out much closer (1:1 = untouched)', () => {
    const bus = new SendBus(SR, 1);
    expect(level(bus, 0.5) - level(bus, 0.05)).toBeCloseTo(20, 1);
    bus.comp.setParam('cmp_ratio', 10);
    bus.comp.setParam('cmp_thresh', -30);
    const spread = level(bus, 0.5) - level(bus, 0.05);
    expect(spread).toBeLessThan(6);
    expect(spread).toBeGreaterThan(0);
  });
});

describe('PERC: one octave whatever the TIMBRE', () => {
  it('every sound (and every position between) has the same pitch, so a line keeps its notes', () => {
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const s = macroSound('perc', t, 0.5, PERC_PARAMS);
      expect(s.t_pitch, `@${t.toFixed(2)}`).toBeCloseTo(130.81, 2);
      expect(s.m_pitch, `@${t.toFixed(2)}`).toBeUndefined(); // the metal is an INTERVAL above the tone
    }
    expect(presetSound('perc', 3).m_interval).toBe(12);
  });

  const pitchOf = (extra: Record<string, number>, layer: 't' | 'm') => {
    const d = new Drum(SR, PERC_PARAMS, PERC_VOICE);
    const sound: Record<string, number> = { ...presetSound('perc', 0), t_sweep: 0, c_level: 0, drive: 1, ...extra };
    if (layer === 'm') Object.assign(sound, { t_level: 0, m_level: 1, m_mode: 0, m_spread: 0, m_noise: 0, m_tone: 30 });
    for (const id in sound) d.setParam(id, sound[id]);
    d.noteOn(48, 1, 48);
    const l = new Float32Array(SR / 4);
    d.render(l, new Float32Array(l.length), 0, l.length);
    let crossings = 0;
    for (let i = 1; i < l.length; i++) if (l[i - 1] < 0 && l[i] >= 0) crossings++;
    return crossings * 4;
  };

  it('DETUNE moves the metal off the tone; the tone stays on the step\'s note', () => {
    expect(pitchOf({}, 't')).toBeCloseTo(261.6, -1); // note 48 = an octave above C3
    expect(pitchOf({ detune: 1 }, 't')).toBeCloseTo(261.6, -1);
    expect(pitchOf({}, 'm')).toBeCloseTo(523.2, -1); // an octave above
    expect(pitchOf({ detune: 1 }, 'm')).toBeCloseTo(523.2 * Math.pow(2, 1 / 12), -1);
    expect(pitchOf({ m_interval: 7 }, 'm')).toBeCloseTo(261.6 * Math.pow(2, 7 / 12), -1);
  });
});

describe('drum BALANCE', () => {
  const energy = (balance: number, layers: Record<string, number>) => {
    const d = new Drum(SR, KICK_PARAMS, KICK_VOICE);
    const sound: Record<string, number> = { ...presetSound('kick', 2), ...layers, balance };
    for (const id in sound) d.setParam(id, sound[id]);
    d.noteOn(36, 1, 36);
    const l = new Float32Array(SR / 4);
    d.render(l, new Float32Array(l.length), 0, l.length);
    return l.reduce((a, v) => a + v * v, 0);
  };

  it('centre = as designed; each end leaves one element alone', () => {
    expect(energy(0.5, { c_level: 0 })).toBeCloseTo(energy(0, { c_level: 0 }), 6); // left: the tone at full
    expect(energy(1, { c_level: 0 })).toBe(0); // right: no tone
    expect(energy(0, { t_level: 0 })).toBe(0); // left: no click
    expect(energy(0.75, {})).toBeLessThan(energy(0.5, {}));
  });
});

describe('FX 1 FILTER (one knob: low-pass <- off -> high-pass)', () => {
  const through = (pos: number, freq: number) => {
    const bus = new DrumBus(SR);
    bus.setParam('flt', pos);
    bus.settle();
    const n = SR / 2;
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / SR) * 0.5);
    const l = new Float32Array(n), r = new Float32Array(n);
    bus.setClock(0, 1 / 6000);
    bus.process(x, x.slice(), l, r, 0, n);
    let peak = 0;
    for (let i = n / 2; i < n; i++) peak = Math.max(peak, Math.abs(l[i]));
    return peak / 0.5;
  };

  it('is transparent in the middle, darkens to the left and thins to the right', () => {
    expect(through(0.5, 100)).toBeCloseTo(1, 3);
    expect(through(0.5, 6000)).toBeCloseTo(1, 3);
    expect(through(0.2, 6000)).toBeLessThan(0.05);
    expect(through(0.2, 100)).toBeGreaterThan(0.7);
    expect(through(0.9, 100)).toBeLessThan(0.05);
    expect(through(0.9, 12000)).toBeGreaterThan(0.5);
    expect(formatValue(DRUM_BUS_PARAMS.find((p) => p.id === 'flt')!, 0.5)).toBe('OFF');
    expect(formatValue(DRUM_BUS_PARAMS.find((p) => p.id === 'flt')!, 0.2)).toMatch(/^LP /);
    expect(formatValue(DRUM_BUS_PARAMS.find((p) => p.id === 'flt')!, 0.8)).toMatch(/^HP /);
  });
});

describe('v23: drum filter gone, PERC interval, FX 1 FILTER', () => {
  it('older saves keep their sound: LP cutoff -> FILTER, metal Hz -> INTERVAL, dead live knobs reset', () => {
    const p = createDefaultProject();
    const stored = JSON.parse(JSON.stringify(toStored(p))) as Record<string, any>;
    stored.version = 22;
    stored.fx1 = { ...stored.fx1, lp_cutoff: 800 };
    delete stored.fx1.flt;
    const perc = stored.channels[3];
    perc.sounds.perc = { ...perc.sounds.perc, m_pitch: perc.sounds.perc.t_pitch * Math.pow(2, 7 / 12) };
    delete perc.sounds.perc.m_interval;
    stored.channels[2].live = ['macro:decay', 'cutoff'];
    const back = fromStored(stored)!;
    expect(djCutoff(back.fx1.flt)).toBeCloseTo(-800, -1);
    expect(back.channels[3].sounds.perc!.m_interval).toBe(7);
    expect(back.channels[2].live).toEqual(INSTRUMENTS.hat.live);
  });
});

describe('ACC/GHOST depth (per track)', () => {
  it('scales how far accents and ghosts sit from a normal hit, both ways at once', () => {
    expect(dynVelocity(0.8, 0)).toBe(0.8);
    expect(dynVelocity(1, 0)).toBeCloseTo(0.8);
    expect(dynVelocity(0.45, 0)).toBeCloseTo(0.8);
    expect(dynVelocity(1, 1)).toBe(1);
    const db = (v: number) => 20 * Math.log10(v / 0.8);
    expect(db(dynVelocity(1, 2))).toBeCloseTo(2 * db(1));
    expect(db(dynVelocity(0.45, 2))).toBeCloseTo(2 * db(0.45));
  });

  it('a track at 0 % plays accents, normal hits and ghosts at one level', () => {
    const peak = (velocity: number, dyn: number) => {
      const p = kickProject([0], { bpm: 120 });
      p.channels[0].dynamics = dyn;
      p.channels[0].patterns[0].steps[0].velocity = velocity;
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      return stats(render(e, 0.2).l).peak;
    };
    expect(peak(1, 0)).toBeCloseTo(peak(0.8, 0), 3);
    expect(peak(0.45, 0)).toBeCloseTo(peak(0.8, 0), 3);
    expect(peak(0.45, 200)).toBeLessThan(peak(0.45, 100));
    const p = createDefaultProject();
    p.channels[2].dynamics = 150;
    expect(fromStored(JSON.parse(JSON.stringify(toStored(p))))!.channels[2].dynamics).toBe(150);
  });
});

describe('PLAY mode RING / SLIDE (all notes)', () => {
  it('RING on a track makes every hit ring, without touching the steps', () => {
    const tail = (force: boolean) => {
      const p = kickProject([0], { bpm: 120 });
      p.channels[0].sounds.kick = { ...p.channels[0].sounds.kick, t_decay: 0.05, c_level: 0 };
      const e = engineWith(p);
      if (force) e.handleMessage({ type: 'setForce', channel: 0, ring: true, slide: false });
      e.handleMessage({ type: 'transport', playing: true });
      return stats(render(e, 0.4).l.subarray(SR * 0.3)).peak;
    };
    expect(tail(true)).toBeGreaterThan(tail(false) * 10 + 1e-4);
  });

  it('ACCENT / GHOST play every hit at that dynamic', () => {
    const peak = (velocity?: number) => {
      const p = kickProject([0], { bpm: 120 });
      const e = engineWith(p);
      if (velocity) e.handleMessage({ type: 'setForce', channel: 0, ring: false, slide: false, velocity });
      e.handleMessage({ type: 'transport', playing: true });
      return stats(render(e, 0.2).l).peak;
    };
    expect(peak(1)).toBeGreaterThan(peak() * 1.1);
    expect(peak(0.45)).toBeLessThan(peak() * 0.75);
  });

  it('ROLL in PLAY rolls through consecutive hits, the last one ending it; lone hits stay single', () => {
    const run = (force: boolean) => {
      const p = kickProject([0, 1, 2, 6], { bpm: 120 });
      p.channels[0].sounds.kick = { ...p.channels[0].sounds.kick, t_decay: 0.01, c_level: 0, rolldiv: 1 }; // 1:2
      const e = engineWith(p);
      if (force) e.handleMessage({ type: 'setForce', channel: 0, ring: false, slide: true });
      e.handleMessage({ type: 'transport', playing: true });
      return onsets(render(e, 0.8).l, 0.005, 1500);
    };
    near(run(false), [0, 6000, 12000, 36000]);
    // Steps 1-2 roll (2 hits each), step 3 ends it with one hit; step 7 has nothing after it.
    near(run(true), [0, 3000, 6000, 9000, 12000, 36000]);
  });
});

describe('DRIVE level compensation', () => {
  it('every type ends up only a little louder at full DRIVE (about +2.5 dB on average)', () => {
    for (const k of SOUND_KINDS) {
      const e = INSTRUMENTS[k];
      const max = e.params.find((p) => p.id === 'drive')!.max;
      const rises = e.presets.map((_, pi) => {
        const rms = (d: number) => {
          const inst = e.create(SR);
          const s: Record<string, number> = { ...presetSound(k, pi), drive: d, crush: 0 };
          if (!e.drum) { s.sustain = 0.7; s.sustain2 = 0.7; }
          for (const id in s) inst.setParam(id, s[id]);
          inst.noteOn(e.drum ? 36 : 48, 0.8, e.drum ? 36 : 48, false);
          const l = new Float32Array(SR / 4);
          inst.render(l, new Float32Array(l.length), 0, l.length);
          return Math.sqrt(l.reduce((a, v) => a + v * v, 0) / l.length);
        };
        return 20 * Math.log10(rms(max) / rms(1));
      });
      const avg = rises.reduce((a, b) => a + b, 0) / rises.length;
      expect(avg, k).toBeGreaterThan(1);
      expect(avg, k).toBeLessThan(4.5);
      for (const r of rises) expect(r, k).toBeLessThan(12);
    }
  });

  it('the cut follows DRIVE, so turning it back restores the level', () => {
    expect(driveCompGain(DRIVE_RISE.kick, 1)).toBe(1);
    expect(driveCompGain(DRIVE_RISE.kick, 20)).toBeLessThan(driveCompGain(DRIVE_RISE.kick, 4));
  });
});

describe('CHORD carrier feedback (INT top half)', () => {
  const note = (name: string, intensity: number, cfb?: number) => {
    const s = new Synth(SR, PAD_PARAMS, PAD_FIXED);
    const t = anchorPosition('pad', MACROS.pad.anchors.findIndex((a) => a.name === name));
    const sound: Record<string, number> = {
      ...presetSound('pad', 0), ...macroSound('pad', t, intensity, PAD_PARAMS),
      fm: 0, carriers: 0, cutoff: 20000, fenv: 0, detune: 0, unison: 0, sustain: 1, sustain2: 1,
    };
    if (cfb !== undefined) sound.cfeedback = cfb;
    for (const id in sound) s.setParam(id, sound[id]);
    s.noteOn(57, 1, 57);
    const l = new Float32Array(SR / 2);
    s.render(l, new Float32Array(l.length), 0, l.length);
    return { l: l.subarray(SR / 4), sound };
  };
  const bright = (l: Float32Array) => {
    let d = 0, e = 0;
    for (let i = 1; i < l.length; i++) { d += (l[i] - l[i - 1]) ** 2; e += l[i] ** 2; }
    return d / e;
  };
  // Similarity of the signal to itself one period later (1 = perfectly periodic, no fizz).
  const periodic = (l: Float32Array) => {
    const p = Math.round(SR / 220);
    let a = 0, b = 0;
    for (let i = 0; i + p < l.length; i++) { a += l[i] * l[i + p]; b += l[i] * l[i]; }
    return a / b;
  };

  it('is off up to the middle and rises in the top half', () => {
    for (const x of [0, 0.25, 0.5]) expect(note('GLASS', x).sound.cfeedback, `${x}`).toBeCloseTo(0);
    expect(note('GLASS', 0.75).sound.cfeedback).toBeCloseTo(0.25);
    expect(note('GLASS', 1).sound.cfeedback).toBeCloseTo(1);
  });

  it('turns a sine carrier bright and saw-like, still a clean pitched tone', () => {
    const plain = note('GLASS', 0.5, 0).l;
    const full = note('GLASS', 0.5, 1).l;
    expect(bright(full)).toBeGreaterThan(bright(plain) * 3);
    expect(periodic(full)).toBeGreaterThan(0.95);
    expect(stats(full).nan).toBe(false);
  });
});

describe('v24 knob review', () => {
  it('NOTES adds chord tones in order: root, 5th, 3rd, 7th, 9th, 11th', () => {
    const min9 = CHORD_LIST.indexOf('MIN9');
    expect([1, 2, 3, 4, 5, 6].map((n) => chordVoicing(min9, n))).toEqual([
      [0], [0, 7], [0, 3, 7], [0, 3, 7, 10], [0, 3, 7, 10, 14], [0, 3, 7, 10, 14],
    ]);
    expect(chordVoicing(CHORD_LIST.indexOf('MAJ11'), 6)).toEqual([0, 4, 7, 11, 14, 17]);
    expect(chordVoicing(0, 6)).toEqual([0]);
  });

  it('PERC metal rings halfway between the body and the click (BD DEC lengthens a cowbell)', () => {
    const bell = (tDecay: number) => {
      const d = new Drum(SR, PERC_PARAMS, PERC_VOICE);
      const s: Record<string, number> = { ...presetSound('perc', INSTRUMENTS.perc.presets.findIndex((p) => p.name === 'COWBELL')), t_level: 0, c_level: 0, m_level: 1, t_decay: tDecay };
      for (const id in s) d.setParam(id, s[id]);
      d.noteOn(48, 1, 48);
      const l = new Float32Array(SR);
      d.render(l, new Float32Array(SR), 0, SR);
      return stats(l.subarray(SR * 0.3, SR * 0.35)).peak;
    };
    expect(bell(1.2)).toBeGreaterThan(bell(0.3) * 5);
  });

  it('old saves: knobs that left the page go back to TIMBRE / INT, and every track takes the new live knobs', () => {
    const p = createDefaultProject();
    const stored = JSON.parse(JSON.stringify(toStored(p))) as Record<string, any>;
    stored.version = 23;
    const bass = stored.channels[4];
    bass.trims = { ...(bass.trims ?? {}), bass: { ...(bass.trims?.bass ?? {}), shape: 0.2, cutoff: -0.1 } };
    bass.live = ['cutoff', 'reso'];
    const back = fromStored(stored)!.channels[4];
    expect(back.trims.bass!.shape).toBeUndefined();
    expect(back.trims.bass!.cutoff).toBeCloseTo(-0.1);
    expect(back.sounds.bass!.shape).toBeCloseTo(hiddenSound('bass', back.sounds.bass!, INSTRUMENTS.bass.params).shape);
    expect(back.live).toEqual([...INSTRUMENTS.bass.live]);
    expect(back.liveFunc).toEqual([...INSTRUMENTS.bass.liveFunc]);
  });

  it('v35 load: BASS / PLUCK on the old default live knobs take CUTOFF first; chosen ones stay', () => {
    const p = createDefaultProject();
    p.channels[4].live = ['macro:env', 'macro:grit'];
    p.channels[4].liveFunc = ['mix:volume', 'cutoff'];
    p.channels[4].liveOffset = { 'macro:env': 0.3 };
    p.channels[7].live = ['track:notes', 'reso'];
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    stored.version = 34;
    const q = fromStored(stored)!;
    expect(q.channels[4].live).toEqual(['cutoff', 'macro:env']);
    expect(q.channels[4].liveFunc).toEqual(['mix:volume', 'macro:grit']);
    expect(q.channels[4].liveOffset['macro:env']).toBeCloseTo(0.3);
    expect(q.channels[7].live).toEqual(['track:notes', 'reso']);
  });
});

describe('LFO rates v25', () => {
  it('adds dotted / odd rates and keeps older saves on the same rate', () => {
    const names = LFO_RATES.map((r) => r.name);
    for (const n of ['3/16', '3/32', '7/16', '5/8', '7/8', '1/32T']) expect(names, n).toContain(n);
    const p = createDefaultProject();
    const stored = JSON.parse(JSON.stringify(toStored(p))) as Record<string, any>;
    stored.version = 24;
    stored.lfo = { ...stored.lfo, rate: 11 }; // '3/16' in the v18-v24 list
    expect(LFO_RATES[fromStored(stored)!.lfo.rate].name).toBe('3/16');
    expect(LFO_RATES[createDefaultProject().lfo.rate].name).toBe('1/4');
  });
});

describe('BASS / PLUCK: one envelope, envelope filter, sidechain, onboard FX', () => {
  const rms = (l: Float32Array, a: number, b: number) => {
    let e = 0;
    for (let i = a; i < b; i++) e += l[i] * l[i];
    return Math.sqrt(e / (b - a));
  };
  const synth = (kind: 'bass' | 'pluck', values: Record<string, number>) => {
    const entry = INSTRUMENTS[kind];
    const s = entry.create(SR);
    const sound = { ...presetSound(kind, 0), ...values };
    for (const id in sound) s.setParam(id, sound[id]);
    s.setTempo?.(120);
    return s;
  };
  const play = (s: ReturnType<typeof synth>, seconds: number, noteSeconds: number) => {
    const n = Math.floor(seconds * SR);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    s.noteOn(45, 1, 45, false);
    const off = Math.floor(noteSeconds * SR);
    for (let at = 0; at < n; at += BLOCK) {
      if (at === Math.floor(off / BLOCK) * BLOCK) s.noteOff(-1);
      const end = Math.min(n, at + BLOCK);
      const bl = new Float32Array(end - at);
      const br = new Float32Array(end - at);
      s.render(bl, br, 0, end - at);
      s.post?.(bl, br, end - at);
      l.set(bl, at);
      r.set(br, at);
    }
    return l;
  };

  it('a KICK hit ducks the BASS by DUCK (even with the kick turned down)', () => {
    const run = (duck: number) => {
      const p = kickProject([4], { bpm: 120 });
      p.channels[0].volume = 0;
      const bass = p.channels[4];
      bass.sounds.bass = { ...presetSound('bass', 0), sustain: 1, duck, duckrel: 0.3 };
      bass.patterns[0].steps[0].active = true;
      bass.patterns[0].steps[0].gate = 16;
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      return render(e, 1.2).l;
    };
    const dry = run(0);
    const ducked = run(1);
    const at = 24000 + 400;
    expect(rms(dry, at, at + 2000)).toBeGreaterThan(0.01);
    expect(rms(ducked, at, at + 2000)).toBeLessThan(rms(dry, at, at + 2000) * 0.15);
    // ... and it recovers after DUCK REL.
    expect(rms(ducked, 24000 + 18000, 24000 + 20000)).toBeGreaterThan(rms(dry, 24000 + 18000, 24000 + 20000) * 0.8);
  });

  it('the BASS filter has its own envelope: FLT DEC sets it, the amp DECAY does not (v38)', () => {
    const bright = (decay: number, fdecay: number) => {
      const l = play(synth('bass', { shape: 2, sustain: 1, cutoff: 200, reso: 0.2, fenv: 2, decay, fdecay }), 0.6, 0.6);
      let d = 0, e = 0;
      for (let i = SR * 0.1; i < SR * 0.25; i++) { d += (l[i] - l[i - 1]) ** 2; e += l[i] ** 2; }
      return d / e;
    };
    // Acid: notes held (SUSTAIN 1) while the filter snaps shut.
    expect(bright(1, 1.5)).toBeGreaterThan(bright(1, 0.08) * 2);
    expect(bright(3, 0.08)).toBeCloseTo(bright(0.5, 0.08), 2);
  });

  it('root-locked FM (carrier 3, modulator 2) keeps 2 : 3 on the note: nothing below it', () => {
    const mag = (l: Float32Array, f: number) => {
      let re = 0, im = 0;
      const a = Math.floor(SR * 0.1), b = Math.floor(SR * 0.5);
      for (let i = a; i < b; i++) { re += l[i] * Math.cos((2 * Math.PI * f * i) / SR); im += l[i] * Math.sin((2 * Math.PI * f * i) / SR); }
      return Math.hypot(re, im) / (b - a);
    };
    const base = { shape: 0, fm: 1, fenv: 1, fdecay: 2, sustain: 1, decay: 2, cutoff: 12000, reso: 0, sub: 0, drive: 1, detune: 0, unison: 0 };
    const f = midiToHz(45) * Math.pow(2, (presetSound('bass', 0).octave ?? 4) - 4);
    const plain = play(synth('bass', { ...base, fmratio: 2 / 3 }), 0.6, 0.6);
    const locked = play(synth('bass', { ...base, fmratio: 2, cratio: 3 }), 0.6, 0.6);
    // Plain 2 : 3 has a root an octave and a fifth down; root-locked has nothing below the note.
    expect(mag(plain, f / 3)).toBeGreaterThan(mag(plain, f) * 0.2);
    expect(mag(locked, f / 3)).toBeLessThan(mag(locked, f) * 0.02);
    expect(mag(locked, f)).toBeGreaterThan(0.01);
  });

  it('BASS (v40): FM ratio ladder 1:2 -> 2:3 -> 3:2 over the knob, INT leaves FM LVL alone', () => {
    const specs = INSTRUMENTS.bass.params;
    const pair = (t: number) => { const m = macroSound('bass', t, 0.5, specs); return [m.cratio, m.fmratio]; };
    expect(pair(0)).toEqual([1, 2]);
    expect(pair(0.3)).toEqual([1, 2]);
    expect(pair(0.34)).toEqual([2, 3]);
    expect(pair(0.66)).toEqual([2, 3]);
    expect(pair(0.67)).toEqual([3, 2]);
    expect(pair(1)).toEqual([3, 2]);
    // Every pair keeps its lowest partial on the note (carrier = +-1 mod modulator, never 0 Hz).
    for (const t of [0, 0.5, 1]) {
      const [c, m] = pair(t);
      expect(Math.min(c % m, m - (c % m))).toBe(1);
    }
    // INTENSITY no longer moves FM LVL; the designed sounds each carry a little FM.
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(macroSound('bass', t, 0, specs).fm).toBeCloseTo(macroSound('bass', t, 1, specs).fm);
    }
    expect(INSTRUMENTS.bass.presets.map((p) => presetSound('bass', INSTRUMENTS.bass.presets.indexOf(p)).fm)).toEqual([0.12, 0.15, 0.15, 0.15, 0.6]);
    // FM LVL itself still goes from none to full.
    const fm = specs.find((x) => x.id === 'fm')!;
    expect([fm.min, fm.max]).toEqual([0, 1]);
    // A v18 save on FM CLANG lands on FM 2:3.
    expect(remapTimbreV18('bass', 1)).toBe(1);
  });

  it('every TIMBRE sound on every track is equally loud at its default VOLUME', () => {
    // BS.1770 K-weighting (48 kHz), then the loudest 400 ms (momentary loudness).
    const biquad = (c: number[], x: Float32Array) => {
      const y = new Float32Array(x.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
      }
      return y;
    };
    const k = (x: Float32Array) => biquad([1, -2, 1, -1.99004745483398, 0.99007225036621], biquad([1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585], x));
    /** One default hit (synths: a half-second note) on track ch with sound i. */
    const loudness = (ch: number, kind: SoundKind, i: number) => {
      const p = createDefaultProject();
      p.bpm = 120;
      p.master = 0.2; // under the limiter
      p.channels.forEach((c, n) => { c.patterns = c.patterns.map(() => emptyPattern(c.patterns[0].steps[0].note)); c.mute = n !== ch; });
      applyPreset(p.channels[ch], kind, i);
      const pat = p.channels[ch].patterns[0];
      pat.length = 64;
      Object.assign(pat.steps[0], { active: true, gate: INSTRUMENTS[kind].drum ? 1 : 4 });
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      const { l, r } = render(e, 1.5);
      const wl = k(l), wr = k(r), win = SR * 0.4;
      let sum = 0, best = 0;
      for (let n = 0; n < l.length; n++) {
        sum += wl[n] ** 2 + wr[n] ** 2;
        if (n >= win) sum -= wl[n - win] ** 2 + wr[n - win] ** 2;
        best = Math.max(best, sum);
      }
      return 10 * Math.log10(best / win);
    };
    const levels = createDefaultProject().channels.flatMap((c, ch) => {
      const kind = c.instrument as SoundKind;
      return INSTRUMENTS[kind].presets.slice(0, 5).map((_, i) => loudness(ch, kind, i));
    });
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(1);
  }, 30_000);

  it('v40 load: a v39 bass keeps its sound (TIMBRE follows it to its new place, preset too)', () => {
    const p = createDefaultProject();
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    stored.version = 39;
    // v39 order: SINE SUB, SOLID, ACID, GROWL, FM 2:3 - GROWL was at 0.75 (preset 3).
    const bass = stored.channels[4];
    Object.assign(bass.sounds.bass, { timbre: 0.75, fm: 0, cutoff: 900, intensity: 0.5 });
    bass.presets = { bass: 3 };
    bass.trims = { bass: {} };
    bass.patterns[0].steps = [{ i: 0, n: 33, v: 0.8, l: { timbre: 0.25 } }];
    const q = fromStored(stored)!.channels[4];
    expect(q.sounds.bass!.timbre).toBeCloseTo(0.25); // GROWL's new place
    expect(INSTRUMENTS.bass.presets[q.presets.bass!].name).toBe('GROWL');
    expect(q.sounds.bass!.fm).toBe(0);
    expect(q.sounds.bass!.cutoff).toBeCloseTo(900);
    expect(q.patterns[0].steps[0].locks!.timbre).toBeCloseTo(0.75); // SOLID was at 0.25
  });

  it('v38 load: a saved BASS keeps its filter envelope (FLT ATK = ATTACK, FLT DEC = DECAY x its ratio)', () => {
    const p = createDefaultProject();
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    stored.version = 37;
    const bass = stored.channels[4].sounds.bass;
    Object.assign(bass, { attack: 0.004, decay: 0.8, fratio: 0.25 });
    delete bass.fattack;
    delete bass.fdecay;
    const q = fromStored(stored)!.channels[4];
    expect(q.sounds.bass!.fdecay).toBeCloseTo(0.2);
    expect(q.sounds.bass!.fattack).toBeCloseTo(0.004);
    expect(q.sounds.bass!.fratio).toBeUndefined();
    // Kept as trims, so TIMBRE / INT moves keep it.
    expect(q.trims.bass!.fdecay).toBeDefined();
  });

  it('PLUCK echoes through its onboard delay; SPACE fully left dries it up', () => {
    const tail = (values: Record<string, number>) => {
      const l = play(synth('pluck', { decay: 0.05, release: 0.02, dtime: 2, dfdbk: 0.3, ...values }), 0.6, 0.02);
      return rms(l, Math.floor(0.375 * SR), Math.floor(0.42 * SR)); // 3/16 at 120 BPM
    };
    expect(tail({ dmix: 0.5, verb: 0 })).toBeGreaterThan(0.002);
    expect(tail({ dmix: 0, verb: 0 })).toBeLessThan(1e-4);
    expect(LIVE_MACROS.pluck.find((m) => m.id === 'macro:space')!.targets.map((t) => t.id)).toEqual(['dmix', 'verb']);
    expect(INSTRUMENTS.pluck.liveFunc).toContain('macro:space');
  });

  it('PLUCK SUSTAIN (live) rings each note on without touching RELEASE; SUSTAIN on the page holds', () => {
    const m = LIVE_MACROS.pluck.find((x) => x.id === 'macro:sustain')!;
    expect(m.targets.map((t) => t.id)).toEqual(['attack', 'decay', 'sustain', 'fdecay']);
    expect(INSTRUMENTS.pluck.live).toEqual(['cutoff', 'track:notes']);
    expect([INSTRUMENTS.pluck.layout[1], INSTRUMENTS.pluck.layout[9]]).toEqual(['attack', 'sustain']);
    const held = play(synth('pluck', { sustain: 0.6, dmix: 0, verb: 0 }), 0.8, 0.8);
    const plucked = play(synth('pluck', { sustain: 0, dmix: 0, verb: 0 }), 0.8, 0.8);
    expect(rms(held, SR * 0.6, SR * 0.7)).toBeGreaterThan(rms(plucked, SR * 0.6, SR * 0.7) * 10 + 1e-3);
  });

  it('v27 load: sends move to PAD / LEAD, an untouched PAD stab holds, PLUCK takes SUSTAIN / SPACE', () => {
    const p = createDefaultProject();
    p.channels[4].fxSend = 2;
    p.channels[7].fxSend = 2;
    p.channels[5].fxSend = 0;
    p.channels[5].sounds.pad = { ...p.channels[5].sounds.pad!, attack: 0.003, attack2: 0.003, decay: 0.45, decay2: 0.45, sustain: 0, sustain2: 0, release: 0.3, release2: 0.3 };
    p.channels[7].live = ['track:notes', 'cutoff'];
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    stored.version = 26;
    const q = fromStored(stored)!;
    expect(q.channels.slice(4).map((c) => c.fxSend)).toEqual([0, 3, 2, 0]);
    expect(q.channels[5].sounds.pad!.sustain).toBeGreaterThan(0.5);
    expect(q.channels[7].live).toEqual([...INSTRUMENTS.pluck.live]);
    expect(q.channels[7].liveFunc).toEqual([...INSTRUMENTS.pluck.liveFunc]);
  });
});

describe('GATE: how long a sequenced note\'s last step is held', () => {
  // 120 BPM: a step is 6000 frames.
  const run = (gateLength: number, gate = 1) => {
    const p = kickProject([], { bpm: 120 });
    const bass = p.channels[4];
    bass.sounds.bass = { ...presetSound('bass', 0), sustain: 1, release: 0.005, duck: 0 };
    bass.gateLength = gateLength;
    bass.patterns[0].steps[0].active = true;
    bass.patterns[0].steps[0].gate = gate;
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    return render(e, 0.5).l;
  };
  const level = (l: Float32Array, step: number) => stats(l.subarray(Math.round(step * 6000), Math.round(step * 6000) + 300)).peak;

  it('cuts the note short, holds it on into the next step, and keeps ties long', () => {
    const full = run(1);
    expect(level(full, 0.5)).toBeGreaterThan(0.02);
    expect(level(full, 1.3)).toBeLessThan(level(full, 0.5) * 0.05);
    const short = run(0.25);
    expect(level(short, 0.15)).toBeGreaterThan(0.02);
    expect(level(short, 0.5)).toBeLessThan(level(full, 0.5) * 0.05);
    const long = run(2);
    expect(level(long, 1.5)).toBeGreaterThan(level(full, 0.5) * 0.5);
    expect(level(long, 2.3)).toBeLessThan(level(full, 0.5) * 0.05);
    // A note tied over 4 steps still sustains; only its last step is cut.
    const tied = run(0.25, 4);
    expect(level(tied, 2.5)).toBeGreaterThan(level(full, 0.5) * 0.5);
    expect(level(tied, 3.6)).toBeLessThan(level(full, 0.5) * 0.05);
  });

  it('is saved with the track', () => {
    const p = createDefaultProject();
    p.channels[7].gateLength = 0.25;
    expect(fromStored(JSON.parse(JSON.stringify(toStored(p))))!.channels[7].gateLength).toBe(0.25);
    expect(createDefaultProject().channels[7].gateLength).toBe(1);
  });
});

describe('MID CUT per track (MIX, FUNC) at the sound\'s MID FREQ', () => {
  const sine = (hz: number, n = SR / 2) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / SR) * 0.5);
  const tailRms = (l: Float32Array) => Math.sqrt(l.subarray(l.length / 2).reduce((a, v) => a + v * v, 0) / (l.length / 2));

  it('cuts at the centre (about 18 dB at full), leaves other frequencies, and is off at 0', async () => {
    const { TrackCut, TRACK_CUT_MAX_DB } = await import('../src/fx/TrackCut');
    const run = (amount: number, hz: number) => {
      const c = new TrackCut(SR);
      c.setFreq(1000);
      c.setAmount(amount);
      c.settle();
      const l = sine(hz);
      const r = sine(hz);
      for (let i = 0; i < l.length; i += BLOCK) c.process(l.subarray(i, i + BLOCK), r.subarray(i, i + BLOCK), Math.min(BLOCK, l.length - i));
      return tailRms(l);
    };
    const dry = tailRms(sine(1000));
    expect(run(0, 1000)).toBeCloseTo(dry, 6);
    expect(20 * Math.log10(run(1, 1000) / dry)).toBeLessThan(-TRACK_CUT_MAX_DB + 1);
    expect(20 * Math.log10(run(1, 8000) / tailRms(sine(8000)))).toBeGreaterThan(-3);
  });

  it('each type starts on its own MID FREQ; MID CUT starts at 0', () => {
    const freq = Object.fromEntries(SOUND_KINDS.map((k) => [k, presetSound(k, 0).midfreq]));
    expect(freq).toEqual({ kick: 350, snare: 500, hat: 2000, perc: 450, bass: 350, pad: 500, lead: 1000, pluck: 800 });
    expect(createDefaultProject().channels.every((c) => c.midCut === 0)).toBe(true);
  });

  it('a send bus with nothing coming in falls silent and is skipped; effects at 0 are skipped', () => {
    const bus = new SendBus(SR, 1);
    bus.setWet(0, 0.6); // delay
    const n = 128;
    const inL = new Float32Array(n), inR = new Float32Array(n);
    const outL = new Float32Array(n), outR = new Float32Array(n);
    inL[0] = inR[0] = 1;
    bus.process(inL, inR, outL, outR, 0, n);
    inL[0] = inR[0] = 0;
    let heard = 0;
    for (let i = 0; i < (SR * 2) / n; i++) {
      outL.fill(0);
      bus.process(inL, inR, outL, outR, 0, n);
      heard = Math.max(heard, ...outL);
    }
    expect(heard).toBeGreaterThan(0.01); // its echoes still come back
    // Turned to 0, then back up: it starts clean (no old echoes).
    bus.setWet(0, 0);
    for (let i = 0; i < (SR * 0.3) / n; i++) bus.process(inL, inR, outL, outR, 0, n);
    bus.setWet(0, 0.6);
    let stale = 0;
    for (let i = 0; i < (SR * 2) / n; i++) {
      outL.fill(0);
      bus.process(inL, inR, outL, outR, 0, n);
      stale = Math.max(stale, ...outL.map(Math.abs));
    }
    expect(stale).toBeLessThan(1e-6);
  });

  it('v29 load: MID CUT leaves the sends, the other effects keep their settings', () => {
    const p = createDefaultProject();
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    stored.version = 28;
    stored.sendWet = [[0, 0, 0, 0, 0], [0.6, 0.1, 0.9, 0.2, 0.3], [0, 0, 0.5, 0.4, 0.7]];
    const q = fromStored(stored)!;
    expect(q.sendWet[1]).toEqual([0.6, 0.1, 0.2, 0.3]);
    expect(q.sendWet[2]).toEqual([0, 0, 0.4, 0.7]);
  });
});

describe('LEAD voices', () => {
  it('plays 3 voices: a released note rings on under the next, a 4th steals the oldest', () => {
    // Each note plays 2000 frames, then is released (long RELEASE); the last window is compared.
    const lead = (notes: number[], voices = 3, firstVel = 1) => {
      const s = new Synth(SR, LEAD_PARAMS, { ...LEAD_FIXED, voices });
      const sound: Record<string, number> = { ...presetSound('lead', 0), sustain: 1, sustain2: 1, release: 2, release2: 2 };
      for (const id in sound) s.setParam(id, sound[id]);
      const l = new Float32Array(2000 * notes.length + 2000);
      notes.forEach((n, i) => {
        s.noteOn(n, i === 0 ? firstVel : 1, n, false);
        s.render(l, new Float32Array(l.length), i * 2000, (i + 1) * 2000);
        s.noteOff(n);
      });
      s.render(l, new Float32Array(l.length), notes.length * 2000, l.length);
      return l.subarray(l.length - 1000);
    };
    const diff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
    // 3 notes: the first two still ring under the third (unlike one voice).
    expect(diff(lead([57, 60, 64]), lead([57, 60, 64], 1))).toBeGreaterThan(0.01);
    // A 4th note takes the oldest voice: the first note no longer matters.
    expect(diff(lead([57, 60, 64, 67]), lead([57, 60, 64, 67], 3, 0))).toBeLessThan(1e-6);
    expect(diff(lead([57, 60, 64]), lead([57, 60, 64], 3, 0))).toBeGreaterThan(0.01);
  });
});

describe('v30: ROLL RATE and roll runs', () => {
  it('ROLL DIV becomes ROLL RATE at the same speed; per-step hit counts become ROLL', () => {
    expect(ROLL_DIVS.map((r) => r.name)).toEqual(['1:1', '1:2', '1:3', '1:4', '1:6', '1:8']);
    expect(presetSound('kick', 0).rolldiv).toBe(3); // 1:4
    const p = createDefaultProject();
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    stored.version = 29;
    stored.channels[0].sounds.kick.rolldiv = 0; // 1/32
    stored.channels[0].patterns[0].steps = [{ i: 0, n: 36, v: 0.8, k: 3 }, { i: 1, n: 36, v: 0.8, l: { rolldiv: 2 } }];
    const q = fromStored(stored)!;
    expect(q.channels[0].sounds.kick!.rolldiv).toBe(1); // 1:2, the same 2 hits per step
    expect(q.channels[0].patterns[0].steps[0].slide).toBe(true);
    expect(q.channels[0].patterns[0].steps[1].locks!.rolldiv).toBe(3); // 1/64 -> 1:4
  });
});

describe('drum retrigger', () => {
  it('a drum hit again while still sounding does not jump (the old hit fades out under the new one)', () => {
    const kick = new Drum(SR, KICK_PARAMS, KICK_VOICE);
    const sound: Record<string, number> = { ...presetSound('kick', 0), t_decay: 0.5 };
    for (const id in sound) kick.setParam(id, sound[id]);
    const n = 4000;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    kick.noteOn(36, 1, 36);
    // Play on to a loud moment, then hit it again (a roll hit while the first still sounds).
    let at = 1500;
    kick.render(l, r, 0, at);
    while (Math.abs(l[at - 1]) < 0.1 && at < 3000) { kick.render(l, r, at, at + 1); at++; }
    expect(Math.abs(l[at - 1])).toBeGreaterThan(0.1);
    kick.noteOn(36, 1, 36);
    kick.render(l, r, at, n);
    // No sample-to-sample jump at the retrigger bigger than the kick's own movement.
    let ownMax = 0;
    for (let i = 1000; i < at - 1; i++) ownMax = Math.max(ownMax, Math.abs(l[i + 1] - l[i]));
    for (let i = at - 3; i < at + 10; i++) expect(Math.abs(l[i + 1] - l[i]), `sample ${i}`).toBeLessThan(ownMax * 2 + 0.01);
  });
});

describe('v32: PAD on 2 STACKS', () => {
  const names = () => MACROS.pad.anchors.map((a) => a.name);
  const at = (name: string) => names().indexOf(name) / 4;

  it('soft -> bell-like on the 2 STACKS engine, FM topping out at level 92', () => {
    expect(PAD_FIXED.algo).toBe(2);
    expect(names()).toEqual(['WARM', 'STRINGS', 'TINE', 'GLASS', 'ETHEREAL']);
    for (const t of [0, 0.3, 0.5, 0.8, 1]) expect(macroSound('pad', t, 1, PAD_PARAMS).fm).toBeCloseTo(0.92);
  });

  it('TIMBRE steps the modulators in whole / half steps, stack 2\'s carrier through intervals', () => {
    const carrier = new Set<number>();
    for (let k = 0; k <= 400; k++) {
      const s = macroSound('pad', k / 400, 0.5, PAD_PARAMS);
      expect(HALF_STEPS, `FM RATIO at ${k}`).toContain(s.fmratio);
      expect(HALF_STEPS, `RATIO 3 at ${k}`).toContain(s.ratio3);
      expect(RATIO_STEPS).toContain(s.ratio2);
      carrier.add(s.ratio2);
    }
    expect(carrier.has(4 / 3)).toBe(true); // a fourth on the way (WARM -> STRINGS)
  });

  it('renders cleanly with no DC offset (1 : 1 ratios)', () => {
    for (const p of INSTRUMENTS.pad.presets.slice(0, 5)) {
      const s = new Synth(SR, PAD_PARAMS, PAD_FIXED);
      const sound: Record<string, number> = { ...presetSound('pad', INSTRUMENTS.pad.presets.indexOf(p)), intensity: 0.8 };
      for (const id in sound) s.setParam(id, sound[id]);
      for (const n of [57, 60, 64, 67]) s.noteOn(n, 0.8, 57);
      const l = new Float32Array(SR);
      s.render(l, new Float32Array(SR), 0, l.length);
      const st = stats(l);
      expect(st.nan, p.name).toBe(false);
      expect(st.peak, p.name).toBeGreaterThan(0.05);
      const tail = l.subarray(SR / 2);
      const mean = tail.reduce((a, x) => a + x, 0) / tail.length;
      expect(Math.abs(mean), p.name).toBeLessThan(0.002);
    }
  });

  it('older PAD positions land on the same sound by name', () => {
    expect(remapPadTimbreV31(0)).toBeCloseTo(at('GLASS'));
    expect(remapPadTimbreV31(0.25)).toBeCloseTo(at('TINE'));
    expect(remapPadTimbreV31(0.5)).toBeCloseTo(at('WARM'));
    expect(remapPadTimbreV31(1)).toBeCloseTo(at('ETHEREAL'));
    // GLASS -> TINE are still neighbours: a third of the way stays a third of the way.
    expect(remapPadTimbreV31(1 / 12)).toBeCloseTo(at('GLASS') + (at('TINE') - at('GLASS')) / 3);
    // TINE -> WARM no longer are: the nearer one.
    expect(remapPadTimbreV31(0.3)).toBeCloseTo(at('TINE'));
    expect(remapPadTimbreV31(0.45)).toBeCloseTo(at('WARM'));
  });

  it('a v31 save keeps its PAD sound by name, the new sound under its SOUND page trims', () => {
    const p = createDefaultProject();
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    stored.version = 31;
    const pad = stored.channels[5];
    pad.sounds.pad.timbre = 0; // GLASS in the old order
    pad.sounds.pad.fm = 0.99; // an old engine value: rebuilt from the new sound
    pad.trims.pad = { cutoff: -0.1 };
    pad.presets.pad = 0; // GLASS
    pad.patterns[0].steps = [{ i: 0, n: 57, v: 0.8, l: { timbre: 0.5 } }]; // WARM, locked
    const q = fromStored(stored)!.channels[5];
    const s = q.sounds.pad!;
    expect(s.timbre).toBeCloseTo(at('GLASS'));
    const hidden = hiddenSound('pad', s, INSTRUMENTS.pad.params);
    expect(s.fm).toBeCloseTo(hidden.fm);
    expect(s.cutoff).toBeCloseTo(applyTrim(paramSpec('pad', 'cutoff')!, hidden.cutoff, -0.1));
    expect(q.trims.pad!.cutoff).toBeCloseTo(-0.1);
    expect(INSTRUMENTS.pad.presets[q.presets.pad!].name).toBe('GLASS');
    expect(q.patterns[0].steps[0].locks!.timbre).toBeCloseTo(at('WARM'));
  });
});

describe('v33: OCTAVE -4 ... +4', () => {
  const spec = (k: 'bass' | 'pad' | 'lead' | 'pluck') => INSTRUMENTS[k].params.find((p) => p.id === 'octave')!;

  it('nine octaves, 0 in the middle; LEAD starts one up', () => {
    for (const k of ['bass', 'pad', 'lead', 'pluck'] as const) expect(spec(k).options).toEqual(['-4', '-3', '-2', '-1', '0', '+1', '+2', '+3', '+4']);
    expect(spec('bass').options![spec('bass').defaultValue]).toBe('0');
    expect(spec('lead').options![spec('lead').defaultValue]).toBe('+1');
  });

  it('OCTAVE +4 plays four octaves above 0', () => {
    const pitch = (oct: number, note = 33) => {
      const s = new Synth(SR, LEAD_PARAMS, LEAD_FIXED);
      const sound: Record<string, number> = { ...presetSound('lead', 0), octave: oct, fm: 0, carriers: 0, shape: 0, cutoff: 20000, fenv: 0 };
      for (const id in sound) s.setParam(id, sound[id]);
      s.noteOn(note, 1, note, false);
      const l = new Float32Array(SR / 4);
      s.render(l, new Float32Array(l.length), 0, l.length);
      let z = 0;
      for (let i = SR / 8; i < l.length; i++) if (l[i - 1] < 0 && l[i] >= 0) z++;
      return z / (l.length / SR - 0.125);
    };
    expect(pitch(8) / pitch(4)).toBeCloseTo(16, 0);
    expect(pitch(4, 93) / pitch(0, 93)).toBeCloseTo(16, 0);
  });

  it('older saves keep their octave (sounds, pattern patches and locks)', () => {
    const p = createDefaultProject();
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    stored.version = 32;
    stored.channels[4].sounds.bass.octave = 1; // -1 then
    stored.channels[6].sounds.lead.octave = 3; // +1 then (LEAD's default)
    stored.channels[6].patterns[0].steps = [{ i: 0, n: 57, v: 0.8, l: { octave: 4 } }]; // +2 then
    const q = fromStored(stored)!;
    expect(spec('bass').options![q.channels[4].sounds.bass!.octave]).toBe('-1');
    expect(spec('lead').options![q.channels[6].patterns[0].steps[0].locks!.octave]).toBe('+2');
    expect(spec('lead').options![q.channels[6].sounds.lead!.octave]).toBe('+1');
  });
});

describe('BASS trills: letting go of the slid-to note slides back', () => {
  it('A held, B slid to, B let go: back to A (still held), A let go: silence', () => {
    const p = createDefaultProject();
    p.channels.forEach((c, i) => { c.mute = i !== 4; });
    const e = new Engine(SR);
    e.handleMessage({ type: 'loadProject', project: p });
    const sound: Record<string, number> = { ...presetSound('bass', 0), sustain: 1, glide: 0.01, release: 0.02 };
    for (const id in sound) e.handleMessage({ type: 'setSound', channel: 4, id, value: sound[id] });
    const L = new Float32Array(128), R = new Float32Array(128);
    // Pitch from zero crossings over `secs`.
    const listen = (secs: number) => {
      const buf: number[] = [];
      for (let b = 0; b < (secs * SR) / 128; b++) { e.process(L, R, 128); buf.push(...L); }
      const tail = buf.slice(buf.length / 2);
      let z = 0;
      for (let i = 1; i < tail.length; i++) if (tail[i - 1] < 0 && tail[i] >= 0) z++;
      return { hz: z / (tail.length / SR), peak: Math.max(...tail.map(Math.abs)) };
    };
    const A = 45, B = 52;
    // What the app sends: A down; B down while A held; B up (A still held); A up.
    e.handleMessage({ type: 'trigger', channel: 4, note: A, velocity: 0.8 });
    const a1 = listen(0.3);
    e.handleMessage({ type: 'trigger', channel: 4, note: B, velocity: 0.8, slideFrom: A });
    const b = listen(0.3);
    e.handleMessage({ type: 'trigger', channel: 4, note: A, velocity: 0.8, slideFrom: B });
    const a2 = listen(0.3);
    expect(b.hz / a1.hz).toBeCloseTo(Math.pow(2, (B - A) / 12), 1);
    expect(a2.hz / a1.hz).toBeCloseTo(1, 1);
    expect(a2.peak).toBeGreaterThan(0.5 * a1.peak); // still sounding, not released
    e.handleMessage({ type: 'release', channel: 4, note: A });
    expect(listen(0.5).peak).toBeLessThan(1e-3);
  });
});

describe('v34: half / double time per pattern', () => {
  const setup = (speed: 'normal' | 'double' | 'half') => {
    const p = createDefaultProject();
    p.bpm = 120;
    p.channels.forEach((c, i) => { c.mute = i !== 0; });
    const pat = p.channels[0].patterns[0];
    pat.length = 16;
    if (speed !== 'normal') pat.speed = speed;
    for (let i = 0; i < 16; i++) Object.assign(pat.steps[i], { active: true, note: 36 });
    const e = new Engine(SR);
    e.handleMessage({ type: 'loadProject', project: p });
    // Every hit's frame.
    const hits: number[] = [];
    let frame = 0;
    const inst = (e as unknown as { current: { noteOn: (...a: unknown[]) => void }[] }).current[0];
    const orig = inst.noteOn.bind(inst);
    inst.noteOn = (...a: unknown[]) => { hits.push(frame); orig(...a); };
    const L = new Float32Array(128), R = new Float32Array(128);
    const run = (frames: number) => { for (let k = 0; k < frames / 128; k++) { e.process(L, R, 128); frame += 128; } };
    return { e, hits, run };
  };
  const bar = (SR * 60 * 4) / 120; // one bar at 120 BPM

  it('a bar plays 16 steps, 32 in double time, 8 in half time, evenly spaced', () => {
    for (const [speed, count] of [['normal', 16], ['double', 32], ['half', 8]] as const) {
      const { e, hits, run } = setup(speed);
      e.handleMessage({ type: 'transport', playing: true });
      run(bar - 128);
      expect(hits.length, speed).toBe(count);
      const gap = bar / count;
      for (let i = 1; i < hits.length; i++) expect(Math.abs(hits[i] - hits[i - 1] - gap), `${speed} ${i}`).toBeLessThanOrEqual(128);
    }
  });

  it('switching speed takes effect on the next steps', () => {
    const { e, hits, run } = setup('normal');
    e.handleMessage({ type: 'transport', playing: true });
    run(bar / 2 - 128); // 8 steps
    e.handleMessage({ type: 'setPatternSpeed', channel: 0, pattern: 0, speed: 'double' });
    run(bar / 2);
    expect(hits.length).toBe(8 + 16);
  });

  it('live recording in half time lands on the track\'s own step', () => {
    const { e, run } = setup('half');
    const pat = 0;
    e.handleMessage({ type: 'setPatternLength', channel: 4, pattern: pat, length: 16 });
    e.handleMessage({ type: 'setPatternSpeed', channel: 4, pattern: pat, speed: 'half' });
    const got: number[] = [];
    e.onRecorded = (m) => { if (m.type === 'recordedNote') got.push(m.index); };
    e.handleMessage({ type: 'transport', playing: true });
    // Half time: a track step is two master 16ths. Play at the start of track step 5 (+ the
    // limiter's look-ahead, so it is heard there).
    const look = (e as unknown as { latency: number }).latency;
    run(Math.round(((5 * 2 * bar) / 16 + look) / 128) * 128);
    e.handleMessage({ type: 'recordNote', channel: 4, note: 45, velocity: 0.8, accent: false });
    expect(got[0]).toBe(5);
  });
});

describe('v34: pattern speed is saved', () => {
  it('round-trips speed, also in the saved notes', () => {
    const p = createDefaultProject();
    const pat = p.channels[4].patterns[1];
    pat.speed = 'half';
    pat.savedNotes = { length: 16, steps: pat.steps.map((s) => ({ ...s })), speed: 'double' };
    pat.notesDirty = true;
    const q = fromStored(JSON.parse(JSON.stringify(toStored(p))))!;
    expect(q.channels[4].patterns[1].speed).toBe('half');
    expect(q.channels[4].patterns[1].savedNotes!.speed).toBe('double');
    expect(q.channels[4].patterns[0].speed).toBeUndefined();
  });
});

describe('PAD chords on one step', () => {
  const setup = (chord: string, notes: number[], slide = false, next?: number) => {
    const p = createDefaultProject();
    p.channels.forEach((c, i) => { c.mute = i !== 5; });
    const pad = p.channels[5];
    pad.chord = CHORD_LIST.indexOf(chord);
    const pat = pad.patterns[0];
    pat.length = 16;
    Object.assign(pat.steps[0], { active: true, note: notes[0], gate: 2, slide });
    pat.steps[0].extra = notes.slice(1);
    if (next !== undefined) Object.assign(pat.steps[2], { active: true, note: next, gate: 2 });
    const e = new Engine(SR);
    e.handleMessage({ type: 'loadProject', project: p });
    const played: number[] = [];
    const inst = (e as unknown as { current: Synth[] }).current[5];
    const orig = inst.noteOn.bind(inst);
    inst.noteOn = (note: number, ...a: unknown[]) => { played.push(note); (orig as (...x: unknown[]) => void)(note, ...a); };
    const L = new Float32Array(128), R = new Float32Array(128);
    const run = (frames: number) => { for (let k = 0; k < frames / 128; k++) e.process(L, R, 128); };
    const held = () => (inst as unknown as { voices: { stage: number[] }[] }).voices.filter((v) => v.stage[0] === 1 || v.stage[0] === 2 || v.stage[0] === 3).length;
    return { e, played, run, held };
  };

  it('CHORD OFF: all six notes of the step play', () => {
    const { e, played, run, held } = setup('OFF', [57, 60, 64, 67, 71, 74]);
    e.handleMessage({ type: 'transport', playing: true });
    run(2048);
    expect(played.sort((a, b) => a - b)).toEqual([57, 60, 64, 67, 71, 74]);
    expect(held()).toBe(6);
  });

  it('a CHORD on: only the lowest note plays, as the chord\'s root', () => {
    const { e, played, run } = setup('MIN7', [64, 57, 67]);
    e.handleMessage({ type: 'transport', playing: true });
    run(2048);
    expect(played.sort((a, b) => a - b)).toEqual([57, 60, 64, 67]); // A min7 on 57
  });

  it('a chord sliding into one note leaves no voice behind', () => {
    const { e, run, held } = setup('OFF', [57, 60, 64], true, 62);
    e.handleMessage({ type: 'transport', playing: true });
    run(Math.round((60 / 128 / 4) * SR * 2.5)); // into step 2
    expect(held()).toBe(1);
  });

  it('live recording: notes played together land on one step', () => {
    const p = createDefaultProject();
    const e = new Engine(SR);
    e.handleMessage({ type: 'loadProject', project: p });
    const got: string[] = [];
    e.onRecorded = (m) => { if (m.type !== 'recordedLock') got.push(`${m.type} ${m.index} ${'note' in m ? m.note : ''}`); };
    e.handleMessage({ type: 'transport', playing: true });
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let k = 0; k < 40; k++) e.process(L, R, 128);
    e.handleMessage({ type: 'recordNote', channel: 5, note: 57, velocity: 0.8, accent: false });
    e.handleMessage({ type: 'recordNote', channel: 5, note: 61, velocity: 0.8, accent: false, chord: true });
    e.handleMessage({ type: 'recordNote', channel: 5, note: 64, velocity: 0.8, accent: false, chord: true });
    const step = got[0].split(' ')[1];
    expect(got).toEqual([`recordedNote ${step} 57`, `recordedChord ${step} 61`, `recordedChord ${step} 64`]);
  });

  it('chords are saved; only 6 notes a step', () => {
    const p = createDefaultProject();
    const s = p.channels[5].patterns[0].steps[3];
    Object.assign(s, { active: true, note: 50 });
    s.extra = [53, 57, 60, 64, 67, 71];
    const q = fromStored(JSON.parse(JSON.stringify(toStored(p))))!;
    expect(q.channels[5].patterns[0].steps[3].extra).toEqual([53, 57, 60, 64, 67]);
  });
});

describe('v36: time signature, STEPS, triplet time', () => {
  const bar = (SR * 60 * 4) / 120; // one 4/4 bar at 120 BPM
  const sixteenth = bar / 16;
  /** Track 1 alone, every step of pattern A on (note 36 + index), pattern B notes 80 + index. */
  const setup = (opts: { meter?: number; speed?: 'triplet'; flips?: number[] } = {}) => {
    const p = createDefaultProject();
    p.bpm = 120;
    p.meter = opts.meter ?? 0;
    p.channels.forEach((c, i) => { c.mute = i !== 0; });
    const pat = p.channels[0].patterns[0];
    if (opts.speed) pat.speed = opts.speed;
    for (let i = 0; i < 16; i++) Object.assign(pat.steps[i], { active: true, note: 36 + i });
    for (const i of opts.flips ?? []) pat.steps[i].flip = true;
    for (let i = 0; i < 16; i++) Object.assign(p.channels[0].patterns[1].steps[i], { active: true, note: 80 + i });
    const e = new Engine(SR);
    e.handleMessage({ type: 'loadProject', project: p });
    const hits: { frame: number; note: number }[] = [];
    let frame = 0;
    const inst = (e as unknown as { current: { noteOn: (...a: unknown[]) => void }[] }).current[0];
    const orig = inst.noteOn.bind(inst);
    inst.noteOn = (...a: unknown[]) => { hits.push({ frame, note: a[0] as number }); orig(...a); };
    const L = new Float32Array(128), R = new Float32Array(128);
    const run = (frames: number) => { for (let k = 0; k < Math.round(frames / 128); k++) { e.process(L, R, 128); frame += 128; } };
    return { e, hits, run };
  };
  const meter = (name: string) => METERS.findIndex((m) => m.name === name);

  it('3/4: a bar is 12 steps; the last group of the strip is dark and takes no time', () => {
    const { e, hits, run } = setup({ meter: meter('3/4') });
    e.handleMessage({ type: 'transport', playing: true });
    run(24 * sixteenth - 64);
    expect(hits.map((h) => h.note - 36)).toEqual([...Array(12).keys(), ...Array(12).keys()]);
    hits.forEach((h, i) => expect(Math.abs(h.frame - i * sixteenth)).toBeLessThanOrEqual(128));
    expect(e.barSteps).toBe(12);
  });

  it('7/8: groups of 4 + 3 + 4 + 3 (steps 8 and 16 of the strip dark)', () => {
    const { e, hits, run } = setup({ meter: meter('7/8') });
    e.handleMessage({ type: 'transport', playing: true });
    run(14 * sixteenth - 64);
    expect(hits.map((h) => h.note - 36)).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('triplet time: the 4th step of each group dark, three steps to each beat', () => {
    const { e, hits, run } = setup({ speed: 'triplet' });
    e.handleMessage({ type: 'transport', playing: true });
    run(bar - 64);
    expect(hits.map((h) => h.note - 36)).toEqual([0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14]);
    hits.forEach((h, i) => expect(Math.abs(h.frame - (i * bar) / 12)).toBeLessThanOrEqual(128));
  });

  it('STEPS: a step switched off takes no time, so the track drifts; switched on in 3/4 it plays', () => {
    const { e, hits, run } = setup({ flips: [15] });
    e.handleMessage({ type: 'transport', playing: true });
    run(2 * bar - 64);
    expect(hits.length).toBe(32);
    expect(hits[15].note).toBe(36); // the second loop starts a step early
    const t = setup({ meter: meter('3/4'), flips: [13] });
    t.e.handleMessage({ type: 'transport', playing: true });
    t.run(13 * sixteenth - 64);
    expect(t.hits.map((h) => h.note - 36)).toEqual([...Array(12).keys(), 13]);
  });

  it('a drifting track switches pattern on the next bar line, from its first step', () => {
    const { e, hits, run } = setup({ flips: [15] });
    e.handleMessage({ type: 'transport', playing: true });
    run(bar + 4 * sixteenth); // its loop started off the bar line (step 16 of the bar)
    e.handleMessage({ type: 'selectPattern', channel: 0, pattern: 1, immediate: false });
    run(bar);
    const first = hits.find((h) => h.note >= 80)!;
    expect(Math.abs(first.frame - 2 * bar)).toBeLessThanOrEqual(128);
    expect(first.note).toBe(80);
  });

  it('a track in step with the bar switches at its loop end (a bar line)', () => {
    const { e, hits, run } = setup();
    e.handleMessage({ type: 'transport', playing: true });
    run(4 * sixteenth);
    e.handleMessage({ type: 'selectPattern', channel: 0, pattern: 1, immediate: false });
    run(bar);
    const first = hits.find((h) => h.note >= 80)!;
    expect(Math.abs(first.frame - bar)).toBeLessThanOrEqual(128);
  });

  it('TIME SIG while playing changes at the next bar line', () => {
    const { e, hits, run } = setup();
    e.handleMessage({ type: 'transport', playing: true });
    run(4 * sixteenth);
    e.handleMessage({ type: 'setGlobal', id: 'meter', value: meter('3/4') });
    expect(e.barSteps).toBe(16);
    run(bar + 8 * sixteenth - 512);
    expect(e.barSteps).toBe(12);
    expect(hits.map((h) => h.note - 36)).toEqual([...Array(16).keys(), ...Array(12).keys()]);
  });

  it('live recording lands on a playing step (dark ones skipped)', () => {
    const { e, run } = setup({ meter: meter('7/8') });
    const got: number[] = [];
    e.onRecorded = (m) => { if (m.type === 'recordedNote') got.push(m.index); };
    e.handleMessage({ type: 'transport', playing: true });
    const look = (e as unknown as { latency: number }).latency;
    run(Math.round((7 * sixteenth + look) / 128) * 128); // the 8th played step = strip step 9
    e.handleMessage({ type: 'recordNote', channel: 0, note: 40, velocity: 0.8, accent: false });
    expect(got[0]).toBe(8);
  });

  it('saves the time signature, STEPS and triplet time', () => {
    const p = createDefaultProject();
    p.meter = meter('7/8');
    const pat = p.channels[4].patterns[2];
    pat.speed = 'triplet';
    pat.steps[5].flip = true;
    const q = fromStored(JSON.parse(JSON.stringify(toStored(p))))!;
    expect(q.meter).toBe(p.meter);
    expect(q.channels[4].patterns[2].speed).toBe('triplet');
    expect(q.channels[4].patterns[2].steps.map((s, i) => (s.flip ? i : -1)).filter((i) => i >= 0)).toEqual([5]);
    expect(fromStored({ ...toStored(createDefaultProject()), meter: undefined })!.meter).toBe(0);
  });

  it('stepPlays: meter, triplet and flip together', () => {
    expect(stepPlays(meter('3/4'), undefined, 12, false)).toBe(false);
    expect(stepPlays(meter('3/4'), undefined, 12, true)).toBe(true);
    expect(stepPlays(0, 'triplet', 19, false)).toBe(false);
    expect(stepPlays(0, 'triplet', 18, true)).toBe(false);
  });
});

describe('v37: the new RIDE', () => {
  it('a saved hat on RIDE takes the new bell ride, its SOUND page trims kept', () => {
    const p = createDefaultProject();
    const hat = p.channels[2];
    applyPreset(hat, 'hat', 0);
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    stored.version = 36;
    // As saved by v36: the old tonal ride (FM metal at 1150 Hz), with a CUTOFF-like trim.
    Object.assign(stored.channels[2].sounds.hat, { m_mode: 2, m_pitch: 1150, h_mode: 2, h_pitch: 1500 });
    stored.channels[2].trims = { hat: { m_tone: 0.05 } };
    const q = fromStored(stored)!.channels[2];
    expect(q.sounds.hat!.m_mode).toBeCloseTo(1);
    expect(q.sounds.hat!.m_pitch).toBeCloseTo(640, 0);
    expect(q.sounds.hat!.h_mode).toBeCloseTo(1);
    expect(q.trims.hat!.m_tone).toBeCloseTo(0.05);
    expect(q.sounds.hat!.m_tone).toBeGreaterThan(2400);
  });
});
