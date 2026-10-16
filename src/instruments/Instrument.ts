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
   */
  noteOn(note: number, velocity: number, group: number): void;
  /** Release voices of a group; -1 releases everything. Percussive voices may ignore it. */
  noteOff(group: number): void;
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
