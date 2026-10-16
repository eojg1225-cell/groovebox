import type { ParamSpec } from '../engine/params';

/**
 * Common interface for every sound source. Implementations must be allocation-free in
 * noteOn/noteOff/setParam/render.
 */
export interface Instrument {
  readonly params: readonly ParamSpec[];
  /** note is a MIDI-style note number; velocity 0..1. */
  noteOn(note: number, velocity: number): void;
  noteOff(): void;
  /** Value in real units (see ParamSpec). Unknown ids are ignored. */
  setParam(id: string, value: number): void;
  /** ADD output into outL/outR for frames [start, end). */
  render(outL: Float32Array, outR: Float32Array, start: number, end: number): void;
}
