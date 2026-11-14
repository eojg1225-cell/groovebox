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
  CLIP_ENTRY, FILL_STEPS, GLIDE_STEPS, MAX_STEPS, NUM_CHANNELS, NUM_PATTERNS, NUM_SENDS, PROJECT_VERSION, SETTING_KEYS, SONG_MAX_BARS, SONG_MAX_ROWS, STEP_NOTES,
  clonePatch, compactEntry, dropTiedRests, emptyPattern, initPatterns, patchOf,
  type ChannelState, type ClipEntry, type Patch, type Pattern, type Project, type SongRow, type SoundKind, type Step,
} from './project';
import { applyPreset, liveDefaults, createDefaultProject } from './defaultProject';
import { parseAutoKey } from './automation';
import { macroIds, macroSoundOf, type MacroDef } from '../instruments/macros';
import { DEFAULT_ROLL_RATE } from '../instruments/drumSpecs';
import { INSTRUMENTS, LIVE_MACROS, isDrum, SOUND_KINDS, linkedParams, pageParams, presetSound } from '../instruments/registry';
import { applyTrim, deriveTrims, hiddenSound, pruneTrims, trimFor } from '../instruments/trims';
import { BUS_PARAMS, FX_LIVE, NUM_BUSES } from '../fx/buses';
import { CHORD_NAMES, MAX_CHORD_NOTES } from './chords';
import { BPM_MAX, BPM_MIN, GATE_MAX, GATE_MIN, RING_MAX, RING_MIN } from './mixParams';
import { METERS, chainBefore85, chainOrders, type InstrumentKind, type PatternSpeed } from './project';
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
  // A pattern sounding as the edited one leaves its patch out (read back as a copy of it).
  if (c.instrument !== 'none' && p !== c.activePattern) {
    const patch = storePatch(patchOf(c, p));
    if (JSON.stringify(patch) !== JSON.stringify(storePatch(patchOf(c, c.activePattern)))) out.patch = patch;
  }
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
  /** FX 1 SEND, 0-1 (before v86 on / off). */
  fx1: number | boolean;
  fxSend: number;
  sendLevel: number;
  dynamics?: number;
  gateLength?: number;
  /** v50 on (older: 1 = as designed). */
  ringLength?: number;
  /** v80: the track's SCALE root / chromatic keys. */
  root?: number;
  chromatic?: boolean;
  /** v84: the strip keys' start above the root (absent = 0). */
  keyFrom?: number;
  midCut?: number;
  lfoOn: boolean;
  /** v55: ARP (on, mode, rate, oct); absent = off. */
  arp?: { on: boolean; mode: number; rate: number; oct: number };
  mute: boolean;
  activePattern: number;
  patterns: StoredPattern[];
}

interface StoredEntry { gs?: number; ge?: number; f?: number; l?: number }

function storeEntries(entry: SongRow['entry']): { e?: (StoredEntry | 0)[] } {
  const e = (entry ?? []).map((x): StoredEntry | 0 => {
    const c = compactEntry(x);
    if (!c) return 0;
    return { ...(c.glideStart !== undefined ? { gs: c.glideStart } : {}), ...(c.glideEnd !== undefined ? { ge: c.glideEnd } : {}),
      ...(c.fill !== undefined ? { f: c.fill } : {}), ...(c.fillLen !== undefined ? { l: c.fillLen } : {}) };
  });
  return e.some((x) => x !== 0) ? { e } : {};
}

/** A stored row's clip entries (anything off its knob's stops takes the default). */
function readEntries(src: unknown, patterns: number[]): SongRow['entry'] {
  if (!Array.isArray(src)) return undefined;
  const pick = (v: unknown, stops: readonly number[], d: number) => (typeof v === 'number' && stops.includes(v) ? v : d);
  const out = Array.from({ length: NUM_CHANNELS }, (_, ch): ClipEntry | null => {
    const x: unknown = src[ch];
    if (!isObj(x) || patterns[ch] < 0) return null;
    let gs = pick(x.gs, GLIDE_STEPS, CLIP_ENTRY.glideStart);
    let ge = pick(x.ge, GLIDE_STEPS, CLIP_ENTRY.glideEnd);
    if (ge < gs) [gs, ge] = [ge, gs];
    return compactEntry({ glideStart: gs, glideEnd: ge, fill: pick(x.f, [0, 1, 2, 3], -1), fillLen: pick(x.l, FILL_STEPS, CLIP_ENTRY.fillLen) }) ?? null;
  });
  return out.some((x) => x) ? out : undefined;
}

interface StoredProject {
  format: typeof FILE_FORMAT;
  version: number;
  bpm: number;
  swing: number;
  master: number;
  lfo: LfoState;
  /** v53: `a` = the song's automation (key -> [position, value] pairs). */
  /** v67: a row's `e` = per track how its clip comes in (gs / ge glide start / end, f fill pattern, l fill length; 0 = defaults). */
  song: { rows: { b: number; p: number[]; k?: number[]; e?: (StoredEntry | 0)[] }[]; a?: Record<string, [number, number][]> };
  /** v67: AUTO-FILL per track (1 on, 0 off, -1 DEFAULT); absent = all DEFAULT. */
  ft?: number[];
  /** v85: FX ROUTING per track (-1 = DEFAULT). */
  ch?: number[];
  /** v41: FX 1-3 settings (BUS_PARAMS ids). */
  buses: Record<string, number>[];
  /** v36: time signature (index into METERS; absent = 4/4). */
  meter?: number;
  /** v52: the project's own GLOBAL settings (option indices; absent = DEFAULT). */
  settings?: Record<string, number>;
  /** v59: SCALE's root (pitch class; absent = A); v80: the default key (each track has its own `root` / `chromatic`); before v80 also the project's chromatic keys. */
  root?: number;
  chromatic?: boolean;
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
    ...(p.root !== undefined ? { root: p.root } : {}),
    settings: { ...p.settings },
    ...(p.fillTracks?.some((v) => v >= 0) ? { ft: [...p.fillTracks] } : {}),
    ...(p.chain?.some((v) => v >= 0) ? { ch: [...p.chain] } : {}),
    lfo: { ...p.lfo },
    song: { rows: p.song.rows.map((r) => ({ b: r.bars, p: [...r.patterns], ...(r.keep?.some((k) => k) ? { k: [...r.keep] } : {}), ...storeEntries(r.entry) })), ...(p.song.auto ? { a: JSON.parse(JSON.stringify(p.song.auto)) as Record<string, [number, number][]> } : {}) },
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
      ...(c.root !== undefined ? { root: c.root } : {}),
      ...(c.chromatic ? { chromatic: true } : {}),
      ...(c.keyFrom ? { keyFrom: c.keyFrom } : {}),
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
 * The LEAD's TIMBRE sounds v58 - v70 (WHISTLE, SQUARE, SUPERSAW, HOOVER, FM BITE; carrier 1,
 * `fmratio` its modulator), kept to load older saves: a pre-v58 LEAD (the 3 CARRIER engine) was
 * rebuilt from them at its TIMBRE / INT under its stored trims (v58), then becomes v71's.
 */
