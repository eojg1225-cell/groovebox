/**
 * Track colours: each track type has its own colour (panel and screen); white is every
 * track's second colour (cursor, playhead, accents, held knobs, values away from saved).
 * Knobs that belong to no track (FX buses, LFO, project) are neutral grey.
 */
import type { InstrumentKind } from '../engine/project';

export const TRACK_COLOURS: Record<InstrumentKind, string> = {
  none: '#7d8893',
  kick: '#f04848',
  snare: '#f58a2c',
  hat: '#e8b53a',
  perc: '#4cc35a',
  bass: '#3f8ef2',
  pad: '#a070f4',
  lead: '#3cc8b4',
  pluck: '#f26aac',
};

/** Knobs of no track. */
export const NEUTRAL = '#a9b3bd';
/** Every track's second colour is white (`--hot` in style.css, `INK.warn` on the screen). */
const SCREEN_BG = '#0b0e10';

/** One colour's shades on the pixel screen. */
export interface Ink {
  dim: string;
  mid: string;
  hi: string;
  shade: string;
}

function mix(a: string, b: string, t: number): string {
  const ch = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  let out = '#';
  for (let i = 0; i < 3; i++) out += Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0');
  return out;
}

const inks = new Map<string, Ink>();

/** The screen shades of a colour (cached). */
export function inkOf(colour: string): Ink {
  let ink = inks.get(colour);
  if (!ink) {
    ink = { dim: mix(colour, SCREEN_BG, 0.68), mid: colour, hi: mix(colour, '#ffffff', 0.5), shade: mix(colour, SCREEN_BG, 0.86) };
    inks.set(colour, ink);
  }
  return ink;
}

/** A dark version of a colour for the panel (ghost steps, keyboard keys with notes). */
export function dimOf(colour: string): string {
  return mix(colour, '#1c2126', 0.6);
}
