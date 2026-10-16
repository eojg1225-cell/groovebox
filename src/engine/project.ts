/**
 * Project data model (plain JSON). Shared by UI, worklet and persistence.
 * Keep it stable and documented: the hardware rewrite will read the same format.
 */
export const PROJECT_VERSION = 6;
/** Send buses (FX 1-3); each holds all six effects (see src/fx). */
export const NUM_SENDS = 3;
export const NUM_EFFECTS = 6;
export const NUM_CHANNELS = 6;
export const NUM_PATTERNS = 3;
export const MAX_STEPS = 64;
export const DEFAULT_STEPS = 16;
export const PATTERN_NAMES = ['A', 'B', 'C'] as const;
export const STEP_LENGTHS = [16, 32, 48, 64] as const;

import { defaultLfo, type LfoState } from './lfo';

export type InstrumentKind = 'none' | 'kick' | 'snare' | 'hat' | 'bass' | 'pad' | 'lead';
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
  /** Which send the track feeds: 0 = none, 1-3 = FX send. */
  fxSend: number;
  /** How much of the track goes to its send, 0..1. */
  sendLevel: number;
  /** Track LFO (rate, shape, volume and pitch modulation). */
  lfo: LfoState;
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
  /** Per send and effect (src/fx EFFECTS order), 0..1: WET = return volume ... */
  sendWet: number[][];
  /** ... and INTENSITY = how hard the effect works (feedback, drive, depth, size ...). */
  sendInt: number[][];
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
    fxSend: 0,
    sendLevel: 0.5,
    lfo: defaultLfo(),
    mute: false,
    patterns: Array.from({ length: NUM_PATTERNS }, () => emptyPattern()),
    activePattern: 0,
  };
}