const LEAD_SOUNDS_V71: MacroDef = {
  anchors: [
    { name: 'WHISTLE', values: { shape: 0, fm: 0.04, cutoff: 7000, reso: 0, fenv: 0.1, fattack: 0.0005, fdecay: 0.6, fmattack: 0.0005, fmdecay: 0.6, drive: 1.1, glide: 0.15, decay: 1.2, sustain: 0.9, detune: 0, unison: 0, vibrato: 0.35, vibrate: 5.2, vibdelay: 0.35, bend: 0, bendtime: 0.08 } },
    { name: 'SQUARE', values: { shape: 3, fm: 0.06, cutoff: 3500, reso: 0.2, fenv: 0.35, fattack: 0.0005, fdecay: 0.3, fmattack: 0.0005, fmdecay: 0.3, drive: 1.3, glide: 0.06, decay: 0.8, sustain: 0.8, detune: 0.08, unison: 0, vibrato: 0.12, vibrate: 5.5, vibdelay: 0.5, bend: 0, bendtime: 0.08 } },
    { name: 'SUPERSAW', values: { shape: 2, fm: 0.04, cutoff: 5000, reso: 0.1, fenv: 0.25, fattack: 0.0005, fdecay: 0.6, fmattack: 0.0005, fmdecay: 0.6, drive: 1.2, glide: 0.06, decay: 1, sustain: 0.85, detune: 0.6, unison: 1.2, vibrato: 0.05, vibrate: 5.5, vibdelay: 0.6, bend: 0, bendtime: 0.08 } },
    { name: 'HOOVER', values: { shape: 2, fm: 0.08, cutoff: 2200, reso: 0.3, fenv: 0.5, fattack: 0.0005, fdecay: 0.25, fmattack: 0.0005, fmdecay: 0.25, drive: 2, glide: 0.08, decay: 0.9, sustain: 0.8, detune: 1, unison: 1.3, vibrato: 0.25, vibrate: 4, vibdelay: 0.6, bend: -12, bendtime: 0.1 } },
    { name: 'FM BITE', values: { shape: 0, fm: 0.55, cutoff: 4500, reso: 0.15, fenv: 0.4, fattack: 0.0005, fdecay: 0.15, fmattack: 0.0005, fmdecay: 0.15, drive: 1.5, glide: 0.05, decay: 0.6, sustain: 0.7, detune: 0.05, unison: 0, vibrato: 0.1, vibrate: 6, vibdelay: 0.4, bend: 12, bendtime: 0.03 } },
  ],
  excite: [
    { id: 'cutoff', floor: 700, high: 1.4 }, { id: 'reso', floor: 0.05, high: 1.15 }, { id: 'drive', floor: 1, high: 1.5 },
    { id: 'fenv', floor: 0.05, high: 1.3 }, { id: 'detune', floor: 0.03, high: 1.4 },
  ],
};
/** Those sounds' FM pair modulators (carrier 1) and SHAPEs. */
const LEAD_RATIOS_V71 = [2, 2, 2, 1, 2];
const LEAD_SHAPES_V71 = [0, 3, 2, 2, 0];

/** The SHAPE a v58 - v70 LEAD TIMBRE position played (its sounds' SHAPEs blended). */
function leadTimbreV71(t: number): number {
  const u = Math.min(1, Math.max(0, t)) * 4;
  const i = Math.min(3, Math.floor(u));
  return (LEAD_SHAPES_V71[i] + (LEAD_SHAPES_V71[i + 1] - LEAD_SHAPES_V71[i]) * (u - i)) / 4;
}

/** FM RATIO's step for a carrier 1 pair with modulator `m` (the nearest of 1, 2, 3, 4, 5, 7). */
function leadPairV71(m: number): number {
  const mods: [number, number][] = [[1, 0], [2, 1], [3, 2], [4, 5], [5, 6], [7, 7]];
  let best = mods[1];
  for (const x of mods) if (Math.abs(Math.log(x[0] / m)) < Math.abs(Math.log(best[0] / m))) best = x;
  return best[1];
}

/**
 * v71: the LEAD became the BASS's design (TIMBRE = the wave, finished sounds as presets). A
 * v58 - v70 LEAD (raw stored `values`) keeps its sound: TIMBRE = the wave it played (stored
 * SHAPE / 4), FM RATIO its old modulator; the caller takes its trims again over the new waves.
 * In place.
 */
function leadV71(sound: Record<string, number>, values: Record<string, number>): void {
  if (typeof values.shape === 'number') sound.timbre = Math.min(1, Math.max(0, values.shape / 4));
  sound.fmpair = leadPairV71(typeof values.fmratio === 'number' && values.fmratio > 0 ? values.fmratio : 2);
}

