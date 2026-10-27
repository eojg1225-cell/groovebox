/**
 * UNDO / REDO: whole-project snapshots, taken between gestures (App.beginGesture).
 *
 * A snapshot is the project in a canonical form, so that what UNDO leaves alone (which
 * pattern is being edited, MUTE, the project's settings, the saved copies) neither shows as
 * a change nor comes back with an older snapshot. Going back to one sends the engine only
 * what differs.
 */
import { BUS_PARAMS } from '../fx/buses';
import { LFO_PARAMS, type LfoId } from '../engine/lfo';
import { MIX_FIELD } from '../engine/mixParams';
import type { MainToWorklet } from '../engine/protocol';
import {
  DYNAMIC_VELOCITY, MAX_STEPS, NUM_PATTERNS, cloneNotes, clonePatch, emptyStep, patchOf, setPatchOf,
  type ChannelState, type Patch, type Pattern, type PatternSpeed, type Project, type Step,
} from '../engine/project';

/** How many steps UNDO goes back. */
export const UNDO_DEPTH = 16;

export interface HistoryEntry {
  label: string;
  before: string;
  after: string;
}

type Rec = Record<string, number>;

/** A map with its keys in order: the same values give the same snapshot however the map was built. */
const sorted = <T>(o: Record<string, T>): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
};

const patchCopy = (p: Patch): Patch => ({ sound: sorted(p.sound), trims: sorted(p.trims), ...(p.preset !== undefined ? { preset: p.preset } : {}) });

/** A step as nothing but its note (inactive, no flags): most steps, so a snapshot stays small. */
function blank(st: Step): boolean {
  return !st.active && st.velocity === DYNAMIC_VELOCITY.normal && st.gate === 1 && !st.slide && !st.accent && !st.ring && !st.rest && !st.flip && !st.locks && !st.extra && !st.extraGate;
}

/** A channel in a snapshot: its fields, the other types' remembered sounds, every pattern with its own patch. */
interface SnapChannel {
  fields: Record<string, unknown>;
  sounds: ChannelState['sounds'];
  trims: ChannelState['trims'];
  presets: ChannelState['presets'];
  patterns: { length: number; speed?: PatternSpeed; steps: (Step | number)[]; patch?: Patch }[];
}

const OWN = new Set(['sounds', 'trims', 'presets', 'patterns', 'mute', 'activePattern']);

/**
 * The project as a snapshot: the notes, sounds, mix, FX, LFO and song; not which pattern is
 * being edited, MUTE, the project's settings or the saved copies.
 */
export function snapshot(project: Project): string {
  const channels: SnapChannel[] = project.channels.map((c) => {
    const fields: Record<string, unknown> = {};
    for (const k of Object.keys(c).sort()) if (!OWN.has(k)) fields[k] = c[k as keyof ChannelState];
    fields.liveOffset = sorted(c.liveOffset);
    const kind = c.instrument;
    const others = <T>(m: Partial<Record<string, T>>) => {
      const out: Record<string, T> = {};
      for (const k of Object.keys(m).sort()) if (k !== kind) out[k] = m[k] as T;
      return out;
    };
    return {
      fields,
      sounds: others(c.sounds),
      trims: others(c.trims),
      presets: others(c.presets),
      patterns: c.patterns.map((pat, i) => ({
        length: pat.length,
        ...(pat.speed && pat.speed !== 'normal' ? { speed: pat.speed } : {}),
        steps: pat.steps.map((st) => (blank(st) ? st.note : st)),
        ...(kind !== 'none' ? { patch: patchCopy(patchOf(c, i)) } : {}),
      })),
    };
  });
  return JSON.stringify({
    bpm: project.bpm, swing: project.swing, master: project.master, meter: project.meter,
    buses: project.buses.map(sorted), lfo: sorted(project.lfo as unknown as Rec), song: project.song, channels,
  });
}

/**
 * The project a snapshot holds, as it would be now: each channel editing the pattern it
 * edits now, MUTE and the settings as they are; the saved copies (SAVE PROJECT) as they are,
 * with the unsaved marks (*) to match (a track that changes type back: its patches unsaved).
 */
