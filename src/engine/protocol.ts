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
  | { type: 'setPatternLength'; channel: number; pattern: number; length: number }
  /** Switch pattern; quantised to the end of the channel's loop unless immediate or stopped. */
  | { type: 'selectPattern'; channel: number; pattern: number; immediate: boolean }
  /** Instrument parameter in real units. */
  | { type: 'setSound'; channel: number; id: string; value: number }
  | { type: 'setMix'; channel: number; id: MixParam; value: number }
  | { type: 'setGlobal'; id: GlobalParam; value: number }
  | { type: 'transport'; playing: boolean }
  /** Audition / play a note on a channel now. */
  | { type: 'trigger'; channel: number; note: number; velocity: number }
  /**
   * Motion record: play the note now and, if playing, write it into the nearest step of
   * the channel's playing pattern. The worklet answers with "recordedNote".
   */
  | { type: 'recordNote'; channel: number; note: number; velocity: number; accent: boolean }
  /**
   * Motion record: lock a sound parameter on the step playing now (and hear it now).
   * The worklet answers with "recordedLock".
   */
  | { type: 'recordLock'; channel: number; id: string; value: number }
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
  | { type: 'pong'; id: number }
  | {
      type: 'recordedNote';
      channel: number; pattern: number; index: number;
      note: number; velocity: number; accent: boolean;
    }
  | { type: 'recordedLock'; channel: number; pattern: number; index: number; id: string; value: number };

export const STATUS_HZ = 30;
