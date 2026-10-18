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
  MAX_ROLL, MAX_STEPS, NUM_CHANNELS, NUM_PATTERNS, NUM_SENDS, PROJECT_VERSION, SONG_MAX_BARS, SONG_MAX_ROWS,
  type ChannelState, type Project, type SoundKind,
} from './project';
import { applyPreset, liveDefaults, createDefaultProject } from './defaultProject';
import { INSTRUMENTS, LIVE_MACROS, SOUND_KINDS, SYNTH_TRIM, mirrorOsc2, pageParams, presetSound } from '../instruments/registry';
import { deriveTrims, hiddenSound, pruneTrims } from '../instruments/trims';
import { remapTimbreV18 } from '../instruments/macros';
import { COMP_PARAMS, DRUM_BUS_PARAMS, EFFECTS } from '../fx';
import { CHORD_NAMES, CHORD_NAMES_V5, MAX_CHORD_NOTES } from './chords';
import { BPM_MAX, BPM_MIN } from './mixParams';
import { DJ_DEAD } from './params';
import type { InstrumentKind } from './project';
import { LFO_RATES, LFO_RATES_V17, LFO_RATES_V24, LFO_RETRIG, LFO_SHAPES, type LfoState } from './lfo';

export const FILE_FORMAT = 'groovebox-project';

