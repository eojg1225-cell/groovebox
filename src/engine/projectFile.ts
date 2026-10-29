/**
 * Stored project format, used for every save (slots, working copies, cloud).
 *
 * Compact: only steps with a note are written. The reader is forgiving: anything missing
 * or out of range falls back to the default, unknown parameters are dropped, and notes
 * are never lost. It reads formats from OLDEST_EXACT on exactly; an older save (the load
 * migrations for v1 - v39 were retired, see docs/HISTORY.md) still loads its notes, mix
 * and FX, but its sounds are taken as stored and may differ (isOldFormat).
 */
import { ARP_MODES, ARP_RATES, defaultArp } from './arp';
import {
  MAX_STEPS, NUM_CHANNELS, NUM_PATTERNS, NUM_SENDS, PROJECT_VERSION, SETTING_KEYS, SONG_MAX_BARS, SONG_MAX_ROWS, STEP_NOTES,
  emptyPattern, initPatterns, patchOf,
  type ChannelState, type Patch, type Pattern, type Project, type SoundKind, type Step,
} from './project';
import { applyPreset, liveDefaults, createDefaultProject } from './defaultProject';
import { parseAutoKey } from './automation';
import { macroIds } from '../instruments/macros';
import { DEFAULT_ROLL_RATE } from '../instruments/Drum';
import { INSTRUMENTS, LIVE_MACROS, SOUND_KINDS, linkedParams, pageParams, presetSound } from '../instruments/registry';
import { applyTrim, deriveTrims, hiddenSound, pruneTrims, trimFor } from '../instruments/trims';
import { BUS_PARAMS, FX_LIVE, NUM_BUSES } from '../fx/buses';
import { CHORD_NAMES, MAX_CHORD_NOTES } from './chords';
import { BPM_MAX, BPM_MIN, GATE_MAX, GATE_MIN, RING_MAX, RING_MIN } from './mixParams';
import { METERS, type InstrumentKind, type PatternSpeed } from './project';
import { LFO_RATES, LFO_RETRIG, LFO_SHAPES, type LfoState } from './lfo';

const FILE_FORMAT = 'groovebox-project';

/**
 * The oldest format read exactly. Raise it when a format change needs a load migration
 * no longer worth keeping (and say so in docs/HISTORY.md).
 */
const OLDEST_EXACT = 40;

/**
 * One step with a note: index, note, velocity; gate/accent/ring/slide/locks/chord only when set.
 * A rest marker is stored as { i, x: 1 } (no note). (`k`, a per-step roll count, is no longer written.)
 */
interface StoredStep {
  i: number;
  n?: number;
  v?: number;
  g?: number;
  a?: 1;
  r?: 1;
  s?: 1;
  k?: number;
  x?: 1;
  /** v55: no note, only locks. */
  o?: 1;
  l?: Record<string, number>;
  /** v34: PAD chord, the step's further notes. */
  c?: number[];
  /** v42: their own lengths (absent = the step's gate). */
  cg?: number[];
}

/** A patch: s = sound values, t = SOUND page trims, p = preset index. */
interface StoredPatch {
  s: Record<string, number>;
  t: Record<string, number>;
  p?: number;
}

interface StoredPattern {
  len: number;
  /** v34: half / double time, v36 triplet (absent = normal). */
  sp?: StoredSpeed;
  steps: StoredStep[];
  /** v36: STEPS, the steps switched the other way from the time signature. */
  f?: number[];
  /** v31: the pattern's own patch (not written for the active pattern: that is `sounds`). */
  patch?: StoredPatch;
  /** v31: the last SAVEd notes / patch, only while they differ (edited since). */
  saved?: { len: number; sp?: StoredSpeed; steps: StoredStep[]; f?: number[] };
  savedPatch?: StoredPatch;
}

type StoredSpeed = Exclude<PatternSpeed, 'normal'>;
const STORED_SPEEDS: readonly unknown[] = ['half', 'double', 'triplet'];

/** The flipped steps' indices (STEPS), or undefined when none. */
function storeFlips(steps: Step[]): number[] | undefined {
  const f = steps.flatMap((s, i) => (s.flip ? [i] : []));
  return f.length ? f : undefined;
}

