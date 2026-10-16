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
  MAX_STEPS, NUM_CHANNELS, NUM_PATTERNS, NUM_SENDS, PROJECT_VERSION,
  type ChannelState, type Project, type SoundKind,
} from './project';
import { applyPreset, createDefaultProject } from './defaultProject';
import { INSTRUMENTS, SOUND_KINDS, presetSound } from '../instruments/registry';
import { FX_PARAMS } from '../fx';

export const FILE_FORMAT = 'groovebox-project';

/** One step with a note: index, note, velocity; gate/accent/locks only when set. */
export interface StoredStep {
  i: number;
  n: number;
  v: number;
  g?: number;
  a?: 1;
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
  sends: number[];
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
  fx: Record<string, number>;
  channels: StoredChannel[];
}

export function toStored(p: Project): StoredProject {
  return {
    format: FILE_FORMAT,
    version: PROJECT_VERSION,
    bpm: p.bpm,
    swing: p.swing,
    master: p.master,
    fx: { ...p.fx },
    channels: p.channels.map((c) => ({
      instrument: c.instrument,
      sounds: JSON.parse(JSON.stringify(c.sounds)) as Record<string, Record<string, number>>,
      presets: { ...c.presets } as Record<string, number>,
      live: [...c.live],
      chord: c.chord,
      volume: c.volume,
      pan: c.pan,
      sends: [...c.sends],
      mute: c.mute,
      activePattern: c.activePattern,
      patterns: c.patterns.map((pat) => ({
        len: pat.length,
        steps: pat.steps.flatMap((s, i): StoredStep[] => {
          if (!s.active) return [];
          const out: StoredStep = { i, n: s.note, v: s.velocity };
          if (s.gate > 1) out.g = s.gate;
          if (s.accent) out.a = 1;
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
function readSteps(pattern: Obj): { i: number; note: number; vel: number; gate: number; accent: boolean; locks?: Record<string, number> }[] {
  const steps = Array.isArray(pattern.steps) ? pattern.steps : [];
  const out = [];
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    if (!isObj(s)) continue;
    const compact = typeof s.i === 'number';
    if (!compact && s.active !== true) continue;
    const i = compact ? s.i as number : k;
    if (!Number.isInteger(i) || i < 0 || i >= MAX_STEPS) continue;
    const locks = numbers(compact ? s.l : s.locks);
    out.push({
      i,
      note: num(compact ? s.n : s.note, 36, 0, 127),
      vel: num(compact ? s.v : s.velocity, 0.8, 0, 1),
      gate: Math.round(num(compact ? s.g : s.gate, 1, 1, MAX_STEPS)),
      accent: compact ? s.a === 1 : s.accent === true,
      locks: Object.keys(locks).length ? locks : undefined,
    });
  }
  return out;
}

function readChannel(src: Obj, ch: ChannelState): void {
  const kind = src.instrument;
  if (typeof kind === 'string' && (SOUND_KINDS as string[]).includes(kind) && kind !== ch.instrument) {
    applyPreset(ch, kind as SoundKind, 0);
  }
  // Sounds: keep values for parameters this version knows.
  if (isObj(src.sounds)) {
    for (const k of SOUND_KINDS) {
      const values = numbers(src.sounds[k]);
      const known = new Set(INSTRUMENTS[k].params.map((p) => p.id));
      const kept = Object.fromEntries(Object.entries(values).filter(([id]) => known.has(id)));
      if (Object.keys(kept).length) ch.sounds[k] = { ...(ch.sounds[k] ?? presetSound(k, 0)), ...kept };
    }
  }
  if (isObj(src.presets)) {
    for (const k of SOUND_KINDS) if (typeof src.presets[k] === 'number') ch.presets[k] = src.presets[k] as number;
  }
  if (Array.isArray(src.live) && src.live.length === 2 && src.live.every((x) => typeof x === 'string')) {
    ch.live = [src.live[0] as string, src.live[1] as string];
  }
  ch.chord = Math.round(num(src.chord, ch.chord, 0, 64));
  ch.volume = num(src.volume, ch.volume, 0, 1);
  ch.pan = num(src.pan, ch.pan, -1, 1);
  ch.mute = src.mute === true;
  if (Array.isArray(src.sends)) for (let k = 0; k < NUM_SENDS; k++) ch.sends[k] = num(src.sends[k], ch.sends[k], 0, 1);
  ch.activePattern = Math.round(num(src.activePattern, 0, 0, NUM_PATTERNS - 1));

  if (!Array.isArray(src.patterns)) return;
  for (let p = 0; p < NUM_PATTERNS; p++) {
    const sp = src.patterns[p];
    if (!isObj(sp)) continue;
    const pat = ch.patterns[p];
    pat.length = Math.round(num(sp.len ?? sp.length, pat.length, 1, MAX_STEPS));
    for (const s of readSteps(sp)) {
      const step = pat.steps[s.i];
      step.active = true;
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
  p.bpm = num(data.bpm, p.bpm, 60, 200);
  p.swing = num(data.swing, p.swing, 50, 75);
  p.master = num(data.master, p.master, 0, 1);
  const fx = numbers(data.fx);
  for (const spec of FX_PARAMS) if (spec.id in fx) p.fx[spec.id] = Math.min(spec.max, Math.max(spec.min, fx[spec.id]));
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const src = data.channels[i];
    if (isObj(src)) readChannel(src, p.channels[i]);
  }
  return p;
}
