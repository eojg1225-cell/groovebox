/**
 * Project data model (plain JSON). Shared by UI, worklet and persistence.
 * Keep it stable and documented: the hardware rewrite will read the same format.
 */
export const PROJECT_VERSION = 10;
/** FX 1-3: FX 1 = the drum bus (tracks pass through it), FX 2 / FX 3 = sends of six effects. */
export const NUM_SENDS = 3;
export const NUM_EFFECTS = 6;
export const NUM_CHANNELS = 8;
export const NUM_PATTERNS = 4;
export const MAX_STEPS = 64;
/** Most hits a ROLL step can have. */
export const MAX_ROLL = 8;
export const DEFAULT_STEPS = 16;
export const PATTERN_NAMES = ['A', 'B', 'C', 'D'] as const;
/** Patterns with their own button on the panel; D (and A-D for any track) via hold track + FX 1/2/3/LFO. */
export const PANEL_PATTERNS = ['A', 'B', 'C'] as const;
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

export type InstrumentKind = 'none' | 'kick' | 'snare' | 'hat' | 'perc' | 'bass' | 'pad' | 'lead';
export type SoundKind = Exclude<InstrumentKind, 'none'>;

/** Live-knob target: an instrument param id, or a mixer param. */
export type LiveTarget = string; // e.g. "t_decay", "mix:volume", "mix:cutoff", "mix:send"

export interface Step {
  active: boolean;
  /** MIDI-style note number. */
  note: number;
  /** 0..1 */
  velocity: number;
  /** Note length in whole steps (1 = until the next step); tied steps are left empty. */
  gate: number;
  /**
   * SLIDE: if the previous note is still held when this step comes, it glides into this
   * note (legato, no new attack) instead of being released and re-struck.
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
  /** ROLL: hits per step (2-8 = evenly spaced repeats inside the step); absent = 1. */
  roll?: number;
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

export interface Pattern {
  /** 1..MAX_STEPS; the channel loops at this length (polymeter). */
  length: number;
  /** Always MAX_STEPS entries. */
  steps: Step[];
}

export interface ChannelState {
  instrument: InstrumentKind;
  /** Sound per instrument kind, remembered when switching type (param id -> value). */
  sounds: Partial<Record<SoundKind, Record<string, number>>>;
  /** Last chosen preset index per kind (for display). */
  presets: Partial<Record<SoundKind, number>>;
  /** The two parameters on this track's live knobs (record/play modes). */
  live: [LiveTarget, LiveTarget];
  /** Chord mode index into CHORDS (0 = off). */
  chord: number;
  volume: number; // 0..1
  pan: number; // -1..1
  /** Low-pass cutoff of the track (Hz; 20000 = open). */
  cutoff: number;
  /** The track passes through FX 1, the drum bus (independent of its send). */
  fx1: boolean;
  /** Which send the track feeds: 0 = none, 2 or 3 = FX 2 / FX 3. */
  fxSend: number;
  /** How much of the track goes to its send, 0..1. */
  sendLevel: number;
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
    presets: {},
    live: ['mix:volume', 'mix:cutoff'],
    chord: 0,
    volume: 0.8,
    pan: 0,
    cutoff: 20000,
    fx1: false,
    fxSend: 0,
    sendLevel: 0.5,
    lfoOn: false,
    mute: false,
    patterns: Array.from({ length: NUM_PATTERNS }, () => emptyPattern()),
    activePattern: 0,
  };
}
