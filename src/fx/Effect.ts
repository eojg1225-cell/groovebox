import type { ParamSpec } from '../engine/params';

/**
 * Send effect: reads a send bus, ADDS its wet output (already scaled by its return level)
 * into the output. Allocation-free in process().
 */
export interface Effect {
  readonly params: readonly ParamSpec[];
  setParam(id: string, value: number): void;
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, outOffset: number, n: number): void;
  /** Silence its memory (buffers, filter states): it restarts clean after being skipped. */
  reset(): void;
}