function storeSteps(steps: Step[]): StoredStep[] {
  return steps.flatMap((s, i): StoredStep[] => {
    if (!s.active) {
      // A step with no note: a REST marker and / or (v55) locks (STEP EDIT can lock any step).
      const locks = s.locks && Object.keys(s.locks).length ? { l: { ...s.locks } } : null;
      if (!s.rest && !locks) return [];
      return [{ i, ...(s.rest ? { x: 1 as const } : { o: 1 as const }), ...locks }];
    }
    const out: StoredStep = { i, n: s.note, v: s.velocity };
    if (s.gate > 1) out.g = s.gate;
    if (s.accent) out.a = 1;
    if (s.ring) out.r = 1;
    if (s.slide) out.s = 1;
    if (s.locks && Object.keys(s.locks).length) out.l = { ...s.locks };
    if (s.extra?.length) out.c = [...s.extra];
    if (s.extra?.length && s.extraGate?.length) out.cg = s.extraGate.slice(0, s.extra.length);
    return [out];
  });
}

function storePatch(p: Patch): StoredPatch {
  const out: StoredPatch = { s: { ...p.sound }, t: { ...p.trims } };
  if (p.preset !== undefined) out.p = p.preset;
  return out;
}

function storePattern(c: ChannelState, pat: Pattern, p: number): StoredPattern {
  const out: StoredPattern = { len: pat.length, steps: storeSteps(pat.steps) };
  if (pat.speed && pat.speed !== 'normal') out.sp = pat.speed;
  const f = storeFlips(pat.steps);
  if (f) out.f = f;
  if (c.instrument !== 'none' && p !== c.activePattern) out.patch = storePatch(patchOf(c, p));
  if (pat.notesDirty && pat.savedNotes) {
    out.saved = { len: pat.savedNotes.length, steps: storeSteps(pat.savedNotes.steps) };
    if (pat.savedNotes.speed && pat.savedNotes.speed !== 'normal') out.saved.sp = pat.savedNotes.speed;
    const sf = storeFlips(pat.savedNotes.steps);
    if (sf) out.saved.f = sf;
  }
  if (pat.patchDirty && pat.savedPatch) out.savedPatch = storePatch(pat.savedPatch);
  return out;
}

interface StoredChannel {
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
  gateLength?: number;
  /** v50 on (older: 1 = as designed). */
  ringLength?: number;
  midCut?: number;
  lfoOn: boolean;
  /** v55: ARP (on, mode, rate, oct); absent = off. */
  arp?: { on: boolean; mode: number; rate: number; oct: number };
  mute: boolean;
  activePattern: number;
  patterns: StoredPattern[];
}

interface StoredProject {
  format: typeof FILE_FORMAT;
  version: number;
  bpm: number;
  swing: number;
  master: number;
  lfo: LfoState;
  /** v53: `a` = the song's automation (key -> [position, value] pairs). */
  song: { rows: { b: number; p: number[] }[]; a?: Record<string, [number, number][]> };
  /** v41: FX 1-3 settings (BUS_PARAMS ids). */
  buses: Record<string, number>[];
  /** v36: time signature (index into METERS; absent = 4/4). */
  meter?: number;
  /** v52: the project's own GLOBAL settings (option indices; absent = DEFAULT). */
  settings?: Record<string, number>;
  channels: StoredChannel[];
}

