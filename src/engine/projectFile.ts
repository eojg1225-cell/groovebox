/**
 * Stored project format, used for every save (session, saved project, cloud mirror).
 *
 * Compact: only steps with a note are written. The reader is deliberately forgiving:
 * it accepts this format AND full project objects from any earlier version, and
 * carries over everything it can recognise (notes and pattern lengths first, then
 * mixer, sounds, FX), filling the rest from defaults. Notes are never dropped just
 * because the rest of the format changed.
 */
import {
  MAX_ROLL, MAX_STEPS, NUM_CHANNELS, NUM_PATTERNS, NUM_SENDS, PROJECT_VERSION,
  type ChannelState, type Project, type SoundKind,
} from './project';
import { applyPreset, createDefaultProject } from './defaultProject';
import { INSTRUMENTS, SOUND_KINDS, presetSound } from '../instruments/registry';
import { DRUM_BUS_PARAMS, EFFECTS } from '../fx';
import { CHORD_NAMES, CHORD_NAMES_V5 } from './chords';
import { BPM_MAX, BPM_MIN } from './mixParams';
import { LFO_RATES, LFO_SHAPES, type LfoState } from './lfo';

export const FILE_FORMAT = 'groovebox-project';

/**
 * One step with a note: index, note, velocity; gate/accent/ring/slide/roll/locks only when set.
 * A rest marker is stored as { i, x: 1 } (no note).
 */
export interface StoredStep {
  i: number;
  n?: number;
  v?: number;
  g?: number;
  a?: 1;
  r?: 1;
  s?: 1;
  k?: number;
  x?: 1;
  l?: Record<string, number>;
}

export interface StoredPattern {
  len: number;
  steps: StoredStep[];
}

export interface StoredChannel {
  instrument: string;
  sounds: Record<string, Record<string, number>>;
  presets: Record<string, number>;
  live: string[];
  chord: number;
  volume: number;
  pan: number;
  cutoff: number;
  fx1: boolean;
  fxSend: number;
  sendLevel: number;
  lfo: LfoState;
  mute: boolean;
  activePattern: number;
  patterns: StoredPattern[];
}

export interface StoredProject {
  format: typeof FILE_FORMAT;
  version: number;
  bpm: number;
  swing: number;
  master: number;
  fx1: Record<string, number>;
  sendWet: number[][];
  sendInt: number[][];
  lofi: number;
  channels: StoredChannel[];
}

export function toStored(p: Project): StoredProject {
  return {
    format: FILE_FORMAT,
    version: PROJECT_VERSION,
    bpm: p.bpm,
    swing: p.swing,
    master: p.master,
    fx1: { ...p.fx1 },
    sendWet: p.sendWet.map((row) => [...row]),
    sendInt: p.sendInt.map((row) => [...row]),
    lofi: p.lofi,
    channels: p.channels.map((c) => ({
      instrument: c.instrument,
      sounds: JSON.parse(JSON.stringify(c.sounds)) as Record<string, Record<string, number>>,
      presets: { ...c.presets } as Record<string, number>,
      live: [...c.live],
      chord: c.chord,
      volume: c.volume,
      pan: c.pan,
      cutoff: c.cutoff,
      fx1: c.fx1,
      fxSend: c.fxSend,
      sendLevel: c.sendLevel,
      lfo: { ...c.lfo },
      mute: c.mute,
      activePattern: c.activePattern,
      patterns: c.patterns.map((pat) => ({
        len: pat.length,
        steps: pat.steps.flatMap((s, i): StoredStep[] => {
          if (!s.active) return s.rest ? [{ i, x: 1 }] : [];
          const out: StoredStep = { i, n: s.note, v: s.velocity };
          if (s.gate > 1) out.g = s.gate;
          if (s.accent) out.a = 1;
          if (s.ring) out.r = 1;
          if (s.slide) out.s = 1;
          if (s.roll && s.roll > 1) out.k = s.roll;
          if (s.locks && Object.keys(s.locks).length) out.l = { ...s.locks };
          return [out];
        }),
      })),
    })),
  };
}

// ---------------------------------------------------------------- forgiving reader

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown, fallback: number, min = -Infinity, max = Infinity): number =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;