/**
 * v71 for a pre-v58 LEAD (also USER patches, all older): first its v58 sound (the v58 - v70
 * sounds at its TIMBRE / INT under its stored trims, as v58 rebuilt it), then as leadV71.
 * In place on the sound; the caller takes the trims again.
 */
export function leadOldV71(sound: Record<string, number>, trims: Record<string, number>): void {
  const specs = INSTRUMENTS.lead.params;
  const t = sound.timbre ?? 0.33, x = sound.intensity ?? 0.5;
  const hidden = macroSoundOf(LEAD_SOUNDS_V71, 'lead', t, x, specs);
  for (const spec of specs) if (hidden[spec.id] !== undefined) sound[spec.id] = applyTrim(spec, hidden[spec.id], trims[spec.id]);
  sound.timbre = hidden.shape / 4;
  sound.fmpair = leadPairV71(LEAD_RATIOS_V71[Math.round(Math.min(1, Math.max(0, t)) * 4)]);
}

/**
 * v46: PERC's order before v46 (v45: SYN DRUM became TIMBALE in place) -> now, by sound:
 * LOW TOM, TIMBALE, CONGA, COWBELL, CLAVE -> LOW TOM, CONGA, COWBELL, TIMBALE, CLAVE.
 */
const PERC_ORDER_V46 = [0, 3, 1, 2, 4];

/**
 * A TIMBRE position from before a reorder (`order`: each old sound's new place), by sound: on
 * (or between two sounds still next to each other) it moves with them; between sounds now
 * apart (or merged into one) it takes the nearer one's place.
 */
function timbreByOrder(order: readonly number[], t: number): number {
  const n = order.length - 1;
  const u = Math.min(1, Math.max(0, t)) * n;
  const i = Math.min(n - 1, Math.floor(u));
  const f = u - i;
  const a = order[i], b = order[i + 1];
  return (Math.abs(a - b) === 1 ? a + (b - a) * f : f < 0.5 ? a : b) / n;
}

/** A PERC TIMBRE position from before v46. */
function percTimbreV46(t: number): number {
  return timbreByOrder(PERC_ORDER_V46, t);
}

/**
 * v68: BASS SINE SUB, GROWL, ACID, SOLID, FM 2:3 -> SINE SUB, GROWL, STICK, SOLID, ACID (ACID
 * and FM 2:3 merged into ACID; STICK new): each old sound's new place.
 */
const BASS_ORDER_V68 = [0, 1, 4, 3, 4];

/** A BASS preset number (= its TIMBRE sound) from before v68. */
function bassPresetV68(p: number): number {
  return BASS_ORDER_V68[p] ?? p;
}

/**
 * v72: the BASS / LEAD presets in TIMBRE order: each old number's new place (BASS SUB, GROWL,
 * STICK, SOLID, ACID, REESE -> SUB, STICK, GROWL, REESE, SOLID, ACID; LEAD WHISTLE, SYNC, BLOOM,
 * HOOVER, FM BITE -> WHISTLE, FM BITE, SYNC, HOOVER, BLOOM). USER patches come after: unmoved.
 */
const PRESET_ORDER_V72: Partial<Record<SoundKind, readonly number[]>> = { bass: [0, 2, 1, 4, 5, 3], lead: [0, 2, 4, 3, 1] };