export function toStored(p: Project): StoredProject {
  return {
    format: FILE_FORMAT,
    version: PROJECT_VERSION,
    bpm: p.bpm,
    swing: p.swing,
    master: p.master,
    meter: p.meter,
    settings: { ...p.settings },
    lfo: { ...p.lfo },
    song: { rows: p.song.rows.map((r) => ({ b: r.bars, p: [...r.patterns] })), ...(p.song.auto ? { a: JSON.parse(JSON.stringify(p.song.auto)) as Record<string, [number, number][]> } : {}) },
    buses: p.buses.map((b) => ({ ...b })),
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
      gateLength: c.gateLength,
      ringLength: c.ringLength,
      midCut: c.midCut,
      lfoOn: c.lfoOn,
      ...(c.arp && (c.arp.on || c.arp.mode || c.arp.rate !== defaultArp().rate || c.arp.oct) ? { arp: { ...c.arp } } : {}),
      mute: c.mute,
      activePattern: c.activePattern,
      patterns: c.patterns.map((pat, p) => storePattern(c, pat, p)),
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

/**
 * v41: FM ATK / FM DEC (the FM's own envelope) start where FLT ATK / FLT DEC are: before,
 * the FM followed the filter envelope. On values, trims or locks, in place.
 */
function fmEnvV41(values: Record<string, number>): void {
  if (values.fattack !== undefined && values.fmattack === undefined) values.fmattack = values.fattack;
  if (values.fdecay !== undefined && values.fmdecay === undefined) values.fmdecay = values.fdecay;
}

/**
 * v43: the KICK's TIMBRE sounds have their own INT 0 / 1 ends and TIMBRE sets BD DEC (0.5 s
 * on every sound), so a stored BD DEC becomes a trim (the decay stays as it was) and the
 * other TIMBRE / INT values are rebuilt under the stored trims; SWEEP's range grew from
 * 0-96 to 0-120 semitones (stored SWEEP trims rescaled to keep their size). On a sound and
 * its stored trims, in place.
 */
export function drumsV43(kind: SoundKind, sound: Record<string, number>, trims: Record<string, number>): void {
  if (trims.t_sweep !== undefined) trims.t_sweep *= 96 / 120;
  if (kind !== 'kick') return;
  const specs = INSTRUMENTS.kick.params;
  const hidden = hiddenSound(kind, sound, specs);
  const decay = specs.find((p) => p.id === 't_decay')!;
  if (trims.t_decay === undefined && sound.t_decay !== undefined) {
    const t = trimFor(decay, sound.t_decay, hidden.t_decay);
    if (t !== 0) trims.t_decay = t;
  }
  for (const spec of specs) if (hidden[spec.id] !== undefined) sound[spec.id] = applyTrim(spec, hidden[spec.id], trims[spec.id]);
}

/** A sound's TIMBRE / INT values rebuilt from today's sounds under its trims, in place. */
function rebuildMacros(kind: SoundKind, sound: Record<string, number>, trims: Record<string, number>): void {
  const specs = INSTRUMENTS[kind].params;
  const hidden = hiddenSound(kind, sound, specs);
  for (const spec of specs) if (hidden[spec.id] !== undefined) sound[spec.id] = applyTrim(spec, hidden[spec.id], trims[spec.id]);
}

/**
 * v44: the HAT's RIDE was redone (BELL, RATTLE), so a saved HAT's TIMBRE / INT values are
 * rebuilt from the new sounds under its stored trims (none stored: none kept, so the old
 * ride's values don't come back as trims). On a sound and its trims, in place.
 */
export function hatV44(kind: SoundKind, sound: Record<string, number>, trims: Record<string, number>): void {
  if (kind === 'hat') rebuildMacros(kind, sound, trims);
}

/**
 * v58: LEAD moved from the 3 CARRIER engine onto the BASS / PLUCK one (WHISTLE, SQUARE,
 * SUPERSAW, HOOVER, FM BITE), so a saved LEAD's TIMBRE / INT values are rebuilt from the new
 * sounds at its TIMBRE / INT under its stored trims (none stored: none kept). Its notes, mix,
 * envelope ATTACK / RELEASE and other edits stay.
 */
export function leadV58(kind: SoundKind, sound: Record<string, number>, trims: Record<string, number>): void {
  if (kind === 'lead') rebuildMacros(kind, sound, trims);
}

/**
 * v46: PERC's order before v46 (v45: SYN DRUM became TIMBALE in place) -> now, by sound:
 * LOW TOM, TIMBALE, CONGA, COWBELL, CLAVE -> LOW TOM, CONGA, COWBELL, TIMBALE, CLAVE.
 */
const PERC_ORDER_V46 = [0, 3, 1, 2, 4];

/**
 * A PERC TIMBRE position from before v46, by sound: on (or between two sounds still next to
 * each other) it moves with them; between sounds now apart it takes the nearer one's place.
 */
function percTimbreV46(t: number): number {
  const n = PERC_ORDER_V46.length - 1;
  const u = Math.min(1, Math.max(0, t)) * n;
  const i = Math.min(n - 1, Math.floor(u));
  const f = u - i;
  const a = PERC_ORDER_V46[i], b = PERC_ORDER_V46[i + 1];
  return (Math.abs(a - b) === 1 ? a + (b - a) * f : f < 0.5 ? a : b) / n;
}

/** A PERC preset number (= its TIMBRE sound) from before v46. */
function percPresetV46(p: number): number {
  return PERC_ORDER_V46[p] ?? p;
}

/**
 * v46 (and v45: SYN DRUM became TIMBALE): a saved PERC's TIMBRE moves to its sound's new place
 * and its TIMBRE / INT values are rebuilt under its stored trims (as hatV44). In place.
 */
export function percV46(kind: SoundKind, sound: Record<string, number>, trims: Record<string, number>): void {
  if (kind !== 'perc') return;
  if (sound.timbre !== undefined) sound.timbre = percTimbreV46(sound.timbre);
  rebuildMacros(kind, sound, trims);
}

/**
 * v47: the KICK's VINTAGE, TECHNO (INT 100) and PSY DOOF were redone, so a saved KICK's trims
 * are taken again from its stored values over the new sounds: it plays as it was saved (the
 * project that VINTAGE was built from ends up with almost no trims). In place.
 */
export function kickV47(kind: SoundKind, sound: Record<string, number>, trims: Record<string, number>): void {
  if (kind !== 'kick') return;
  const specs = INSTRUMENTS.kick.params;
  for (const id of macroIds(kind, specs)) delete trims[id];
  Object.assign(trims, deriveTrims(kind, sound, specs));
}

/** Stored data in a format older than the reader reads exactly: its sounds may differ. */
export function isOldFormat(data: unknown): boolean {
  return isObj(data) && num(data.version, 0) < OLDEST_EXACT;
}

/** A step's further notes (PAD chords): valid notes, at most STEP_NOTES - 1. */
function readExtra(x: unknown): number[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const notes = x.filter((n): n is number => typeof n === 'number' && n >= 0 && n <= 127).map(Math.round).slice(0, STEP_NOTES - 1);
  return notes.length ? notes : undefined;
}

/** A live knob id this type can use (mixer / track / FX ids, its macros, its parameters). */
function liveIdValid(kind: InstrumentKind, id: string): boolean {
  if (/^fx\d:/.test(id)) return FX_LIVE.some((f) => f.id === id);
  if (kind === 'none') return true;
  if (id.startsWith('macro:')) return LIVE_MACROS[kind].some((m) => m.id === id);
  if (id.includes(':')) return true;
  return INSTRUMENTS[kind].params.some((p) => p.id === id);
}

/** A stored pattern's length, speed, flips and notes into `pat` (its steps start empty). */
function readNotes(sp: Obj, pat: { length: number; steps: Step[]; speed?: PatternSpeed }, version: number, kind: InstrumentKind): void {
  pat.length = Math.round(num(sp.len, pat.length, 1, MAX_STEPS));
  if (STORED_SPEEDS.includes(sp.sp)) pat.speed = sp.sp as StoredSpeed;
  if (Array.isArray(sp.f)) {
    for (const i of sp.f) if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < MAX_STEPS) pat.steps[i].flip = true;
  }
  if (!Array.isArray(sp.steps)) return;
  for (const s of sp.steps) {
    if (!isObj(s) || typeof s.i !== 'number' || !Number.isInteger(s.i) || s.i < 0 || s.i >= MAX_STEPS) continue;
    const step = pat.steps[s.i];
    if (s.x === 1 || s.o === 1) {
      if (s.x === 1) step.rest = true;
      const locks = numbers(s.l);
      if (Object.keys(locks).length) step.locks = locks;
      continue;
    }
    step.active = true;
    step.note = num(s.n, 36, 0, 127);
    step.velocity = num(s.v, 0.8, 0, 1);
    step.gate = Math.round(num(s.g, 1, 1, MAX_STEPS));
    step.accent = s.a === 1;
    step.slide = s.s === 1;
    if (s.r === 1) step.ring = true;
    const locks = numbers(s.l);
    if (version < 41) fmEnvV41(locks);
    if (version < 46 && kind === 'perc' && locks.timbre !== undefined) locks.timbre = percTimbreV46(locks.timbre);
    if (Object.keys(locks).length) step.locks = locks;
    const extra = readExtra(s.c);
    if (extra) {
      step.extra = extra;
      const gates = Array.isArray(s.cg) ? s.cg : null;
      if (gates) step.extraGate = extra.map((_, k) => Math.round(num(gates[k], step.gate, 1, MAX_STEPS)));
    }
  }
}

/**
 * A sound's stored values for a type: known parameters kept, the rest from the first
 * preset, and parameters the save did not have from TIMBRE / INTENSITY at its position.
 */
function readSound(kind: SoundKind, x: unknown, version: number, base: Record<string, number> = presetSound(kind, 0)): Record<string, number> {
  const specs = INSTRUMENTS[kind].params;
  const values = numbers(x);
  if (version < 41) fmEnvV41(values);
  const sound = { ...base };
  for (const spec of specs) if (typeof values[spec.id] === 'number') sound[spec.id] = values[spec.id];
  if (version < 57) rollRateV57(sound);
  const hidden = hiddenSound(kind, sound, specs);
  for (const id in hidden) if (typeof values[id] !== 'number') sound[id] = hidden[id];
  // A parameter stored without one its knob sets along with it (FM LVL2, added later) takes
  // the knob's value, as the knob would have set it.
  for (const spec of specs) {
    for (const id of linkedParams(kind, spec.id)) if (typeof values[id] !== 'number' && typeof values[spec.id] === 'number') sound[id] = sound[spec.id];
  }
  return sound;
}

/** v57: ROLL RATE became a note value (1/4 ... 1/64); every older save's drums roll at 1/16. */
export function rollRateV57(sound: Record<string, number>): void {
  if (sound.rolldiv !== undefined) sound.rolldiv = DEFAULT_ROLL_RATE;
}

/** SOUND page trims as stored (derived from the values when absent), pruned to the page. */
function readTrims(kind: SoundKind, sound: Record<string, number>, x: unknown, version: number): Record<string, number> {
  const specs = INSTRUMENTS[kind].params;
  // A rebuilt type (v44 HAT, v45 PERC, v58 LEAD) without stored trims keeps none.
  const rebuilt = (version < 44 && kind === 'hat') || (version < 46 && kind === 'perc') || (version < 58 && kind === 'lead');
  const trims = isObj(x) ? numbers(x) : rebuilt ? {} : deriveTrims(kind, sound, specs);
  if (version < 41 && isObj(x)) fmEnvV41(trims);
  // Trims stored without a linked parameter's (FM LVL2, added later): the knob's own.
  for (const id of Object.keys(trims)) for (const t of linkedParams(kind, id)) if (isObj(x) && typeof x[t] !== 'number') trims[t] = trims[id];
  if (version < 43 && isObj(x)) drumsV43(kind, sound, trims);
  if (version < 44) hatV44(kind, sound, trims);
  if (version < 46) percV46(kind, sound, trims);
  if (version < 47) kickV47(kind, sound, trims);
  if (version < 58) leadV58(kind, sound, trims);
  pruneTrims(sound, trims, hiddenSound(kind, sound, specs), pageParams(kind));
  return trims;
}

/** A stored patch for a type (s = sound, t = trims, p = preset). */
function readPatch(kind: SoundKind, x: unknown, version: number): Patch | undefined {
  if (!isObj(x) || !isObj(x.s)) return undefined;
  const sound = readSound(kind, x.s, version);
  const patch: Patch = { sound, trims: readTrims(kind, sound, x.t, version) };
  if (typeof x.p === 'number') patch.preset = Math.max(0, Math.round(x.p));
  if (version < 46 && kind === 'perc' && patch.preset !== undefined) patch.preset = percPresetV46(patch.preset);
  return patch;
}

function readChannel(src: Obj, ch: ChannelState, version: number): void {
  const kind = src.instrument;
  if (typeof kind === 'string' && (SOUND_KINDS as string[]).includes(kind) && kind !== ch.instrument) {
    applyPreset(ch, kind as SoundKind, 0);
  }
  // Each type's sound (remembered when the track switches type) and its trims.
  for (const k of SOUND_KINDS) {
    const stored = isObj(src.sounds) ? src.sounds[k] : undefined;
    if (isObj(stored)) ch.sounds[k] = readSound(k, stored, version, ch.sounds[k] ?? presetSound(k, 0));
    const sound = ch.sounds[k];
    if (sound) ch.trims[k] = readTrims(k, sound, isObj(src.trims) ? src.trims[k] : undefined, version);
  }
  if (isObj(src.presets)) {
    for (const k of SOUND_KINDS) if (typeof src.presets[k] === 'number') ch.presets[k] = Math.max(0, Math.round(src.presets[k] as number));
    if (version < 46 && ch.presets.perc !== undefined) ch.presets.perc = percPresetV46(ch.presets.perc);
  }
  const pair = (x: unknown): [string, string] | null =>
    Array.isArray(x) && x.length === 2 && x.every((y) => typeof y === 'string') ? [x[0] as string, x[1] as string] : null;
  ch.live = pair(src.live) ?? ch.live;
  ch.liveFunc = pair(src.liveFunc) ?? ch.liveFunc;
  if (isObj(src.liveOffset)) {
    const offsets = numbers(src.liveOffset);
    for (const id in offsets) if (offsets[id] !== 0) ch.liveOffset[id] = Math.max(-1, Math.min(1, offsets[id]));
  }
  // Live knobs on parameters the type does not have: back to the type's defaults.
  if (![...ch.live, ...ch.liveFunc].every((id) => liveIdValid(ch.instrument, id))) liveDefaults(ch);
  if (version < 51) liveV51(ch);
  ch.chord = Math.round(num(src.chord, ch.chord, 0, CHORD_NAMES.length - 1));
  ch.notes = Math.round(num(src.notes, MAX_CHORD_NOTES, 1, MAX_CHORD_NOTES));
  ch.lfoOn = src.lfoOn === true;
  if (isObj(src.arp)) {
    const a = src.arp;
    const d = defaultArp();
    ch.arp = {
      on: a.on === true,
      mode: Math.round(num(a.mode, d.mode, 0, ARP_MODES.length - 1)),
      rate: Math.round(num(a.rate, d.rate, 0, ARP_RATES.length - 1)),
      oct: Math.round(num(a.oct, d.oct, 0, 2)),
    };
  }
  ch.volume = num(src.volume, ch.volume, 0, 1);
  ch.pan = num(src.pan, ch.pan, -1, 1);
  ch.dynamics = num(src.dynamics, 100, 0, 200);
  ch.gateLength = num(src.gateLength, 1, GATE_MIN, GATE_MAX);
  ch.ringLength = num(src.ringLength, 1, RING_MIN, RING_MAX);
  ch.midCut = num(src.midCut, 0, 0, 1);
  ch.mute = src.mute === true;
  ch.fx1 = src.fx1 === true;
  const send = Math.round(num(src.fxSend, 0, 0, NUM_SENDS));
  ch.fxSend = send >= 2 ? send : 0;
  // v41: FX 2 is the PAD's bus and FX 3 the LEAD's (before: FX 2 the dub delay for bass /
  // lead, FX 3 the pad reverb), so older routings swap.
  if (version < 41 && ch.fxSend) ch.fxSend = ch.fxSend === 2 ? 3 : 2;
  ch.sendLevel = num(src.sendLevel, ch.sendLevel, 0, 1);
  ch.activePattern = Math.round(num(src.activePattern, 0, 0, NUM_PATTERNS - 1));

  if (!Array.isArray(src.patterns)) return;
  for (let p = 0; p < NUM_PATTERNS; p++) {
    const sp = src.patterns[p];
    if (!isObj(sp)) continue;
    const pat = ch.patterns[p];
    readNotes(sp, pat, version, ch.instrument);
    if (ch.instrument === 'none') continue;
    // Each pattern's own patch (the active one's is the channel's sounds), and what was last
    // SAVEd while it differs.
    if (p !== ch.activePattern) pat.patch = readPatch(ch.instrument, sp.patch, version);
    if (isObj(sp.saved)) {
      // Empty steps on the note a fresh pattern of this type has (as the working ones).
      const kind = INSTRUMENTS[ch.instrument];
      const saved = emptyPattern(kind.drum ? 36 : kind.baseNote);
      readNotes(sp.saved, saved, version, ch.instrument);
      pat.savedNotes = { length: saved.length, steps: saved.steps };
      if (saved.speed) pat.savedNotes.speed = saved.speed;
      pat.notesDirty = true;
    }
    const savedPatch = readPatch(ch.instrument, sp.savedPatch, version);
    if (savedPatch) {
      pat.savedPatch = savedPatch;
      pat.patchDirty = true;
    }
  }
}

function readLfo(src: unknown, lfo: LfoState): void {
  if (!isObj(src)) return;
  lfo.rate = Math.round(num(src.rate, lfo.rate, 0, LFO_RATES.length - 1));
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

/** The track types' output gains (InstrumentEntry.gain) before and after v49. */
const TYPE_GAIN_V48: Record<SoundKind, number> = { kick: 0.565, snare: 0.797, hat: 4.359, perc: 0.778, bass: 0.383, pad: 0.273, lead: 0.633, pluck: 1.366 };
const TYPE_GAIN_V49: Record<SoundKind, number> = { kick: 0.565, snare: 0.467, hat: 1.783, perc: 0.537, bass: 0.557, pad: 0.413, lead: 0.948, pluck: 1.105 };

/** SONG automation as stored: known keys, finite [position, value] pairs, in position order, one per position. */
function readAuto(x: unknown): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  if (!isObj(x)) return out;
  for (const key in x) {
    const pts = x[key];
    if (!parseAutoKey(key) || !Array.isArray(pts)) continue;
    const ok = pts.filter((q): q is [number, number] => Array.isArray(q) && q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]) && q[0] >= 0);
    ok.sort((a, b) => a[0] - b[0]);
    const lane = ok.filter((q, i) => i === 0 || q[0] !== ok[i - 1][0]).map(([a, b]) => [a, b] as [number, number]);
    if (lane.length > 0) out[key] = lane;
  }
  return out;
}

