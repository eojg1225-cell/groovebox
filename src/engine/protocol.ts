/**
 * Message protocol between the main thread (UI) and the audio worklet.
 * Plain data only, so it survives structured cloning and can be documented / ported.
 *
 * Parameter ids are "<target>.<param>", e.g. "tone.freq" or "master.volume".
 */

export type MainToWorklet =
  /** Set a parameter in real units (not normalised). */
  | { type: 'setParam'; id: string; value: number }
  /** Transport. In M0, "playing" gates the test-tone drone. */
  | { type: 'transport'; playing: boolean }
  /** Fire a one-shot note (M0: test-tone blip). velocity 0..1. */
  | { type: 'trigger'; note: number; velocity: number }
  /** Round-trip timing probe; the worklet answers with "pong" carrying the same id. */
  | { type: 'ping'; id: number };

export type WorkletToMain =
  | { type: 'ready'; sampleRate: number }
  /** Sent at ~30 Hz. Peaks are linear 0..1+, frame is the audio-clock frame counter. */
  | { type: 'status'; peakL: number; peakR: number; frame: number; playing: boolean }
  | { type: 'pong'; id: number };

/** Rate at which the worklet reports status to the UI. */
export const STATUS_HZ = 30;
