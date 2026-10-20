/**
 * Project data model (plain JSON). Shared by UI, worklet and persistence.
 * Keep it stable and documented: the hardware rewrite will read the same format.
 */
export const PROJECT_VERSION = 34;
/** FX 1-3: FX 1 = the drum bus (tracks pass through it), FX 2 / FX 3 = sends of six effects. */
export const NUM_SENDS = 3;
export const NUM_EFFECTS = 5;
export const NUM_CHANNELS = 8;
export const NUM_PATTERNS = 4;
export const MAX_STEPS = 64;
/** Most hits a ROLL step can have. */
export const DEFAULT_STEPS = 16;
export const PATTERN_NAMES = ['A', 'B', 'C', 'D'] as const;
export const STEP_LENGTHS = [16, 32, 48, 64] as const;
/** Song: up to this many rows, each up to SONG_MAX_BARS bars. */
export const SONG_MAX_ROWS = 64;
export const SONG_MAX_BARS = 64;

/**
 * One song row: how many bars it lasts and, per track, the pattern it plays (0-3 = A-D)
 * or -1 = the track is silent for the row. Every track restarts its pattern at the row start.
 */
export interface SongRow {
  bars: number;
  patterns: number[];
}

export interface Song {
  rows: SongRow[];
}

import type { LfoState } from './lfo';
import { MAX_CHORD_NOTES } from './chords';

export type InstrumentKind = 'none' | 'kick' | 'snare' | 'hat' | 'perc' | 'bass' | 'pad' | 'lead' | 'pluck';
export type SoundKind = Exclude<InstrumentKind, 'none'>;

/** Live-knob target: an instrument param id, or a mixer param. */
export type LiveTarget = string; // e.g. "t_decay", "cutoff", "mix:volume", "mix:send"

export interface Step {
  active: boolean;
  /** MIDI-style note number. */
  note: number;
  /** 0..1 */
  velocity: number;
  /** Note length in whole steps (1 = until the next step); tied steps are left empty. */
  gate: number;
  /**
   * SLIDE (TB-303 style): this note is held until the next note and glides into it (legato,
   * no new attack), its envelopes held up until then. Before v12 the flag sat on the note
   * slid into. On drum tracks the same flag is ROLL: consecutive ROLL steps roll as one run
   * at the sound's ROLL RATE (hits per step).
   */
  slide: boolean;
  accent: boolean;
  /**
   * RING: the note rings until the next hit or rest on its track (pitched: held; drums:
   * long decay, choked by the next hit, e.g. closed hat -> open hat).
   */
  ring?: boolean;
  /** REST: an explicit stop marker (no note); ends a ringing note. */
  rest?: boolean;
  /**
   * Optional per-step parameter locks (sound param id -> value), written by motion
   * recording. Absent = the channel's own value.
   */
  locks?: Record<string, number>;
}

/** Hit dynamics. Velocity drives both level and the per-hit tone (low-pass) in the engine. */
export type Dynamic = 'ghost' | 'normal' | 'accent';
export const DYNAMIC_VELOCITY: Record<Dynamic, number> = { ghost: 0.45, normal: 0.8, accent: 1 };

export function stepDynamic(step: Step): Dynamic {
  if (step.accent) return 'accent';
  return step.velocity < 0.6 ? 'ghost' : 'normal';
}

export function setStepDynamic(step: Step, d: Dynamic): void {
  step.accent = d === 'accent';
  step.velocity = DYNAMIC_VELOCITY[d];
}

/**
 * A pattern's sound (v31: each pattern A-D has its own) for the track's type: the values,
 * the SOUND page trims on top of TIMBRE / INTENSITY, and the preset it came from.
 */
export interface Patch {
  sound: Record<string, number>;
  trims: Record<string, number>;
  preset?: number;
}

/** A pattern's notes as last SAVEd. */
export interface SavedNotes {
  length: number;
  steps: Step[];
  speed?: PatternSpeed;
}

/** How fast a pattern's steps run: a 16th each (normal), a 32nd (double) or an 8th (half). */
export type PatternSpeed = 'normal' | 'double' | 'half';
export const PATTERN_SPEEDS: readonly PatternSpeed[] = ['normal', 'double', 'half'];
/** One step of a pattern at this speed, in 16th steps of the master clock. */
export function speedSteps(speed: PatternSpeed | undefined): number {
  return speed === 'double' ? 0.5 : speed === 'half' ? 2 : 1;
}