/**
 * v51: every track's live knobs (LIVE 1-4, centred) back to its type's defaults as they are
 * now (e.g. PLUCK LIVE 2 = SPACE), set by the user's request for every project saved before.
 */
function liveV51(ch: ChannelState): void {
  liveDefaults(ch);
}

/**
 * v49: the track types' output gains were set again with the gated loudness measure (a HAT
 * read 7.8 dB too quiet on the old one), so each saved VOLUME is scaled by old / new gain and
 * the project plays as it was mixed. If a VOLUME would pass 1, every track comes down together
 * and MASTER goes up instead (as far as it goes; past that the whole mix is a little quieter);
 * a track without notes doesn't count, it is just capped at 1.
 */
function typeGainV49(p: Project): void {
  const scaled = p.channels.map((c) => (c.instrument === 'none' ? c.volume : (c.volume * TYPE_GAIN_V48[c.instrument]) / TYPE_GAIN_V49[c.instrument]));
  // Only tracks with notes count (a silent one is just capped at 1).
  const heard = p.channels.map((c) => c.patterns.some((pat) => pat.steps.some((st) => st.active)));
  const over = Math.max(1, ...scaled.filter((_, i) => heard[i]));
  p.channels.forEach((c, i) => { c.volume = Math.min(1, scaled[i] / over); });
  if (over > 1) p.master = Math.min(1, p.master * over);
}