/** Track order change in v10: old track index -> new (PERC moved from 7 to 4). */
const V9_TO_V10 = [0, 1, 2, 4, 5, 6, 3, 7];

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
  trims?: Record<string, Record<string, number>>;
  live: string[];
  liveFunc?: string[];
  liveOffset?: Record<string, number>;
  chord: number;
  notes?: number;
  volume: number;
  pan: number;
  fx1: boolean;
  fxSend: number;
  sendLevel: number;
  dynamics?: number;
  lfoOn: boolean;
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
  lfo: LfoState;
  song: { rows: { b: number; p: number[] }[] };
  sendWet: number[][];
  sendInt: number[][];
  sendComp?: Record<string, number>[];
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
    lfo: { ...p.lfo },
    song: { rows: p.song.rows.map((r) => ({ b: r.bars, p: [...r.patterns] })) },
    sendWet: p.sendWet.map((row) => [...row]),
    sendInt: p.sendInt.map((row) => [...row]),
    sendComp: p.sendComp.map((row) => ({ ...row })),
    lofi: p.lofi,
    channels: p.channels.map((c) => ({
      instrument: c.instrument,
      sounds: JSON.parse(JSON.stringify(c.sounds)) as Record<string, Record<string, number>>,
      presets: { ...c.presets } as Record<string, number>,
      trims: JSON.parse(JSON.stringify(c.trims)) as Record<string, Record<string, number>>,
      live: [...c.live],
      liveFunc: [...c.liveFunc],
      liveOffset: { ...c.liveOffset },
      chord: c.chord,
      notes: c.notes,
      volume: c.volume,
      pan: c.pan,
      fx1: c.fx1,
      fxSend: c.fxSend,
      sendLevel: c.sendLevel,
      dynamics: c.dynamics,
      lfoOn: c.lfoOn,
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

/** A live knob id this type can use (mixer / track ids, its macros, its parameters). */
function liveIdValid(kind: InstrumentKind, id: string): boolean {
  if (kind === 'none') return true;
  if (id.startsWith('macro:')) return LIVE_MACROS[kind].some((m) => m.id === id);
  if (id.includes(':')) return true;
  return INSTRUMENTS[kind].params.some((p) => p.id === id);
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
      // Before v13 GLIDE also glided every mono note and slides took at least 60 ms; now
      // it is SLIDE (slides only) and left is instant, so keep old slides sounding the same.
      if (version < 13 && values.glide !== undefined) values.glide = Math.max(values.glide, 0.06);
      // Before v14 the synths' OSC 2 shared OSC 1's SUSTAIN / RELEASE.
      mirrorOsc2(values);
      // v19: a fifth TIMBRE sound per type; older positions move so each sound stays itself.
      if (version < 19 && values.timbre !== undefined) values.timbre = remapTimbreV18(k, values.timbre);
      // v23: PERC's metal is tuned as an interval above the tone instead of in Hz.
      if (k === 'perc' && values.m_interval === undefined && values.m_pitch > 0 && values.t_pitch > 0) {
        values.m_interval = Math.max(-12, Math.min(36, Math.round(12 * Math.log2(values.m_pitch / values.t_pitch))));
      }
      const kept = Object.fromEntries(Object.entries(values).filter(([id]) => known.has(id)));
      if (Object.keys(kept).length) ch.sounds[k] = { ...(ch.sounds[k] ?? presetSound(k, 0)), ...kept };
    }
  }
  // Parameters a sound did not have when it was saved (an engine gained them, e.g. the PAD's
  // carrier ratios): take what TIMBRE / INTENSITY give them at the saved position.
  if (isObj(src.sounds)) {
    for (const k of SOUND_KINDS) {
      const sound = ch.sounds[k];
      const saved = isObj(src.sounds[k]) ? (src.sounds[k] as Obj) : null;
      if (!sound || !saved) continue;
      const hidden = hiddenSound(k, sound, INSTRUMENTS[k].params);
      for (const id in hidden) if (typeof saved[id] !== 'number') sound[id] = hidden[id];
    }
  }
  // SOUND page trims on top of TIMBRE / INTENSITY (v17). Older saves (and before v19 - v23,
  // when the TIMBRE sounds, the FLT DEC curve, PERC's tuning and its INTENSITY top
  // changed): derived from the values, so every sound plays exactly as before.
  for (const k of SOUND_KINDS) {
    const sound = ch.sounds[k];
    if (!sound) continue;
    const stored = version >= 23 && isObj(src.trims) ? src.trims[k] : undefined;
    ch.trims[k] = isObj(stored) ? numbers(stored) : deriveTrims(k, sound, INSTRUMENTS[k].params);
    // Knobs that left the page (v24 review, or any later change): back to TIMBRE / INT.
    pruneTrims(sound, ch.trims[k]!, hiddenSound(k, sound, INSTRUMENTS[k].params), pageParams(k));
  }
  // v23: PERC's tone pitch has no knob (the step's note plays it): back on the shared octave.
  const perc = ch.sounds.perc;
  if (version < 23 && perc && ch.trims.perc?.t_pitch !== undefined) {
    delete ch.trims.perc.t_pitch;
    perc.t_pitch = hiddenSound('perc', perc, INSTRUMENTS.perc.params).t_pitch ?? perc.t_pitch;
  }
  if (isObj(src.presets)) {
    for (const k of SOUND_KINDS) {
      if (typeof src.presets[k] !== 'number') continue;
      const index = src.presets[k] as number;
      // v19: one more factory preset per type, so user patch numbers move up one.
      ch.presets[k] = version < 19 && index >= 4 ? index + 1 : index;
    }
  }
  // Before v5 the live knobs followed the preset; from v5 they default to VOLUME/CUTOFF
  // and only a choice made since is kept.
  if (version >= 5 && Array.isArray(src.live) && src.live.length === 2 && src.live.every((x) => typeof x === 'string')) {
    ch.live = [src.live[0] as string, src.live[1] as string];
  }
  if (Array.isArray(src.liveFunc) && src.liveFunc.length === 2 && src.liveFunc.every((x) => typeof x === 'string')) {
    ch.liveFunc = [src.liveFunc[0] as string, src.liveFunc[1] as string];
  }
  if (isObj(src.liveOffset)) {
    const offsets = numbers(src.liveOffset);
    for (const id in offsets) if (offsets[id] !== 0) ch.liveOffset[id] = Math.max(-1, Math.min(1, offsets[id]));
  }
  // Live knobs on parameters the type no longer has (v23: the drums' filter, RING LEN,
  // PERC TUNE): back to the type's defaults.
  if (![...ch.live, ...ch.liveFunc].every((id) => liveIdValid(ch.instrument, id))) liveDefaults(ch);
  // Chords are stored by index; before v6 the list had no MAJOR/MINOR, so map by name.
  const chord = Math.round(num(src.chord, ch.chord, 0, 64));
  ch.notes = Math.round(num(src.notes, MAX_CHORD_NOTES, 1, MAX_CHORD_NOTES));
  ch.chord = version < 6 ? Math.max(0, CHORD_NAMES.indexOf(CHORD_NAMES_V5[chord] ?? 'OFF')) : Math.min(chord, CHORD_NAMES.length - 1);
  ch.lfoOn = src.lfoOn === true;
  ch.volume = num(src.volume, ch.volume, 0, 1);
  // v20: CHORD / LEAD / PLUCK got a -14 dB output trim; scale the volume up to match.
  const trim = ch.instrument === 'none' || INSTRUMENTS[ch.instrument].gain === undefined ? 1 : SYNTH_TRIM;
  if (version < 20 && trim < 1) ch.volume = Math.min(1, ch.volume / trim);
  ch.pan = num(src.pan, ch.pan, -1, 1);
  ch.dynamics = num(src.dynamics, 100, 0, 200);
  ch.mute = src.mute === true;
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
  // Before v12 SLIDE was marked on the note slid into; now on the note that slides.
  if (version < 12) {
    for (const pat of ch.patterns) {
      const targets = pat.steps.map((st, k) => (st.active && st.slide ? k : -1)).filter((k) => k >= 0);
      for (const k of targets) pat.steps[k].slide = false;
      for (const k of targets) {
        for (let b = 1; b < pat.length; b++) {
          const from = pat.steps[(k - b + pat.length) % pat.length];
          if (from.active) { from.slide = true; break; }
        }
      }
    }
  }
}

function readLfo(src: unknown, lfo: LfoState, version: number): void {
  if (!isObj(src)) return;
  const rate = Math.round(num(src.rate, lfo.rate, 0, 63));
  // Before v18 the rate list had no odd / dotted rates: map the old index by name.
  // Rates are stored by index: older lists are mapped by name (v18 and v25 added rates).
  const byName = (name: string | undefined) => Math.max(0, LFO_RATES.findIndex((r) => r.name === (name ?? '1/4')));
  lfo.rate = version < 18 ? byName(LFO_RATES_V17[rate])
    : version < 25 ? byName(LFO_RATES_V24[rate])
    : Math.min(rate, LFO_RATES.length - 1);
  lfo.morph = num(src.morph, lfo.morph, 0, 1);
  lfo.fm = num(src.fm, lfo.fm, 0, 1);
  lfo.shape = Math.round(num(src.shape, lfo.shape, 0, LFO_SHAPES.length - 1));
  lfo.vol = num(src.vol, lfo.vol, 0, 1);
  lfo.pitch = num(src.pitch, lfo.pitch, 0, 48);
  lfo.filter = num(src.filter, lfo.filter, 0, 8);
  lfo.pan = num(src.pan, lfo.pan, 0, 1);
  lfo.phase = num(src.phase, lfo.phase, 0, 1);
  lfo.smooth = num(src.smooth, lfo.smooth, 0, 1);
  lfo.fade = num(src.fade, lfo.fade, 0, 4);
  lfo.retrig = Math.round(num(src.retrig, lfo.retrig, 0, LFO_RETRIG.length - 1));
  lfo.send = num(src.send, lfo.send, 0, 1);
  lfo.spread = num(src.spread, lfo.spread, 0, 1);
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
    // v23: the LOW-PASS cutoff became the one-knob FILTER (left half = the same low-pass).
    const lp = data.fx1.lp_cutoff;
    if (typeof lp === 'number' && typeof data.fx1.flt !== 'number' && lp < 19990) {
      const half = 0.5 - DJ_DEAD;
      p.fx1.flt = Math.max(0, half - half * Math.log(Math.max(30, lp) / 20000) / Math.log(30 / 20000));
    }
  }
  readGrid(data.sendWet ?? data.sendFx, p.sendWet);
  readGrid(data.sendInt, p.sendInt);
  if (Array.isArray(data.sendComp)) {
    data.sendComp.forEach((row, k) => {
      if (k >= p.sendComp.length || !isObj(row)) return;
      for (const spec of COMP_PARAMS) p.sendComp[k][spec.id] = num(row[spec.id], p.sendComp[k][spec.id], spec.min, spec.max);
    });
  }
  readLfo(data.lfo, p.lfo, version);
  // Before v10 the tracks were KICK SNARE HAT BASS PAD LEAD PERC LEAD; PERC is now track 4,
  // so stored track i goes to slot(i) (patterns, sounds and song cells move with it).
  const slot = (i: number) => (version < 10 ? (V9_TO_V10[i] ?? i) : i);
  if (isObj(data.song) && Array.isArray(data.song.rows)) {
    for (const r of data.song.rows.slice(0, SONG_MAX_ROWS)) {
      if (!isObj(r)) continue;
      const pats = Array.isArray(r.p) ? r.p : [];
      const patterns = new Array<number>(NUM_CHANNELS).fill(-1);
      for (let i = 0; i < NUM_CHANNELS; i++) patterns[slot(i)] = Math.round(num(pats[i], -1, -1, NUM_PATTERNS - 1));
      p.song.rows.push({ bars: Math.round(num(r.b, 4, 1, SONG_MAX_BARS)), patterns });
    }
  }
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const src = data.channels[i];
    if (isObj(src)) readChannel(src, p.channels[slot(i)], version);
  }
  // v11: track 8 (a second LEAD until then) became the PLUCK, keeping its patterns.
  if (version < 11) {
    const t8 = p.channels[7];
    if (t8 && t8.instrument === 'lead') {
      applyPreset(t8, 'pluck', 0);
    }
  }
  // v15: the mixer CUTOFF went (the sound's filter is CUTOFF) and each type got its own
  // live knobs (two sound controls; VOLUME with FUNC); v16: they became relative, with
  // macros. Every track takes its type's.
  // v24 (the per-track knob review): every track takes its type's new live knobs.
  if (version < 24) for (const c of p.channels) liveDefaults(c);
  // Before v8 every track had its own LFO: tracks that used theirs join the shared one,
  // which takes the first such track's settings.
  if (version < 8) {
    let first = true;
    data.channels.forEach((src, i) => {
      if (i >= NUM_CHANNELS || !isObj(src) || !isObj(src.lfo)) return;
      if (num(src.lfo.vol, 0) <= 0 && num(src.lfo.pitch, 0) <= 0) return;
      p.channels[slot(i)].lfoOn = true;
      if (first) readLfo(src.lfo, p.lfo, version);
      first = false;
    });
  }
  return p;
}
