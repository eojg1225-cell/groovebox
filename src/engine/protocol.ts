/**
 * Message protocol between the main thread (UI) and the audio worklet.
 * Plain data only, so it survives structured cloning and can be documented / ported.
 */
import type { Project, Step } from './project';

export type MixParam = 'volume' | 'pan' | 'mute';
export type GlobalParam = 'bpm' | 'swing' | 'master';

export type MainToWorklet =
  /** Replace the whole engine state (startup, session restore). */
  | { type: 'loadProject'; project: Project }
  | { type: 'setStep'; channel: number; pattern: number; index: number; step: Step }
  /** Switch pattern; quantised to the end of the channel's loop unless immediate or stopped. */
  | { type: 'selectPattern'; channel: number; pattern: number; immediate: boolean }
  /** Instrument parameter in real units. */
  | { type: 'setSound'; channel: number; id: string; value: number }
  | { type: 'setMix'; channel: number; id: MixParam; value: number }
  | { type: 'setGlobal'; id: GlobalParam; value: number }
  | { type: 'transport'; playing: boolean }
  /** Audition a note on a channel. */
  | { type: 'trigger'; channel: number; note: number; velocity: number }
  /** Round-trip timing probe; the worklet answers with "pong" carrying the same id. */
  | { type: 'ping'; id: number };

export type WorkletToMain =
  | { type: 'ready'; sampleRate: number }
  /**
   * ~30 Hz. steps[ch] is the step index last played (-1 when stopped);
   * patterns[ch] is the pattern currently playing.
   */
  | {
      type: 'status';
      peakL: number;
      peakR: number;
      frame: number;
      playing: boolean;
      steps: number[];
      patterns: number[];
    }
  | { type: 'pong'; id: number };

export const STATUS_HZ = 30;
