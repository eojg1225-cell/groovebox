/**
 * Project data model (plain JSON). Shared by UI, worklet and persistence.
 * Keep it stable and documented: the hardware rewrite will read the same format.
 */
export const PROJECT_VERSION = 1;
export const NUM_CHANNELS = 6;
/** Channels the UI exposes for now; the rest stay in the model, silent. */
export const ACTIVE_CHANNELS = 4;
export const NUM_PATTERNS = 3;
export const MAX_STEPS = 64;
export const DEFAULT_STEPS = 16;
export const PATTERN_NAMES = ['A', 'B', 'C'] as const;

export type InstrumentKind = 'none' | 'kick' | 'snare' | 'hat' | 'bass';

export interface Step {
  active: boolean;
  /** MIDI-style note number. */
  note: number;
  /** 0..1 */
  velocity: number;
  /** Gate length in steps (used by pitched instruments later). */
  gate: number;
  slide: boolean;
  accent: boolean;
}

export interface Pattern {
  /** 1..MAX_STEPS; the channel loops at this length (polymeter). */
  length: number;
  /** Always MAX_STEPS entries. */
  steps: Step[];
}

export interface ChannelState {
  instrument: InstrumentKind;
  /** Instrument parameter values in real units, keyed by ParamSpec id. */
  sound: Record<string, number>;
  volume: number; // 0..1
  pan: number; // -1..1
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
  channels: ChannelState[];
}

export function emptyStep(note = 36): Step {
  return { active: false, note, velocity: 0.8, gate: 1, slide: false, accent: false };
}

export function emptyPattern(note = 36): Pattern {
  return { length: DEFAULT_STEPS, steps: Array.from({ length: MAX_STEPS }, () => emptyStep(note)) };
}

function channel(instrument: InstrumentKind, volume = 0.8): ChannelState {
  return {
    instrument,
    sound: {},
    volume,
    pan: 0,
    mute: false,
    patterns: Array.from({ length: NUM_PATTERNS }, () => emptyPattern()),
    activePattern: 0,
  };
}

function setSteps(p: Pattern, indices: number[], notes?: number[], velocity = 0.8): void {
  indices.forEach((i, n) => {
    const s = p.steps[i];
    s.active = true;
    s.velocity = velocity;
    if (notes) s.note = notes[n % notes.length];
  });
}

/** Demo project: a 128 BPM techno loop with a simple bassline. */
export function createDefaultProject(): Project {
  const kick = channel('kick', 0.9);
  const snare = channel('snare', 0.7);
  const hat = channel('hat', 0.55);
  const bass = channel('bass', 0.7);
  setSteps(kick.patterns[0], [0, 4, 8, 12], undefined, 1);
  setSteps(snare.patterns[0], [4, 12]);
  setSteps(hat.patterns[0], [2, 6, 10, 14], undefined, 0.9);
  setSteps(hat.patterns[0], [3, 11], undefined, 0.45);
  setSteps(bass.patterns[0], [2, 3, 6, 10, 11, 14], [36, 36, 48, 36, 39, 34]);
  // Pattern B: a jungle-ish variation to switch to.
  setSteps(kick.patterns[1], [0, 10]);
  setSteps(snare.patterns[1], [4, 12, 15]);
  setSteps(hat.patterns[1], [0, 2, 4, 6, 8, 10, 12, 14], undefined, 0.7);
  setSteps(bass.patterns[1], [0, 7, 10], [33, 33, 36]);
  return {
    version: PROJECT_VERSION,
    bpm: 128,
    swing: 50,
    master: 0.8,
    channels: [kick, snare, hat, bass, channel('none'), channel('none')],
  };
}

/** Best-effort validation of loaded JSON; returns null if it is not a usable project. */
export function normalizeProject(data: unknown): Project | null {
  const p = data as Project;
  if (!p || typeof p !== 'object' || p.version !== PROJECT_VERSION) return null;
  if (!Array.isArray(p.channels) || p.channels.length !== NUM_CHANNELS) return null;
  for (const ch of p.channels) {
    if (!Array.isArray(ch.patterns) || ch.patterns.length !== NUM_PATTERNS) return null;
    for (const pat of ch.patterns) {
      if (!Array.isArray(pat.steps) || pat.steps.length !== MAX_STEPS) return null;
    }
  }
  return p;
}