function numbers(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isObj(x)) for (const k in x) if (typeof x[k] === 'number' && Number.isFinite(x[k])) out[k] = x[k] as number;
  return out;
}

/** Steps of a stored pattern in either shape: compact `steps: StoredStep[]` or full `steps: Step[64]`. */
interface ReadStep {
  i: number; note: number; vel: number; gate: number; accent: boolean; ring: boolean; rest: boolean;
  slide: boolean; roll: number;
  locks?: Record<string, number>;
}

function readSteps(pattern: Obj): ReadStep[] {
  const steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  const out: ReadStep[] = [];
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    if (!isObj(s)) continue;
    const compact = typeof s.i === 'number';
    const i = compact ? s.i as number : k;
    if (!Number.isInteger(i) || i < 0 || i >= MAX_STEPS) continue;
    if (compact ? s.x === 1 : s.active !== true && s.rest === true) {
      out.push({ i, rest: true, note: 36, vel: 0.8, gate: 1, accent: false, ring: false, slide: false, roll: 1 });
      continue;
    }
    if (!compact && s.active !== true) continue;
    const locks = numbers(compact ? s.l : s.locks);
    out.push({
      i,
      note: num(compact ? s.n : s.note, 36, 0, 127),
      vel: num(compact ? s.v : s.velocity, 0.8, 0, 1),
      gate: Math.round(num(compact ? s.g : s.gate, 1, 1, MAX_STEPS)),
      accent: compact ? s.a === 1 : s.accent === true,
      ring: compact ? s.r === 1 : s.ring === true,
      slide: compact ? s.s === 1 : s.slide === true,
      roll: Math.round(num(compact ? s.k : s.roll, 1, 1, MAX_ROLL)),
      rest: false,
      locks: Object.keys(locks).length ? locks : undefined,
    });
  }
  return out;
}

