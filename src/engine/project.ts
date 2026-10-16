/**
 * Project data model (plain JSON). Shared by UI, worklet and persistence.
 * Keep it stable and documented: the hardware rewrite will read the same format.
 */
export const PROJECT_VERSION = 4;
/** One send per effect (delay, distortion, mid-cut, chorus, reverb, flanger). */
export const NUM_SENDS = 6;
export const NUM_CHANNELS = 6;
export const NUM_PATTERNS = 3;
export const MAX_STEPS = 64;
export const DEFAULT_STEPS = 16;
export const PATTERN_NAMES = ['A', 'B', 'C'] as const;
export const STEP_LENGTHS = [16, 32, 48, 64] as const;

export type InstrumentKind = 'none' | 'kick' | 'snare' | 'hat' | 'bass' | 'pad' | 'lead';
export type SoundKind = Exclude<InstrumentKind, 'none'>;

/** Live-knob target: an instrument param id, or a mixer param. */
export type LiveTarget = string; // e.g. "t_decay", "mix:volume", "mix:send0"

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
  /** Send levels 0..1, one per send effect (see src/fx/index.ts EFFECTS). */
  sends: number[];
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
  /** Send effect parameters (see src/fx), id -> value. */
  fx: Record<string, number>;
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
    live: ['mix:volume', 'mix:pan'],
    chord: 0,
    volume: 0.8,
    pan: 0,
    sends: new Array(NUM_SENDS).fill(0),
    mute: false,
    patterns: Array.from({ length: NUM_PATTERNS }, () => emptyPattern()),
    activePattern: 0,
  };
}

/** Best-effort validation of loaded JSON; returns null if it is not a usable project. */
export function normalizeProject(data: unknown): Project | null {
  const p = data as Project;
  if (!p || typeof p !== 'object' || p.version !== PROJECT_VERSION) return null;
  if (!Array.isArray(p.channels) || p.channels.length !== NUM_CHANNELS || !p.fx) return null;
  for (const ch of p.channels) {
    if (!ch.sounds || !Array.isArray(ch.live) || !Array.isArray(ch.sends) || !Array.isArray(ch.patterns) || ch.patterns.length !== NUM_PATTERNS) return null;
    for (const pat of ch.patterns) {
      if (!Array.isArray(pat.steps) || pat.steps.length !== MAX_STEPS) return null;
    }
  }
  return p;
}
