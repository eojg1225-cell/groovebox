/**
 * The level match off the main thread (it renders two notes offline, which made the page and
 * the audio stutter while a knob moved): how many dB the candidate's sound `b` plays louder
 * than A's `a`. Answers each request with its id; the page keeps only the latest.
 */
import type { SoundKind } from '../../src/engine/project';
import { loudness } from './loudness';

self.onmessage = (e: MessageEvent<{ id: number; kind: SoundKind; a: Record<string, number>; b: Record<string, number> }>) => {
  const { id, kind, a, b } = e.data;
  self.postMessage({ id, diff: loudness(kind, b) - loudness(kind, a) });
};