/** A preset number as stored -> today's (older BASS numbers first take v68's order). */
function presetV72(kind: SoundKind, p: number, version: number): number {
  if (version < 68 && kind === 'bass') p = bassPresetV68(p);
  return version < 72 ? (PRESET_ORDER_V72[kind]?.[p] ?? p) : p;
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
 * v70: the BASS's TIMBRE became the wave (SINE, TRIANGLE, SAW, SQUARE, PULSE at SHAPE 0-4), its
 * finished sounds presets. Before, its five TIMBRE sounds each had their own SHAPE (v40-v67:
 * SINE SUB, GROWL, ACID, SOLID, FM 2:3; v68-v69: SINE SUB, GROWL, STICK, SOLID, ACID) and its
 * FM ratio pair followed TIMBRE in thirds (BASS_LADDER_V70).
 */
const BASS_SHAPES_V70 = { v40: [0, 2, 3, 2.3, 0], v68: [0, 2, 1, 2.3, 3] };
const BASS_LADDER_V70 = { v40: [[1, 2], [2, 3], [3, 2]], v68: [[1, 2], [1, 3], [3, 2]] };

/** The SHAPE a pre-v70 BASS TIMBRE position played (its sounds' SHAPEs blended). */
function bassShapeV70(t: number, version: number): number {
  const shapes = version < 68 ? BASS_SHAPES_V70.v40 : BASS_SHAPES_V70.v68;
  const u = Math.min(1, Math.max(0, t)) * (shapes.length - 1);
  const i = Math.min(shapes.length - 2, Math.floor(u));
  return shapes[i] + (shapes[i + 1] - shapes[i]) * (u - i);
}

/** A pre-v70 BASS TIMBRE position (sound, step lock, SONG lane) -> the wave it played. */
function bassTimbreV70(t: number, version: number): number {
  return bassShapeV70(t, version) / 4;
}

/** FM RATIO's step for a pre-v70 carrier : modulator (2 : 3 has 1 : 3's partials). */
function bassPairV70(c: number, m: number): number {
  const steps = [[1, 1], [1, 2], [1, 3], [3, 2], [3, 4], [1, 4], [1, 5], [1, 7]];
  if (c === 2 && m === 3) return 2;
  const k = steps.findIndex(([sc, sm]) => sc === c && sm === m);
  return k >= 0 ? k : 1;
}

/**
 * v70 (also USER patches): a saved BASS keeps its sound: TIMBRE becomes the wave it played (its
 * stored SHAPE / 4) and FM RATIO its old carrier : modulator pair, from the raw stored
 * `values`; its other values stay as stored and become trims over the new waves (deriveTrims,
 * by the caller). In place.
 */
export function bassV70(sound: Record<string, number>, values: Record<string, number>, version: number): void {
  const t = typeof values.timbre === 'number' ? values.timbre : 0.33;
  sound.timbre = typeof values.shape === 'number' ? Math.min(1, Math.max(0, values.shape / 4)) : bassTimbreV70(t, version);
  const ladder = version < 68 ? BASS_LADDER_V70.v40 : BASS_LADDER_V70.v68;
  const [c, m] = typeof values.cratio === 'number' && typeof values.fmratio === 'number'
    ? [values.cratio, values.fmratio]
    : ladder[Math.min(2, Math.floor(Math.min(1, Math.max(0, t)) * 3))];
  sound.fmpair = bassPairV70(c, m);
}

/** v70: the PAD's FM LVL (now INT's), FM LVL2 and FEEDBACK lost their knobs. */
const PAD_GONE_V70 = ['fm', 'fm2', 'feedback'];

/**
 * v70 (also USER patches): a PAD's edits on FM LVL, FM LVL2 and FEEDBACK go (TIMBRE / INT set
 * them now) and its DETUNE fits the halved range. In place.
 */
export function padV70(sound: Record<string, number>, trims: Record<string, number>): void {
  for (const id of PAD_GONE_V70) delete trims[id];
  rebuildMacros('pad', sound, trims);
  if (sound.detune !== undefined) sound.detune = Math.min(2, sound.detune);
}

/** v70: a PAD step lock / SONG lane on a knob that went. */
function padGoneV70(id: string): boolean {
  return PAD_GONE_V70.includes(id);
}

/**
 * v74: the SNARE rebuilt for punch (a STICK click, the shell's second resonance, a fast small
 * drop, wires as a band swelling in): a saved SNARE's TIMBRE / INT values are rebuilt from the
 * new sounds under its stored trims. SWP TIME and MTL ATK became TIMBRE's: one turned away from
 * its old default (0.04 s / 0.5 ms) stays, as a trim over the new value. In place.
 */
export function snareV74(kind: SoundKind, sound: Record<string, number>, trims: Record<string, number>): void {
  if (kind !== 'snare') return;
  const specs = INSTRUMENTS.snare.params;
  const kept: Record<string, number> = {};
  for (const [id, old] of [['t_stime', 0.04], ['m_attack', 0.0005]] as const) {
    if (trims[id] === undefined && sound[id] !== undefined && Math.abs(sound[id] - old) > 1e-9) kept[id] = sound[id];
  }
  const hidden = hiddenSound(kind, sound, specs);
  for (const [id, v] of Object.entries(kept)) {
    const spec = specs.find((p) => p.id === id);
    if (spec && hidden[id] !== undefined) trims[id] = trimFor(spec, v, hidden[id]);
  }
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

/**
 * v62: KICK / SNARE / HAT play as designed on A (note 33, `DRUM_ROOT`), not C (36), so the
 * default A minor keys hit them on their own pitch: older notes on those tracks move three
 * semitones down and sound as they did (PERC is tuned by note name and stays).
 */
function drumRootV62(kind: InstrumentKind, note: number): number {
  return kind === 'kick' || kind === 'snare' || kind === 'hat' ? Math.max(0, note - 3) : note;
}

/** v63: a KICK's first live knob became INT; a KICK still on the old default (FX1:MOD) takes it. */
function kickLiveV63(ch: ChannelState): void {
  if (ch.instrument === 'kick' && ch.live[0] === 'fx1:mod_vol') ch.live = ['intensity', ch.live[1]];
}

/**
 * v64: new drum live knobs (KICK INT / DECAY, FUNC VOL / AIR; SNARE FX1:MOD / INT, VOL / AIR;
 * HAT FX1:DELAY / ATTACK, VOL / GRIT; PERC FX1:FILTER / INT): a drum whose live knobs are
 * still an older default takes them (each layer on its own; chosen ones stay).
 */
const OLD_DRUM_LIVE: Partial<Record<InstrumentKind, string[]>> = {
  kick: ['fx1:mod_vol,macro:decay', 'intensity,macro:decay'],
  snare: ['fx1:dly_vol,macro:decay'],
  hat: ['fx1:flt,macro:decay'],
  perc: ['macro:knock,macro:decay'],
};
function drumLiveV64(ch: ChannelState): void {
  const old = OLD_DRUM_LIVE[ch.instrument];
  if (!old || ch.instrument === 'none') return;
  const entry = INSTRUMENTS[ch.instrument];
  if (old.includes(ch.live.join(','))) ch.live = [...entry.live];
  if (ch.liveFunc.join(',') === 'mix:volume,macro:grit') ch.liveFunc = [...entry.liveFunc];
}

/** v65: every drum track takes its type's live knobs as they are now (asked for once; offsets centred). */
function drumLiveV65(ch: ChannelState): void {
  if (ch.instrument !== 'none' && INSTRUMENTS[ch.instrument].drum) liveDefaults(ch);
}

/**
 * v66: a macro live knob's stored offset was a knob position (-1..1) pushed through a taper
 * (|x|^1.32) and a 60 % reach; now it is the distance its targets move, so older offsets (on
 * the track, in step locks and SONG lanes, keys `o:`) become that distance and sound as before.
 */
const OLD_TAPER = Math.log(0.4) / Math.log(0.5);
function macroOffsetV66(v: number): number {
  const d = Math.pow(Math.abs(v), OLD_TAPER) * 0.6;
  return v < 0 ? -d : d;
}
function macroLocksV66(locks: Record<string, number>): void {
  for (const k in locks) if (k.startsWith('o:')) locks[k] = macroOffsetV66(locks[k]);
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
      if (version < 66) macroLocksV66(locks);
      locksV70(kind, locks, version);
      if (Object.keys(locks).length) step.locks = locks;
      continue;
    }
    step.active = true;
    step.note = num(s.n, 36, 0, 127);
    if (version < 62) step.note = drumRootV62(kind, step.note);
    step.velocity = num(s.v, 0.8, 0, 1);
    step.gate = Math.round(num(s.g, 1, 1, MAX_STEPS));
    if (version < 83) step.gate = drumTieV83(kind, step.gate);
    step.accent = s.a === 1;
    step.slide = s.s === 1;
    if (s.r === 1) step.ring = true;
    const locks = numbers(s.l);
    if (version < 41) fmEnvV41(locks);
    if (version < 46 && kind === 'perc' && locks.timbre !== undefined) locks.timbre = percTimbreV46(locks.timbre);
    if (version < 66) macroLocksV66(locks);
    locksV70(kind, locks, version);
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
 * v75: AIR is the room it was before v73 again (AIR SIZE 0-1: its RT60, 0.03 s x 40^SIZE). A
 * v73 / v74 save's AIR LEN (s, the gated room's length) becomes the SIZE whose RT60 is that time.
 */
function airSizeV75(seconds: number): number {
  return Math.min(1, Math.max(0, Math.log(Math.max(0.03, seconds) / 0.03) / Math.log(40)));
}
const AIR_KINDS_V75: readonly string[] = ['kick', 'snare'];
/** Saves holding AIR LEN: v73 and v74. */
const airLenSave = (version: number) => version >= 73 && version < 75;

/**
 * v76: a BASS's / LEAD's INT bends the wave (Synth CZ) instead of moving the filter, DRIVE and
 * RESO. A saved one moves to INT 100 (the plain wave it played) and keeps its stored values,
 * which become trims over the new sounds (the filter etc. as its INT had set them), so it
 * plays as saved. Its INT step locks and SONG lanes go (they would bend the wave now).
 */
export function czV76(kind: SoundKind, sound: Record<string, number>): void {
  if (CZ_KINDS_V76.includes(kind)) sound.intensity = 1;
}
const CZ_KINDS_V76: readonly string[] = ['bass', 'lead'];

/**
 * v77: FM COMP (TIMBRE's, no knob) became the dB at FM LVL's peak rise, taken off along a curve
 * (the FM pair now starts in the wave's phase, so FM no longer cancels the note): a saved
 * BASS's / LEAD's old value (dB at FM 100) is taken again from its TIMBRE. In place.
 */
export function fmCompV77(kind: SoundKind, sound: Record<string, number>): void {
  if (CZ_KINDS_V76.includes(kind)) sound.fmcomp = hiddenSound(kind, sound, INSTRUMENTS[kind].params).fmcomp;
}

/**
 * v78: PAD and PLUCK INT move only their carriers (PAD: CARRIERS, CAR FB; PLUCK: the CZ bend
 * below the middle, CAR FB above) and FM LVL is the PAD's knob again. A saved one keeps its
 * stored values (FM LVL, filter, DRIVE, width as its old INT set them), which become trims over
 * the new sounds; a PLUCK moves to INT 50 (the plain wave, no CAR FB: as it played). A PLUCK's
 * INT step locks and SONG lanes go (a PAD's stay: they move its carriers as before). In place.
 */
export function carrierV78(kind: SoundKind, sound: Record<string, number>): void {
  if (kind === 'pluck') sound.intensity = 0.5;
}
const CARRIER_KINDS_V78: readonly string[] = ['pad', 'pluck'];

/**
 * v85: FX ROUTING. Before, synths ran FLT > FX > SPACE and drums FX > SPACE (AIR after DRIVE /
 * CRUSH); the new defaults differ (FX > FLT > SPACE, SPACE > FX). A track whose order is
 * heard keeps its old one as its own setting, so it plays as saved: a synth with CRUSH on or
 * DRIVE past 2, a KICK / SNARE / HAT with AIR and DRIVE or CRUSH on (any of its patterns' sounds).
 */
const CHAIN_DRIVE_V85 = 2;
function chainV85(p: Project): void {
  p.channels.forEach((c, ch) => {
    const kind = c.instrument;
    if (kind === 'none' || chainOrders(kind).length === 0 || (p.chain?.[ch] ?? -1) >= 0) return;
    const sounds = [c.sounds[kind], ...c.patterns.map((pat) => pat.patch?.sound)].filter((x): x is Record<string, number> => !!x);
    // Drums: any DRIVE / CRUSH on the room. Synths: CRUSH, or DRIVE past CHAIN_DRIVE_V85 (every
    // sound has a touch of DRIVE, where the order is barely heard: those take the new default).
    const drumFx = (s: Record<string, number>) => (s.drive ?? 1) > 1 || (s.crush ?? 0) > 0;
    const synthFx = (s: Record<string, number>) => (s.drive ?? 1) > CHAIN_DRIVE_V85 || (s.crush ?? 0) > 0;
    const heard = isDrum(kind) ? sounds.some((s) => drumFx(s) && (s.air ?? 0) > 0) : sounds.some(synthFx);
    if (!heard) return;
    (p.chain ??= new Array<number>(NUM_CHANNELS).fill(-1))[ch] = chainBefore85(kind);
  });
}

/**
 * v85: CRUSH's knob is squared before it reaches the sound (a slower start: 0.5 now = 0.25
 * before, 1 the same), so a stored CRUSH becomes its square root and plays as saved (values,
 * step locks, SONG lanes, USER patches).
 */
export function crushV85(v: number): number {
  return v > 0 ? Math.sqrt(v) : 0;
}
/** v85 on a stored CRUSH trim: taken again over today's sounds for the converted value. */
export function crushTrimV85(kind: SoundKind, sound: Record<string, number>, trims: Record<string, number>): void {
  if (trims.crush === undefined) return;
  const spec = INSTRUMENTS[kind].params.find((x) => x.id === 'crush');
  const hidden = hiddenSound(kind, sound, INSTRUMENTS[kind].params).crush;
  if (!spec || hidden === undefined || sound.crush === undefined) { delete trims.crush; return; }
  const t = trimFor(spec, sound.crush, hidden);
  if (t) trims.crush = t;
  else delete trims.crush;
}

/**
 * v83: a tied drum hit strikes again on every step it is tied over. Before, a drum played out
 * whatever its length, so an older save's drum notes (copied or recorded with a length) go back
 * to one step and play as saved.
 */
function drumTieV83(kind: InstrumentKind, gate: number): number {
  return isDrum(kind) ? 1 : gate;
}

/**
 * v79: the PAD's FM LVL moved from the DX7 level curve (index 13 x 2^((FM - 1) x 99 / 8)) to a
 * square law (13 x FM^2, Synth.stackIndex): a saved FM LVL / FM LVL2 (values, step locks, SONG
 * lanes) becomes the level with the same index, so it plays as saved.
 */
function fmLevelV79(v: number): number {
  return v <= 0 ? 0 : Math.pow(2, ((v - 1) * 99) / 16);
}
const FM_IDS_V79: readonly string[] = ['fm', 'fm2'];
/** v79 on a PAD's sound values, in place. */
export function padFmV79(kind: SoundKind, sound: Record<string, number>): void {
  if (kind !== 'pad') return;
  for (const id of FM_IDS_V79) if (typeof sound[id] === 'number') sound[id] = fmLevelV79(sound[id]);
}

/** v70 / v71 / v75 / v76 / v78 / v81 step locks: FX 3's become FX 2's (busKeysV81); a BASS's / LEAD's TIMBRE follows its wave; a PAD's on FM LVL, FM LVL2, FEEDBACK go; AIR LEN -> AIR SIZE; a BASS's / LEAD's INT go. */
function locksV70(kind: InstrumentKind, locks: Record<string, number>, version: number): void {
  if (version < 81) busKeysV81(locks);
  if (version < 85 && locks.crush !== undefined) locks.crush = crushV85(locks.crush);
  if (version < 82 && kind === 'pad' && locks.modtype !== undefined) locks.modtype = modTypeV82(locks.modtype);
  if (version < 76 && CZ_KINDS_V76.includes(kind)) delete locks.intensity;
  if (version < 78 && kind === 'pluck') delete locks.intensity;
  if (version < 79 && kind === 'pad') for (const id of FM_IDS_V79) if (locks[id] !== undefined) locks[id] = fmLevelV79(locks[id]);
  if (airLenSave(version) && AIR_KINDS_V75.includes(kind) && locks.airsize !== undefined) locks.airsize = airSizeV75(locks.airsize);
  if (version < 71 && kind === 'lead' && locks.timbre !== undefined) locks.timbre = leadTimbreV71(locks.timbre);
  if (version >= 70) return;
  if (kind === 'bass' && locks.timbre !== undefined) locks.timbre = bassTimbreV70(locks.timbre, version);
  if (kind === 'pad') for (const id of PAD_GONE_V70) delete locks[id];
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
  if (version < 70 && kind === 'bass') bassV70(sound, values, version);
  if (version >= 58 && version < 71 && kind === 'lead') leadV71(sound, values);
  if (airLenSave(version) && AIR_KINDS_V75.includes(kind) && typeof values.airsize === 'number') sound.airsize = airSizeV75(values.airsize);
  if (version < 76) czV76(kind, sound);
  // v81: the PAD has CRUSH now; a value left in an older save played nothing.
  if (version < 81 && kind === 'pad') sound.crush = 0;
  if (version < 82 && kind === 'pad' && typeof sound.modtype === 'number') sound.modtype = modTypeV82(sound.modtype);
  if (version < 85 && typeof values.crush === 'number') sound.crush = crushV85(sound.crush);
  const hidden = hiddenSound(kind, sound, specs);
  for (const id in hidden) if (typeof values[id] !== 'number') sound[id] = hidden[id];
  if (version < 77) fmCompV77(kind, sound);
  if (version < 78) carrierV78(kind, sound);
  if (version < 79) padFmV79(kind, sound);
  // A parameter stored without one its knob sets along with it (FM LVL2, added later) takes
  // the knob's value, as the knob would have set it.
  for (const spec of specs) {
    for (const id of linkedParams(kind, spec.id)) if (typeof values[id] !== 'number' && typeof values[spec.id] === 'number') sound[id] = sound[spec.id];
  }
  return sound;
}

/**
 * v80: SCALE is each track's own (root, chromatic keys); the project's root stays as the default
 * key (the PROJECT page's KEY knob). Every track takes the project's SCALE as it was. In place.
 */
function scaleV80(p: Project, chromatic: boolean): void {
  for (const c of p.channels) {
    if (p.root !== undefined) c.root = p.root;
    if (chromatic) c.chromatic = true;
  }
}

/**
 * v82: the PAD's MOD TYPE list became CHORUS / FLANGER / PHASER (was CHORUS / ENSEMBLE / PHASER, as
 * FX 2's): an ENSEMBLE (1) takes the CHORUS (0), its nearest; PHASER stays 2. Also FX 2's old index.
 */
function modTypeV82(v: number): number {
  return Math.round(v) === 1 ? 0 : v;
}

/** v81: an automation key on FX 3 (b:2:) is FX 2's (b:1:); the old FX 2's (b:1:) go (null). */
function busKeyV81(key: string): string | null {
  if (key.startsWith('b:1:')) return null;
  return key.startsWith('b:2:') ? `b:1:${key.slice(4)}` : key;
}

/** v81 on step locks, in place. */
function busKeysV81(locks: Record<string, number>): void {
  for (const key of Object.keys(locks)) {
    const to = busKeyV81(key);
    if (to === key) continue;
    if (to) locks[to] = locks[key];
    delete locks[key];
  }
}

/** The old FX 2's settings a PAD's own effects stand in for (its defaults, for saves without them). */
const FX2_V81 = { mod_vol: 0.3, mod_type: 1, vrb_vol: 0.45 };

/**
 * v81: the old FX 2 (the PAD's send) went, FX 3 is FX 2: send 3 -> 2, send 2 -> none. A PAD
 * that was on FX 2 gets its own MOD / VERB at what it sent there (send level x the return's
 * VOLUME, MOD TYPE as FX 2's), so it keeps its chorus and hall (FX 2's DELAY and TONE are
 * gone). In place.
 */
function sendsV81(p: Project, oldFx2: unknown): void {
  const fx = { ...FX2_V81, ...(isObj(oldFx2) ? numbers(oldFx2) : {}) };
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  for (const c of p.channels) {
    if (c.fxSend === 2 && c.instrument === 'pad') {
      const own = { verb: clamp(fx.vrb_vol * c.sendLevel), modmix: clamp(fx.mod_vol * c.sendLevel), modtype: modTypeV82(Math.max(0, Math.min(2, Math.round(fx.mod_type)))) };
      const sounds = [c.sounds.pad, ...c.patterns.flatMap((pat) => [pat.patch?.sound, pat.savedPatch?.sound])];
      for (const sound of sounds) if (sound) Object.assign(sound, own);
    }
    c.fxSend = c.fxSend === 3 ? 2 : 0;
  }
}

/** v57: ROLL RATE became a note value (1/4 ... 1/64); every older save's drums roll at 1/16. */
export function rollRateV57(sound: Record<string, number>): void {
  if (sound.rolldiv !== undefined) sound.rolldiv = DEFAULT_ROLL_RATE;
}

/** SOUND page trims as stored (derived from the values when absent), pruned to the page. */
function readTrims(kind: SoundKind, sound: Record<string, number>, x: unknown, version: number): Record<string, number> {
  const specs = INSTRUMENTS[kind].params;
  // A rebuilt type (v44 HAT, v45 PERC, pre-v58 LEAD) without stored trims keeps none. A
  // pre-v70 BASS / pre-v71 LEAD keeps its values: its trims are taken again over the new waves
  // (bassV70, leadV71; a pre-v58 LEAD first gets its v58 sound, leadOldV71).
  const rebuilt = (version < 44 && kind === 'hat') || (version < 46 && kind === 'perc') || (version < 58 && kind === 'lead');
  let trims = isObj(x) ? numbers(x) : rebuilt ? {} : deriveTrims(kind, sound, specs);
  if (version < 58 && kind === 'lead') leadOldV71(sound, trims);
  if (version < 76 && CZ_KINDS_V76.includes(kind)) trims = deriveTrims(kind, sound, specs);
  if (version < 41 && isObj(x)) fmEnvV41(trims);
  // Trims stored without a linked parameter's (FM LVL2, added later): the knob's own.
  for (const id of Object.keys(trims)) for (const t of linkedParams(kind, id)) if (isObj(x) && typeof x[t] !== 'number') trims[t] = trims[id];
  if (version < 43 && isObj(x)) drumsV43(kind, sound, trims);
  if (version < 44) hatV44(kind, sound, trims);
  if (version < 46) percV46(kind, sound, trims);
  if (version < 47) kickV47(kind, sound, trims);
  if (version < 70 && kind === 'pad') padV70(sound, trims);
  if (version < 74) snareV74(kind, sound, trims);
  if ((version < 78 && CARRIER_KINDS_V78.includes(kind)) || (version < 79 && kind === 'pad')) trims = deriveTrims(kind, sound, specs);
  if (version < 85) crushTrimV85(kind, sound, trims);
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
  if (patch.preset !== undefined) patch.preset = presetV72(kind, patch.preset, version);
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
    for (const k of ['bass', 'lead'] as const) if (ch.presets[k] !== undefined) ch.presets[k] = presetV72(k, ch.presets[k]!, version);
  }
  const pair = (x: unknown): [string, string] | null =>
    Array.isArray(x) && x.length === 2 && x.every((y) => typeof y === 'string') ? [x[0] as string, x[1] as string] : null;
  ch.live = pair(src.live) ?? ch.live;
  ch.liveFunc = pair(src.liveFunc) ?? ch.liveFunc;
  if (version < 81) {
    // v81: FX 3 is FX 2; the old FX 2's knobs are gone (an unknown id: the type's defaults below).
    const id = (x: string) => (x.startsWith('fx3:') ? `fx2:${x.slice(4)}` : x.startsWith('fx2:') ? 'gone' : x);
    ch.live = [id(ch.live[0]), id(ch.live[1])];
    ch.liveFunc = [id(ch.liveFunc[0]), id(ch.liveFunc[1])];
  }
  if (isObj(src.liveOffset)) {
    const offsets = numbers(src.liveOffset);
    for (const id in offsets) if (offsets[id] !== 0) ch.liveOffset[id] = Math.max(-1, Math.min(1, version < 66 ? macroOffsetV66(offsets[id]) : offsets[id]));
  }
  // Live knobs on parameters the type does not have: back to the type's defaults.
  if (![...ch.live, ...ch.liveFunc].every((id) => liveIdValid(ch.instrument, id))) liveDefaults(ch);
  if (version < 51) liveV51(ch);
  if (version < 63) kickLiveV63(ch);
  if (version < 64) drumLiveV64(ch);
  if (version < 65) drumLiveV65(ch);
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
  if (typeof src.root === 'number') ch.root = Math.round(num(src.root, 9, 0, 11));
  if (src.chromatic === true) ch.chromatic = true;
  if (typeof src.keyFrom === 'number' && src.keyFrom) ch.keyFrom = Math.round(num(src.keyFrom, 0, 0, 11));
  ch.midCut = num(src.midCut, 0, 0, 1);
  ch.mute = src.mute === true;
  // v86: FX 1 SEND is an amount; before, on / off (fx1V86: on = all of it).
  ch.fx1 = typeof src.fx1 === 'number' ? num(src.fx1, 0, 0, 1) : src.fx1 === true ? 1 : 0;
  // Before v81 sends 2 / 3 (FX 2 / FX 3); sendsV81 (fromStored) moves them on.
  const send = Math.round(num(src.fxSend, 0, 0, version < 81 ? 3 : NUM_SENDS));
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
  // v86: eight patterns a track; a save with fewer (or a pattern stored without its patch)
  // gives the rest the active pattern's sound.
  if (ch.instrument === 'none') return;
  for (let p = 0; p < NUM_PATTERNS; p++) {
    if (p !== ch.activePattern && !ch.patterns[p].patch) ch.patterns[p].patch = clonePatch(patchOf(ch, ch.activePattern));
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
function readAuto(x: unknown, version: number): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  if (!isObj(x)) return out;
  for (const stored in x) {
    const pts = x[stored];
    const key = version < 81 ? busKeyV81(stored) : stored;
    const t = key && parseAutoKey(key);
    if (!key || !t || (t.kind === 'b' && t.index >= NUM_BUSES) || !Array.isArray(pts)) continue;
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
  if (typeof data.root === 'number') p.root = Math.round(num(data.root, 9, 0, 11));
  p.settings = {};
  if (isObj(data.settings)) {
    for (const k of SETTING_KEYS) {
      const v = data.settings[k];
      // Option indices (the app keeps each within its own list).
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 64) p.settings[k] = v;
    }
  }
  if (Array.isArray(data.ft)) {
    const ft = Array.from({ length: NUM_CHANNELS }, (_, i) => ((data.ft as unknown[])[i] === 1 ? 1 : (data.ft as unknown[])[i] === 0 ? 0 : -1));
    if (ft.some((v) => v >= 0)) p.fillTracks = ft;
  }
  const version = num(data.version, 0);
  // FX 1-3 (v41; older FX settings take the new buses' defaults).
  if (version >= 41 && Array.isArray(data.buses)) {
    for (let k = 0; k < NUM_BUSES; k++) {
      // v81: the old FX 2 (index 1) went; FX 3 (2) is FX 2 (1).
      const src = data.buses[version < 81 && k === 1 ? 2 : k];
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
      const row: SongRow = { bars: Math.round(num(r.b, 4, 1, SONG_MAX_BARS)), patterns };
      const keep = Array.isArray(r.k) ? (r.k as unknown[]) : [];
      if (keep.length > 0) row.keep = Array.from({ length: NUM_CHANNELS }, (_, i) => (keep[i] === 1 && patterns[i] >= 0 ? 1 : 0));
      const entry = readEntries(r.e, patterns);
      if (entry) row.entry = entry;
      p.song.rows.push(row);
    }
    const auto = readAuto(data.song.a, version);
    if (version < 66) for (const key in auto) if (key.startsWith('o:')) auto[key] = auto[key].map(([at, v]) => [at, macroOffsetV66(v)]);
    if (Object.keys(auto).length > 0) p.song.auto = auto;
  }
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const src = data.channels[i];
    if (isObj(src)) readChannel(src, p.channels[i], version);
  }
  if (version < 80) scaleV80(p, data.chromatic === true);
  if (version < 82 && p.song.auto) {
    for (const key in p.song.auto) {
      const t = parseAutoKey(key);
      if (t?.kind === 's' && t.id === 'modtype' && p.channels[t.index]?.instrument === 'pad') p.song.auto[key] = p.song.auto[key].map(([at, v]) => [at, modTypeV82(v)]);
    }
  }
  if (Array.isArray(data.ch)) {
    const own = Array.from({ length: NUM_CHANNELS }, (_, i) => {
      const v = (data.ch as unknown[])[i];
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < chainOrders(p.channels[i].instrument).length ? v : -1;
    });
    if (own.some((v) => v >= 0)) p.chain = own;
  }
  if (version < 85) chainV85(p);
  if (version < 85 && p.song.auto) {
    // CRUSH lanes (sound params, `s:`) on the new taper.
    for (const key in p.song.auto) {
      const t = parseAutoKey(key);
      if (t?.kind === 's' && t.id === 'crush') p.song.auto[key] = p.song.auto[key].map(([at, v]) => [at, crushV85(v)]);
    }
  }
  if (version < 81) sendsV81(p, version >= 41 && Array.isArray(data.buses) ? data.buses[1] : undefined);
  if (version < 49) typeGainV49(p);
  // v70 / v71: SONG lanes as step locks: a BASS's / LEAD's TIMBRE follows its wave, a PAD's FM
  // LVL, FM LVL2 and FEEDBACK lanes go.
  if (version < 79 && p.song.auto) {
    for (const key in p.song.auto) {
      const t = parseAutoKey(key);
      if (t?.kind !== 's') continue;
      const kind = p.channels[t.index]?.instrument;
      if (version < 71 && kind === 'lead' && t.id === 'timbre') p.song.auto[key] = p.song.auto[key].map(([at, v]) => [at, leadTimbreV71(v)]);
      if (airLenSave(version) && kind !== undefined && AIR_KINDS_V75.includes(kind) && t.id === 'airsize') p.song.auto[key] = p.song.auto[key].map(([at, v]) => [at, airSizeV75(v)]);
      if (kind !== undefined && t.id === 'intensity' && ((version < 76 && CZ_KINDS_V76.includes(kind)) || (version < 78 && kind === 'pluck'))) { delete p.song.auto[key]; continue; }
      if (version < 79 && kind === 'pad' && FM_IDS_V79.includes(t.id)) p.song.auto[key] = p.song.auto[key].map(([at, v]) => [at, fmLevelV79(v)]);
      if (version >= 70) continue;
      if (kind === 'bass' && t.id === 'timbre') p.song.auto[key] = p.song.auto[key].map(([at, v]) => [at, bassTimbreV70(v, version)]);
      if (kind === 'pad' && padGoneV70(t.id)) delete p.song.auto[key];
    }
    if (Object.keys(p.song.auto).length === 0) delete p.song.auto;
  }
  // Rests hidden under ties go (they cut notes and slides unseen): the saved copies too.
  for (const c of p.channels) {
    for (const pat of c.patterns) {
      dropTiedRests(pat.steps, pat.length);
      if (pat.savedNotes) dropTiedRests(pat.savedNotes.steps, pat.savedNotes.length);
    }
  }
  // Every pattern gets its patch and saved versions (where the save had none).
  for (const c of p.channels) initPatterns(c);
  return p;
}