/** Read a stored project. Returns null only when the data has no channels at all. */
export function fromStored(data: unknown): Project | null {
  if (!isObj(data) || !Array.isArray(data.channels) || data.channels.length === 0) return null;
  const p = createDefaultProject();
  p.bpm = Math.round(num(data.bpm, p.bpm, BPM_MIN, BPM_MAX)); // whole BPM only
  p.swing = num(data.swing, p.swing, 50, 75);
  p.master = num(data.master, p.master, 0, 1);
  p.meter = Math.round(num(data.meter, 0, 0, METERS.length - 1));
  p.settings = {};
  if (isObj(data.settings)) {
    for (const k of SETTING_KEYS) {
      const v = data.settings[k];
      // Option indices (the app keeps each within its own list).
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 64) p.settings[k] = v;
    }
  }
  const version = num(data.version, 0);
  // FX 1-3 (v41; older FX settings take the new buses' defaults).
  if (version >= 41 && Array.isArray(data.buses)) {
    for (let k = 0; k < NUM_BUSES; k++) {
      const src = data.buses[k];
      if (!isObj(src)) continue;
      for (const spec of BUS_PARAMS[k]) {
        const v = num(src[spec.id], p.buses[k][spec.id], spec.min, spec.max);
        p.buses[k][spec.id] = spec.options ? Math.round(v) : v;
      }
    }
  }
  readLfo(data.lfo, p.lfo);
  if (isObj(data.song) && Array.isArray(data.song.rows)) {
    for (const r of data.song.rows.slice(0, SONG_MAX_ROWS)) {
      if (!isObj(r)) continue;
      const pats = Array.isArray(r.p) ? r.p : [];
      const patterns = Array.from({ length: NUM_CHANNELS }, (_, i) => Math.round(num(pats[i], -1, -1, NUM_PATTERNS - 1)));
      p.song.rows.push({ bars: Math.round(num(r.b, 4, 1, SONG_MAX_BARS)), patterns });
    }
    const auto = readAuto(data.song.a);
    if (Object.keys(auto).length > 0) p.song.auto = auto;
  }
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const src = data.channels[i];
    if (isObj(src)) readChannel(src, p.channels[i], version);
  }
  if (version < 49) typeGainV49(p);
  // Every pattern gets its patch and saved versions (where the save had none).
  for (const c of p.channels) initPatterns(c);
  return p;
}