function readChannel(src: Obj, ch: ChannelState, version: number): void {
  const kind = src.instrument;
  if (typeof kind === 'string' && (SOUND_KINDS as string[]).includes(kind) && kind !== ch.instrument) {
    applyPreset(ch, kind as SoundKind, 0);
  }
  // Sounds: keep values for parameters this version knows.
  if (isObj(src.sounds)) {
    for (const k of SOUND_KINDS) {
      const values = numbers(src.sounds[k]);
      const known = new Set(INSTRUMENTS[k].params.map((p) => p.id));
      // Synths before the continuous SHAPE stored a stepped wave (SAW, SQR, TRI, SINE).
      if (values.wave !== undefined && values.shape === undefined && known.has('shape')) {
        values.shape = [2, 3, 1, 0][Math.round(values.wave)] ?? 2;
      }
      const kept = Object.fromEntries(Object.entries(values).filter(([id]) => known.has(id)));
      if (Object.keys(kept).length) ch.sounds[k] = { ...(ch.sounds[k] ?? presetSound(k, 0)), ...kept };
    }
  }
  if (isObj(src.presets)) {
    for (const k of SOUND_KINDS) if (typeof src.presets[k] === 'number') ch.presets[k] = src.presets[k] as number;
  }
  // Before v5 the live knobs followed the preset; from v5 they default to VOLUME/CUTOFF
  // and only a choice made since is kept.
  if (version >= 5 && Array.isArray(src.live) && src.live.length === 2 && src.live.every((x) => typeof x === 'string')) {
    ch.live = [src.live[0] as string, src.live[1] as string];
  }
  // Chords are stored by index; before v6 the list had no MAJOR/MINOR, so map by name.
  const chord = Math.round(num(src.chord, ch.chord, 0, 64));
  ch.chord = version < 6 ? Math.max(0, CHORD_NAMES.indexOf(CHORD_NAMES_V5[chord] ?? 'OFF')) : Math.min(chord, CHORD_NAMES.length - 1);
  if (isObj(src.lfo)) {
    ch.lfo.rate = Math.round(num(src.lfo.rate, ch.lfo.rate, 0, LFO_RATES.length - 1));
    ch.lfo.shape = Math.round(num(src.lfo.shape, ch.lfo.shape, 0, LFO_SHAPES.length - 1));
    ch.lfo.vol = num(src.lfo.vol, ch.lfo.vol, 0, 1);
    ch.lfo.pitch = num(src.lfo.pitch, ch.lfo.pitch, 0, 48);
  }
  ch.volume = num(src.volume, ch.volume, 0, 1);
  ch.pan = num(src.pan, ch.pan, -1, 1);
  ch.mute = src.mute === true;
  ch.cutoff = num(src.cutoff, ch.cutoff, 20, 20000);
  if (version >= 7) {
    ch.fx1 = src.fx1 === true;
  } else {
    // FX 1 became the drum bus (transparent until used): drum tracks join it.
    ch.fx1 = ch.instrument === 'kick' || ch.instrument === 'snare' || ch.instrument === 'hat';
  }
  if (typeof src.fxSend === 'number') {
    const send = Math.round(num(src.fxSend, 0, 0, NUM_SENDS));
    // Before v7 the sends were 1 dub delay, 2 reverb, 3 dirt; now FX 2 = dub delay, FX 3 = reverb.
    ch.fxSend = version >= 7 ? (send >= 2 ? send : 0) : send === 1 ? 2 : send === 2 ? 3 : 0;
    ch.sendLevel = num(src.sendLevel, ch.sendLevel, 0, 1);
  } else if (Array.isArray(src.sends)) {
    // Older format: one level per effect. Route to the send holding the strongest one:
    // delay -> FX 2 (dub delay), anything else -> FX 3 (reverb).
    const levels = src.sends.map((x) => num(x, 0, 0, 1));
    const max = Math.max(0, ...levels);
    if (max > 0) {
      const k = levels.indexOf(max);
      ch.fxSend = k === 0 ? 2 : 3;
      ch.sendLevel = max;
    } else {
      ch.fxSend = 0;
    }
  }
  ch.activePattern = Math.round(num(src.activePattern, 0, 0, NUM_PATTERNS - 1));

  if (!Array.isArray(src.patterns)) return;
  for (let p = 0; p < NUM_PATTERNS; p++) {
    const sp = src.patterns[p];
    if (!isObj(sp)) continue;
    const pat = ch.patterns[p];
    pat.length = Math.round(num(sp.len ?? sp.length, pat.length, 1, MAX_STEPS));
    for (const s of readSteps(sp)) {
      const step = pat.steps[s.i];
      if (s.rest) {
        step.rest = true;
        continue;
      }
      step.active = true;
      if (s.ring) step.ring = true;
      step.slide = s.slide;
      if (s.roll > 1) step.roll = s.roll;
      step.note = s.note;
      step.velocity = s.vel;
      step.gate = s.gate;
      step.accent = s.accent;
      if (s.locks) step.locks = s.locks;
    }
  }
}

/**
 * Read a stored project (any version, compact or full). Returns null only when the data
 * has no channels at all.
 */
export function fromStored(data: unknown): Project | null {
  if (!isObj(data) || !Array.isArray(data.channels) || data.channels.length === 0) return null;
  const p = createDefaultProject();
  // Start from empty patterns: only stored notes should appear.
  p.bpm = num(data.bpm, p.bpm, BPM_MIN, BPM_MAX);
  p.swing = num(data.swing, p.swing, 50, 75);
  p.master = num(data.master, p.master, 0, 1);
  p.lofi = num(data.lofi, p.lofi, 0, 1);
  const version = num(data.version, 0);
  // v5 had one AMOUNT per effect: it becomes WET, with INTENSITY at the default.
  // Before v7 rows 0-1 (dub delay, reverb) are today's FX 2 and FX 3; the dirt send is gone.
  const readGrid = (grid: unknown, into: number[][]) => {
    if (!Array.isArray(grid)) return;
    for (let k = 1; k < NUM_SENDS; k++) {
      const row = grid[version >= 7 ? k : k - 1];
      if (Array.isArray(row)) for (let e = 0; e < EFFECTS.length; e++) into[k][e] = num(row[e], into[k][e], 0, 1);
    }
  };
  if (isObj(data.fx1)) {
    for (const spec of DRUM_BUS_PARAMS) p.fx1[spec.id] = num(data.fx1[spec.id], p.fx1[spec.id], spec.min, spec.max);
  }
  readGrid(data.sendWet ?? data.sendFx, p.sendWet);
  readGrid(data.sendInt, p.sendInt);
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const src = data.channels[i];
    if (isObj(src)) readChannel(src, p.channels[i], version);
  }
  return p;
}