export interface Pattern {
  /** 1..MAX_STEPS; the channel loops at this length (polymeter). */
  length: number;
  /** Half / double time (absent = normal). */
  speed?: PatternSpeed;
  /** Always MAX_STEPS entries. */
  steps: Step[];
  /**
   * This pattern's patch. The pattern being edited (the channel's activePattern) keeps its
   * patch in the channel's sounds / trims / presets instead, so read it with patchOf.
   */
  patch?: Patch;
  /** The notes and patch as last SAVEd (SAVE / SAVE PROJECT); RESET goes back to them. */
  savedNotes?: SavedNotes;
  savedPatch?: Patch;
  /** Edited since the last SAVE (shown as * on the screen). */
  notesDirty?: boolean;
  patchDirty?: boolean;
}

export interface ChannelState {
  instrument: InstrumentKind;
  /** Sound per instrument kind, remembered when switching type (param id -> value). */
  sounds: Partial<Record<SoundKind, Record<string, number>>>;
  /**
   * SOUND page adjustments on top of TIMBRE / INTENSITY per kind (param id -> trim,
   * normalised; see instruments/trims.ts). `sounds` holds the resulting values.
   */
  trims: Partial<Record<SoundKind, Record<string, number>>>;
  /** Last chosen preset index per kind (for display). */
  presets: Partial<Record<SoundKind, number>>;
  /** The two parameters on this track's live knobs (record/play modes). */
  live: [LiveTarget, LiveTarget];
  /** The two parameters on the live knobs while FUNC is held (LIVE 3 / LIVE 4). */
  liveFunc: [LiveTarget, LiveTarget];
  /**
   * Relative live knobs' positions (live id -> -1..1, 0 = centred = the sound as set on the
   * SOUND page). Absent ids are centred.
   */
  liveOffset: Record<string, number>;
  /** Chord mode index into CHORDS (0 = off). */
  chord: number;
  /** NOTES: how many of the chord's tones play (1..MAX_CHORD_NOTES; the max = all). */
  notes: number;
  volume: number; // 0..1
  pan: number; // -1..1
  /** The track passes through FX 1, the drum bus (independent of its send). */
  fx1: boolean;
  /** Which send the track feeds: 0 = none, 2 or 3 = FX 2 / FX 3. */
  fxSend: number;
  /** How much of the track goes to its send, 0..1. */
  sendLevel: number;
  /** ACC/GHOST: how far accents and ghosts sit from normal hits, % (100 = as designed). */
  dynamics: number;
  /** GATE: how long each sequenced note's last step is held, in steps (1/8 .. 2; 1 = as entered). */
  gateLength: number;
  /** MID CUT: the track's own cut after DRIVE, 0..1 (centre = the sound's MID FREQ). */
  midCut: number;
  /** The track is modulated by the (shared) LFO. */
  lfoOn: boolean;
  mute: boolean;
  patterns: Pattern[];
  activePattern: number;
}

export interface Project {
  version: number;
  bpm: number;
  /** 50..75 (%): 50 = straight. */
  swing: number;
  master: number; // 0..1
  /** FX 1, the drum bus: its parameter values (src/fx DRUM_BUS_PARAMS ids). */
  fx1: Record<string, number>;
  /**
   * Per send bus and effect (src/fx EFFECTS order), 0..1: WET = return volume ...
   * Rows 1 and 2 are FX 2 and FX 3; row 0 is unused (FX 1 has its own controls).
   */
  sendWet: number[][];
  /** ... and INTENSITY = how hard the effect works (feedback, drive, depth, size ...). */
  sendInt: number[][];
  /** Each send's bus compressor (COMP_PARAMS ids), [bus]; row 0 unused (FX 1 keeps its own in fx1). */
  sendComp: Record<string, number>[];
  /** The LFO shared by the tracks with lfoOn. */
  lfo: LfoState;
  /** Song mode: rows of patterns, played in order (then from the top again). */
  song: Song;
  /** Master LO-FI (tape saturation + EQ), 0..1. */
  lofi: number;
  channels: ChannelState[];
}

export function emptyStep(note = 36): Step {
  return { active: false, note, velocity: DYNAMIC_VELOCITY.normal, gate: 1, slide: false, accent: false };
}