export function restore(snap: string, now: Project): Project {
  const s = JSON.parse(snap) as { bpm: number; swing: number; master: number; meter: number; buses: Rec[]; lfo: Rec; song: Project['song']; channels: SnapChannel[] };
  const p: Project = { ...now, bpm: s.bpm, swing: s.swing, master: s.master, meter: s.meter, buses: s.buses, lfo: s.lfo as unknown as Project['lfo'], song: s.song, channels: [] };
  p.channels = s.channels.map((sc, ch) => {
    const cur = now.channels[ch];
    const c = { ...sc.fields, sounds: sc.sounds, trims: sc.trims, presets: sc.presets, mute: cur.mute, activePattern: cur.activePattern } as ChannelState;
    c.patterns = sc.patterns.map((sp, i) => {
      const pat: Pattern = { length: sp.length, steps: sp.steps.map((st) => (typeof st === 'number' ? emptyStep(st) : st)) };
      if (sp.speed) pat.speed = sp.speed;
      if (sp.patch && i !== c.activePattern) pat.patch = sp.patch;
      return pat;
    });
    const own = sc.patterns[c.activePattern].patch;
    if (own) setPatchOf(c, c.activePattern, own);
    const sameKind = c.instrument === cur.instrument;
    c.patterns.forEach((pat, i) => {
      const was = cur.patterns[i];
      pat.savedNotes = was.savedNotes;
      pat.notesDirty = !!was.savedNotes && JSON.stringify(cloneNotes(pat)) !== JSON.stringify(cloneNotes(was.savedNotes));
      pat.savedPatch = sameKind || !was.savedPatch ? was.savedPatch : clonePatch(patchOf(c, i));
      pat.patchDirty = !sameKind || (!!was.savedPatch && !samePatch(patchOf(c, i), was.savedPatch));
    });
    return c;
  });
  return p;
}

function samePatch(a: Patch, b: Patch): boolean {
  const same = (x: Record<string, number>, y: Record<string, number>) => {
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) if (x[k] !== y[k]) return false;
    return true;
  };
  return same(a.sound, b.sound) && same(a.trims, b.trims) && a.preset === b.preset;
}

/** What the engine needs to go from project a to project b (it plays on). */
export function changes(a: Project, b: Project): MainToWorklet[] {
  const out: MainToWorklet[] = [];
  for (const id of ['bpm', 'swing', 'master', 'meter'] as const) {
    if (a[id] !== b[id]) out.push({ type: 'setGlobal', id, value: b[id] });
  }
  BUS_PARAMS.forEach((specs, k) => {
    for (const spec of specs) {
      const v = b.buses[k]?.[spec.id] ?? spec.defaultValue;
      if ((a.buses[k]?.[spec.id] ?? spec.defaultValue) !== v) out.push({ type: 'setBus', bus: k, id: spec.id, value: v });
    }
  });
  for (const id of Object.keys(LFO_PARAMS) as LfoId[]) {
    if (a.lfo[id] !== b.lfo[id]) out.push({ type: 'setLfo', id, value: b.lfo[id] });
  }
  if (JSON.stringify(a.song) !== JSON.stringify(b.song)) out.push({ type: 'setSong', song: b.song });
  b.channels.forEach((c, ch) => {
    const o = a.channels[ch];
    const kind = c.instrument !== o.instrument;
    if (kind) out.push({ type: 'setInstrument', channel: ch, kind: c.instrument, sound: { ...patchOf(c, c.activePattern).sound } });
    for (let p = 0; p < NUM_PATTERNS; p++) {
      const pat = c.patterns[p];
      const was = o.patterns[p];
      if (c.instrument !== 'none' && (kind || !samePatch(patchOf(c, p), patchOf(o, p)))) {
        out.push({ type: 'setPatch', channel: ch, pattern: p, sound: { ...patchOf(c, p).sound }, glide: false });
      }
      if (pat.length !== was.length) out.push({ type: 'setPatternLength', channel: ch, pattern: p, length: pat.length });
      if ((pat.speed ?? 'normal') !== (was.speed ?? 'normal')) out.push({ type: 'setPatternSpeed', channel: ch, pattern: p, speed: pat.speed ?? 'normal' });
      for (let i = 0; i < MAX_STEPS; i++) {
        if (JSON.stringify(pat.steps[i]) !== JSON.stringify(was.steps[i])) out.push({ type: 'setStep', channel: ch, pattern: p, index: i, step: pat.steps[i] });
      }
    }
    for (const id of new Set([...Object.keys(o.liveOffset), ...Object.keys(c.liveOffset)])) {
      if ((o.liveOffset[id] ?? 0) !== (c.liveOffset[id] ?? 0)) out.push({ type: 'setOffset', channel: ch, id, value: c.liveOffset[id] ?? 0 });
    }
    if (kind || c.chord !== o.chord) out.push({ type: 'setChord', channel: ch, chord: c.chord });
    if (kind || c.notes !== o.notes) out.push({ type: 'setNotes', channel: ch, notes: c.notes });
    for (const id of Object.keys(MIX_FIELD) as (keyof typeof MIX_FIELD)[]) {
      const f = MIX_FIELD[id];
      if (c[f] !== o[f]) out.push({ type: 'setMix', channel: ch, id, value: c[f] });
    }
    if (c.fxSend !== o.fxSend) out.push({ type: 'setRouting', channel: ch, send: c.fxSend });
    if (c.fx1 !== o.fx1) out.push({ type: 'setDrumBus', channel: ch, on: c.fx1 });
    if (c.lfoOn !== o.lfoOn) out.push({ type: 'setLfoTrack', channel: ch, on: c.lfoOn });
  });
  return out;
}
