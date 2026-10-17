import type { ParamSpec } from '../engine/params';

/**
 * Common interface for every sound source. Implementations must be allocation-free in
 * noteOn/noteOff/setParam/render.
 */
export interface Instrument {
  readonly params: readonly ParamSpec[];
  /**
   * note is a MIDI-style note number; velocity 0..1. `group` tags the voices started
   * together (e.g. all notes of a chord) so noteOff can release them as one.
   * `ring` = a RING step: drums use their long, chokeable decay.
   * `slideFrom` >= 0: a SLIDE (legato) from the still-sounding group `slideFrom` - synths
   * glide that voice to the new pitch without restarting its envelopes; drums ignore it.
   * `slide` = this note is a SLIDE note (it will glide into the next one): synths hold its
   * envelopes up until then; drums ignore it.
   */
  noteOn(note: number, velocity: number, group: number, ring: boolean, slideFrom?: number, slide?: boolean): void;
  /** Release voices of a group; -1 releases everything. Percussive voices may ignore it. */
  noteOff(group: number): void;
  /** Pitch modulation in semitones (LFO), applied to sounding voices. Block rate. */
  setPitchMod(semitones: number): void;
  /** Filter cutoff modulation in octaves (LFO). Block rate. */
  setFilterMod(octaves: number): void;
  /** FM level modulation (LFO FM MOD), added to FM (0..1 units). Block rate; drums ignore it. */
  setFmMod(amount: number): void;
  /** Value in real units (see ParamSpec). Unknown ids are ignored. */
  setParam(id: string, value: number): void;
  /** ADD output into outL/outR for frames [start, end). */
  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void;
}

/** A named set of parameter values (missing ids keep their defaults). */
export interface Preset {
  name: string;
  values: Record<string, number>;
}
