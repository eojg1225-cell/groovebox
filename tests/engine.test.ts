import { describe, expect, it } from 'vitest';
import { Engine, hitToneCutoff, type RecordedMsg } from '../src/engine/Engine';
import { toNorm, toValue } from '../src/engine/params';
import { GLOBAL_PARAMS, MIX_PARAMS } from '../src/engine/mixParams';
import { emptyPattern, type Project, type SoundKind } from '../src/engine/project';
import { fromStored, toStored } from '../src/engine/projectFile';
import { applyPreset, createDefaultProject, createStartProject } from '../src/engine/defaultProject';
import { CHORDS } from '../src/engine/chords';
import { INSTRUMENTS, LIVE_MACROS, SOUND_KINDS, liveContribution, liveTargets, presetSound } from '../src/instruments/registry';
import { Drum, HAT_PARAMS, KICK_PARAMS, PERC_PARAMS, SNARE_PARAMS } from '../src/instruments/Drum';
import { Synth, PAD_FIXED, PAD_PARAMS, LEAD_FIXED, LEAD_PARAMS, dx7Index } from '../src/instruments/Synth';
import { midiToHz } from '../src/instruments/dsp';
import { Delay } from '../src/fx/Delay';
import { Distortion } from '../src/fx/Distortion';
import { MidCut } from '../src/fx/MidCut';

import { Chorus } from '../src/fx/Chorus';
import { Reverb } from '../src/fx/Reverb';
import { Compressor } from '../src/fx/Compressor';
import { Tape } from '../src/fx/Tape';
import { CEILING, Limiter } from '../src/fx/Limiter';
import { LFO_RATES, lfoValue } from '../src/engine/lfo';