export function emptyPattern(note = 36): Pattern {
  return { length: DEFAULT_STEPS, steps: Array.from({ length: MAX_STEPS }, () => emptyStep(note)) };
}

export function emptyChannel(): ChannelState {
  return {
    instrument: 'none',
    sounds: {},
    trims: {},
    presets: {},
    live: ['mix:volume', 'mix:pan'],
    liveFunc: ['mix:send', 'mix:pan'],
    liveOffset: {},
    chord: 0,
    notes: MAX_CHORD_NOTES,
    volume: 0.8,
    pan: 0,
    fx1: false,
    fxSend: 0,
    sendLevel: 0.5,
    dynamics: 100,
    gateLength: 1,
    midCut: 0,
    lfoOn: false,
    mute: false,
    patterns: Array.from({ length: NUM_PATTERNS }, () => emptyPattern()),
    activePattern: 0,
  };
}

function copyStep(s: Step): Step {
  const out: Step = { ...s };
  if (s.locks) out.locks = { ...s.locks };
  return out;
}

export function clonePatch(p: Patch): Patch {
  const out: Patch = { sound: { ...p.sound }, trims: { ...p.trims } };
  if (p.preset !== undefined) out.preset = p.preset;
  return out;
}

export function cloneNotes(p: SavedNotes): SavedNotes {
  const out: SavedNotes = { length: p.length, steps: p.steps.map(copyStep) };
  if (p.speed && p.speed !== 'normal') out.speed = p.speed;
  return out;
}

/** The patch of the pattern being edited: the channel's own sound for its type. */
function currentPatch(c: ChannelState): Patch {
  if (c.instrument === 'none') return { sound: {}, trims: {} };
  const k = c.instrument;
  const p: Patch = { sound: (c.sounds[k] ??= {}), trims: (c.trims[k] ??= {}) };
  if (c.presets[k] !== undefined) p.preset = c.presets[k];
  return p;
}

/** Pattern p's patch (the edited pattern's lives in the channel's sound). Not a copy. */
export function patchOf(c: ChannelState, p: number): Patch {
  const pat = c.patterns[p];
  return p === c.activePattern || !pat?.patch ? currentPatch(c) : pat.patch;
}

/** Replace pattern p's patch. */
export function setPatchOf(c: ChannelState, p: number, patch: Patch): void {
  if (p !== c.activePattern) {
    c.patterns[p].patch = clonePatch(patch);
    return;
  }
  if (c.instrument === 'none') return;
  const k = c.instrument;
  c.sounds[k] = { ...patch.sound };
  c.trims[k] = { ...patch.trims };
  if (patch.preset !== undefined) c.presets[k] = patch.preset;
}

/**
 * Edit another pattern: the edited pattern's patch goes back into it and the new one's
 * comes into the channel's sound.
 */
export function editPattern(c: ChannelState, p: number): void {
  if (p === c.activePattern) return;
  const next = c.patterns[p].patch ?? clonePatch(currentPatch(c));
  c.patterns[c.activePattern].patch = clonePatch(currentPatch(c));
  c.activePattern = p;
  delete c.patterns[p].patch; // the edited pattern's patch is the channel's sound
  setPatchOf(c, p, next);
}

/** Every pattern gets its own patch and saved versions (missing ones: as it is now). */
export function initPatterns(c: ChannelState): void {
  c.patterns.forEach((pat, p) => {
    if (p !== c.activePattern && !pat.patch) pat.patch = clonePatch(currentPatch(c));
    if (!pat.savedNotes) {
      pat.savedNotes = cloneNotes(pat);
      pat.notesDirty = false;
    }
    if (!pat.savedPatch) {
      pat.savedPatch = clonePatch(patchOf(c, p));
      pat.patchDirty = false;
    }
  });
}

/** SAVE: the pattern's notes and / or patch as they are now become its saved version. */
export function lockPattern(c: ChannelState, p: number, notes: boolean, patch: boolean): void {
  const pat = c.patterns[p];
  if (notes) {
    pat.savedNotes = cloneNotes(pat);
    pat.notesDirty = false;
  }
  if (patch) {
    pat.savedPatch = clonePatch(patchOf(c, p));
    pat.patchDirty = false;
  }
}

/** SAVE PROJECT: every pattern and patch saved. */
export function lockProject(p: Project): void {
  for (const c of p.channels) for (let i = 0; i < NUM_PATTERNS; i++) lockPattern(c, i, true, true);
}