/** An LFO rate's index by name. */
const RATE = (name: string) => LFO_RATES.findIndex((r) => r.name === name);
import { MACROS, RATIO_STEPS, anchorPosition, macroIds, macroSound, timbreName } from '../src/instruments/macros';
import { applyTrim, deriveTrims, hiddenSound, trimFor } from '../src/instruments/trims';
import { paramSpec } from '../src/instruments/registry';
import { soundPage, stepsOnStrip } from '../src/instruments/registry';
import { DrumBus, REVERSE_LENGTHS } from '../src/fx/DrumBus';

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

  it('sound page columns: TIMBRE/INTENSITY, element ATK/DECs, FILTER/RESO, FILTER ATK/DEC, DRIVE/CRUSH, tune pair, FLT ENV/hold', () => {
    expect(soundPage(['a1', 'd1', 'a2', 'd2'], ['t1', 't2'], ['l1', 'l2'])).toEqual([
      'timbre', 'a1', 'a2', 'cutoff', 'fattack', 'drive', 't1', 'l1',
      'intensity', 'd1', 'd2', 'reso', 'fdecay', 'crush', 't2', 'l2',
    ]);
    expect(INSTRUMENTS.kick.layout.slice(1, 3)).toEqual(['t_attack', 'c_attack']);
    expect(INSTRUMENTS.hat.layout.slice(9, 11)).toEqual(['c_len', 'm_decay']);
    expect(INSTRUMENTS.bass.layout.slice(1, 3)).toEqual(['attack', 'attack2']);
    expect([INSTRUMENTS.lead.layout[6], INSTRUMENTS.lead.layout[14]]).toEqual(['glide', 'detune']);
    expect([INSTRUMENTS.pad.layout[6], INSTRUMENTS.pad.layout[14]]).toEqual(['unison', 'detune']);
  });

  it('drum crush and drive keep the output bounded', () => {
    const d = new Drum(SR, SNARE_PARAMS);
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
      p.channels[2].patterns[0].steps[0].active = true; // hat
      p.channels[2].sounds.hat = { ...p.channels[2].sounds.hat!, cutoff };
      const e = engineWith(p);
      e.handleMessage({ type: 'transport', playing: true });
      const { l } = render(e, 0.05);
      let d = 0;
      for (let i = 1; i < l.length; i++) d += (l[i] - l[i - 1]) ** 2;
      return d;
    };
    expect(bright(500)).toBeLessThan(bright(20000) * 0.1);
  });

  describe('LO-FI', () => {
    /** RMS gain (dB) of a sine at freq / amp through LO-FI at `amount`. */
    const gainDb = (amount: number, freq: number, amp = 0.1) => {
      const t = new Tape(SR);
      t.setImmediate(amount);
      const n = SR / 2;
      const input = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * freq * i) / SR) * amp);
      const l = input.slice();
      t.process(l, l.slice(), n);
      const rms = (b: Float32Array) => Math.sqrt(b.subarray(n / 2).reduce((s, v) => s + v * v, 0) / (n / 2));
      return 20 * Math.log10(rms(l) / rms(input));
    };

    it('is bypassed at 0', () => {
      expect(Math.abs(gainDb(0, 900))).toBeLessThan(0.01);
    });

    it('half way: a gentle mid dip, lows and highs and quiet levels left alone', () => {
      expect(gainDb(0.5, 900)).toBeLessThan(-2);
      expect(gainDb(0.5, 900)).toBeGreaterThan(-4.5);
      expect(Math.abs(gainDb(0.5, 60))).toBeLessThan(1);
      expect(Math.abs(gainDb(0.5, 10000))).toBeLessThan(1.5);
    });

    it('saturation only rounds off peaks, gently in the main range', () => {
      const squash = (amount: number) => gainDb(amount, 60, 0.9) - gainDb(amount, 60, 0.05);
      expect(squash(0.3)).toBeGreaterThan(-1); // barely touches loud material
      expect(squash(0.6)).toBeLessThan(-0.3);
      expect(squash(0.6)).toBeGreaterThan(-3);
    });

    it('full: a noticeable degradation, still bounded', () => {
      expect(gainDb(1, 1040) - gainDb(1, 60)).toBeLessThan(-6); // the dip's centre at full, against the lows
      expect(gainDb(1, 12000) - gainDb(1, 60)).toBeLessThan(-3); // highs softened
      const t = new Tape(SR);
      t.setImmediate(1);
      const l = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i * 0.05) * 3);
      t.process(l, l.slice(), l.length);
      expect(stats(l).nan).toBe(false);
      expect(stats(l).peak).toBeLessThan(2);
    });
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

  it('chorus and compressor stay bounded', () => {
    const ch = new Chorus(SR);
    ch.setParam('cho_return', 1);
    const cmp = new Compressor(SR);
    cmp.setParam('cmp_return', 1);
    for (const out of [run(ch), run(cmp)]) {
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

  it('TIMBRE never changes tail lengths or the synths\' amp ADSR: they are the type\'s own', () => {
    const tails = ['t_decay', 'm_decay', 'ring', 'attack', 'attack2', 'decay', 'decay2', 'sustain', 'sustain2', 'release', 'release2'];
    for (const k of SOUND_KINDS) {
      const ids = macroIds(k, INSTRUMENTS[k].params);
      for (const id of tails) expect(ids.has(id), `${k} ${id}`).toBe(false);
      for (const e of MACROS[k].excite) expect(tails.includes(e.id), `${k} INTENSITY ${e.id}`).toBe(false);
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
    p.lofi = 0.4;
    p.sendWet[2][5] = 0.9;
    p.sendInt[1][0] = 0.8;
    p.fx1.rev_len = 3;
    p.fx1.lp_cutoff = 800;
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
    expect(fromStored(JSON.parse(JSON.stringify(toStored(p))))).toEqual(p);
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
    expect(k.live).toEqual(['macro:decay', 'macro:punch']);
    expect(k.liveFunc).toEqual(['mix:volume', 'macro:tune']);
    const now = toStored(createDefaultProject());
    now.channels[0].live = ['t_decay', 'mix:pan'];
    expect(fromStored(now)!.channels[0].live).toEqual(['t_decay', 'mix:pan']);
  });

  it('the start project holds the sequence in progress, with each type\'s live knobs (VOLUME on FUNC)', () => {
    const p = createStartProject();
    expect(p.channels[4].patterns[0].length).toBe(64);
    expect(p.channels.some((c) => c.patterns.some((pat) => pat.steps.some((st) => st.active)))).toBe(true);
    expect(p.channels[4].live).toEqual(['cutoff', 'reso']);
    expect(p.channels.every((c) => c.liveFunc[0] === 'mix:volume')).toBe(true);
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
    expect(energy({ lp_cutoff: 300 }).e).toBeLessThan(energy({}).e * 0.2);
    const loud = energy({ dst_drive: 60, dst_level: 2, lp_reso: 1, lp_cutoff: 2000 });
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

describe('drum element and filter envelopes', () => {
  const hit = (sound: Record<string, number>) => {
    const d = new Drum(SR, KICK_PARAMS);
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

  it('the filter envelope opens a closed filter on each hit', () => {
    // High-frequency content (sample-to-sample differences) over the first 50 ms.
    const hf = (l: Float32Array) => { let e = 0; for (let i = 1; i < SR * 0.05; i++) e += (l[i] - l[i - 1]) ** 2; return e; };
    const closed = hit({ c_level: 1, cutoff: 100, fenv: 0 });
    const opened = hit({ c_level: 1, cutoff: 100, fenv: 1.5, fdecay: 0.2 });
    expect(hf(opened)).toBeGreaterThan(hf(closed) * 10);
  });
  it('the drum FILTER darkens it', () => {
    const e = (l: Float32Array) => l.reduce((a, v) => a + v * v, 0);
    const bright = hit({ c_level: 1, cutoff: 20000 });
    const dark = hit({ c_level: 1, cutoff: 80 });
    expect(e(dark)).toBeLessThan(e(bright));
  });
});

describe('slides and rolls', () => {
  it('ROLL plays evenly spaced hits inside the step', () => {
    const p = kickProject([0, 4], { bpm: 120 });
    p.channels[0].sounds.kick = { ...p.channels[0].sounds.kick, t_decay: 0.01 };
    p.channels[0].patterns[0].steps[0].roll = 3; // 6000 frames / 3
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    near(onsets(render(e, 0.6).l), [0, 2000, 4000, 24000]);
  });

  const bass = () => {
    const s = new Synth(SR, INSTRUMENTS.bass.params, { voice: 1 });
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

  it('on drum tracks the SLIDE flag is ROLL at the sound\'s ROLL DIV (a count is overridden)', () => {
    const p = kickProject([0, 4], { bpm: 120 });
    p.channels[0].sounds.kick = { ...p.channels[0].sounds.kick, t_decay: 0.01, c_level: 0, rolldiv: 1 }; // 1/32T
    Object.assign(p.channels[0].patterns[0].steps[0], { slide: true, roll: 2 });
    const e = engineWith(p);
    e.handleMessage({ type: 'transport', playing: true });
    near(onsets(render(e, 0.6).l, 0.005, 1500), [0, 2000, 4000, 24000]);
    // ROLL DIV changes the roll.
    const e2 = engineWith(p);
    e2.handleMessage({ type: 'setSound', channel: 0, id: 'rolldiv', value: 0 }); // 1/32
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

  it('a SLIDE note holds its envelopes up (added sustain), then decays after landing', () => {
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
    held.noteOn(52, 1, 52, false, 45); // lands, not sliding on
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

describe('hat head and RING LEN', () => {
  const hat = (name: string, ring = false, extra: Record<string, number> = {}) => {
    const d = new Drum(SR, HAT_PARAMS);
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

  it('RING adds the sound\'s RING LEN to the decay (not a blown-out multiple)', () => {
    const tail = (l: Float32Array, t: number) => stats(l.subarray(SR * t, SR * t + 2400)).peak;
    const plain = hat('HAT', false, { ring: 0.5 });
    const ring = hat('HAT', true, { ring: 0.5 });
    expect(tail(plain, 0.3)).toBeLessThan(1e-3);
    expect(tail(ring, 0.3)).toBeGreaterThan(1e-3); // ~0.5 s open hat
    expect(tail(ring, 1.2)).toBeLessThan(1e-4); // ... and then gone
  });
});

describe('ETHEREAL pad', () => {
  it('the FM supersaw renders cleanly', () => {
    const s = new Synth(SR, PAD_PARAMS, PAD_FIXED);
    const sound = presetSound('pad', INSTRUMENTS.pad.presets.findIndex((p) => p.name === 'ETHEREAL'));
    expect(sound.unison).toBeGreaterThan(0.5);
    expect(sound.fmratio).toBe(1.5);
    for (const id in sound) s.setParam(id, sound[id]);
    for (const n of [57, 60, 64, 67]) s.noteOn(n, 0.8, 57);
    const l = new Float32Array(SR * 2);
    s.render(l, new Float32Array(SR * 2), 0, l.length);
    const st = stats(l);
    expect(st.nan).toBe(false);
    expect(st.peak).toBeGreaterThan(0.05);
    expect(st.peak).toBeLessThan(3);
  });
});

describe('short DECAY cuts sustain and release', () => {
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

  it('a held pad chord sustains at a long DECAY, becomes a stab when short, a click at the bottom', () => {
    const held = padChord(1.2);
    const stab = padChord(0.1);
    const click = padChord(0.005);
    expect(at(held, 0.5)).toBeGreaterThan(0.05);
    expect(at(stab, 0.02)).toBeGreaterThan(0.05);
    expect(at(stab, 0.5)).toBeLessThan(at(held, 0.5) * 0.05);
    expect(at(click, 0.03)).toBeLessThan(at(held, 0.03) * 0.05);
  });

  it('a stab released early does not ring on for the pad\'s long RELEASE', () => {
    const stab = padChord(0.1, SR * 0.05);
    expect(at(stab, 0.4)).toBeLessThan(1e-3);
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
      const d = new Drum(SR, PERC_PARAMS);
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
    expect(p.channels[3].fx1).toBe(true);
    expect(p.channels[7].fxSend).toBe(2);
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
      const d = new Drum(SR, HAT_PARAMS);
      const sound: Record<string, number> = { ...presetSound('hat', INSTRUMENTS.hat.presets.findIndex((p) => p.name === 'HAT')), c_level: 0, ring: 0.5, m_decay: mDecay };
      for (const id in sound) d.setParam(id, sound[id]);
      d.noteOn(36, 1, 36, true);
      const l = new Float32Array(SR * 3);
      d.render(l, new Float32Array(SR * 3), 0, l.length);
      return stats(l.subarray(SR * 1.2, SR * 1.3)).peak;
    };
    expect(tail(0.07)).toBeLessThan(1e-4); // a short hat rings about 0.7 s
    expect(tail(0.4)).toBeGreaterThan(1e-3); // a longer one rings well past a second
  });
});

describe('PLUCK and ARP', () => {
  it('has its five sounds, from steel to the FM donk, with CHORD and ARP on the SOUND page', () => {
    expect(INSTRUMENTS.pluck.presets.map((p) => p.name)).toEqual(['STEEL', 'GLASS PLUCK', 'SAW PLUCK', 'SQUARE PLUCK', 'RAGE DONK']);
    const l = INSTRUMENTS.pluck.layout;
    expect([l[6], l[14], l[7], l[15]]).toEqual(['track:chord', 'arpoct', 'arp', 'arprate']);
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
      for (const id of entry.funcLayout) if (id) expect(entry.params.some((p) => p.id === id), `${k}:${id}`).toBe(true);
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
    const bass = presetSound('bass', 1);
    expect(bass.sustain2).toBe(bass.sustain);
    expect(bass.release2).toBe(bass.release);
    const p = createDefaultProject();
    p.channels[4].sounds.bass = { ...p.channels[4].sounds.bass!, sustain: 0.2, release: 3 };
    p.channels[4].liveFunc = ['fm', 'mix:pan'];
    const stored = JSON.parse(JSON.stringify(toStored(p)));
    const q = fromStored(stored)!;
    expect(q.channels[4].liveFunc).toEqual(['fm', 'mix:pan']);
    delete stored.channels[4].sounds.bass.sustain2;
    delete stored.channels[4].sounds.bass.release2;
    stored.version = 13;
    const old = fromStored(stored)!.channels[4].sounds.bass!;
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
    expect(p.channels[0].live).toEqual(['macro:decay', 'macro:punch']);
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
    const p = createDefaultProject();
    const sound = { ...p.channels[5].sounds.pad!, cutoff: 333, intensity: 0.2 };
    p.channels[5].sounds.pad = sound;
    const old = { ...JSON.parse(JSON.stringify(toStored(p))), version: 16 };
    delete old.channels[5].trims;
    const q = fromStored(old)!.channels[5];
    expect(q.sounds.pad!.cutoff).toBeCloseTo(333);
    const trims = q.trims.pad!;
    const hidden = hiddenSound('pad', q.sounds.pad!, INSTRUMENTS.pad.params);
    for (const id of macroIds('pad', INSTRUMENTS.pad.params)) {
      const spec = paramSpec('pad', id)!;
      expect(applyTrim(spec, hidden[id], trims[id]), id).toBeCloseTo(q.sounds.pad![id], 4);
    }
    expect(deriveTrims('pad', presetSound('pad', 1), INSTRUMENTS.pad.params)).toEqual({});
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
    let diff = 0;
    for (let i = 2000; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff / a.length).toBeGreaterThan(0.01);
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
    expect(names('bass')).toEqual(['SINE SUB', 'SOLID', '303', 'GROWL', 'FM CLANG']);
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
    expect(q.carriers).toBeCloseTo(0.45);
  });
});

describe('CHORD / LEAD / PLUCK level, CHORD stabs, FLT DEC curve', () => {
  it('the sustained synths sit -14 dB; older saves scale VOLUME up so the mix is unchanged', () => {
    for (const k of ['pad', 'lead', 'pluck'] as const) expect(INSTRUMENTS[k].gain).toBeCloseTo(0.2);
    expect(INSTRUMENTS.bass.gain ?? 1).toBe(1);
    const p = createDefaultProject();
    expect(p.channels[5].volume).toBe(0.5);
    p.channels[6].volume = 0.1; // LEAD at 10 % before the trim
    p.channels[0].volume = 0.8;
    const old = { ...JSON.parse(JSON.stringify(toStored(p))), version: 19 };
    const q = fromStored(old)!;
    expect(q.channels[6].volume).toBeCloseTo(0.5);
    expect(q.channels[0].volume).toBeCloseTo(0.8);
  });

  it('CHORD (the pad track) is set up for stabs', () => {
    expect(INSTRUMENTS.pad.name).toBe('CHORD');
    const s = presetSound('pad', 0);
    expect(s.sustain).toBe(0);
    expect(s.attack).toBeLessThan(0.01);
  });

  it('FLT DEC: 1 s sits at the middle of the knob, the range is unchanged', () => {
    const spec = paramSpec('pad', 'fdecay')!;
    expect(toValue(spec, 0.5)).toBeCloseTo(1, 3);
    expect(toValue(spec, 0)).toBeCloseTo(0.002);
    expect(toValue(spec, 1)).toBeCloseTo(10);
    expect(toNorm(spec, 1)).toBeCloseTo(0.5, 3);
  });
});
