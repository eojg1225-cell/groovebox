/**
 * Themes (MENU > GLOBAL SETTINGS > THEME, kept on the device):
 *  - TRACKS: each track type has its own colour (panel and screen); white is every track's
 *    second colour (cursor, playhead, accents, held knobs, values away from saved). Knobs of no
 *    track (LFO, project, TEMPO / MASTER, MENU) are neutral grey; the FX buses' knobs come in
 *    pairs of modules, two colours alternating per bus.
 *  - CLASSIC: the first look: everything teal, gold as the second colour, a teal screen.
 */
import type { InstrumentKind } from '../engine/project';
import { INK } from './screen';

/** The TRACKS theme's colours (the colour tuner of test builds changes them live). */
export const TRACK_COLOURS: Record<InstrumentKind, string> = {
  none: '#7d8893',
  kick: '#8b5b5b',
  snare: '#c78e5c',
  hat: '#c7c55c',
  perc: '#6aa471',
  bass: '#60a49a',
  pad: '#6b93c7',
  lead: '#8d7bad',
  pluck: '#d3b6c4',
};

/** FX 1-3: the two colours their knob modules alternate in (modules 1-2, 5-6 / 3-4, 7-8). */
const FX_PAIRS: [InstrumentKind, InstrumentKind][] = [['kick', 'perc'], ['snare', 'bass'], ['hat', 'pad']];

export const THEMES = ['TRACKS', 'CLASSIC'] as const;

const TEAL = '#3cc8b4';
const TRACKS_NEUTRAL = '#a9b3bd';
const SCREEN_BG = '#0b0e10';

const SCREENS = {
  tracks: { bg: SCREEN_BG, dim: '#2b3238', mid: '#8d98a3', hi: '#e9eef2', warn: '#ffffff', shade: '#161b1f' },
  classic: { bg: '#061312', dim: '#1a4842', mid: '#34a596', hi: '#a0f5ea', warn: '#e8b53a', shade: '#0f2422' },
};
const SECOND = { tracks: '#f4f7fa', classic: '#e8b53a' };

let classic = false;

/** Switch the look (index into THEMES): screen inks, the panel's second colour and screen frame. */
export function applyTheme(theme: number): void {
  classic = THEMES[theme] === 'CLASSIC';
  const key = classic ? 'classic' : 'tracks';
  Object.assign(INK, SCREENS[key]);
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--hot', SECOND[key]);
  root.style.setProperty('--screen-bg', SCREENS[key].bg);
  root.classList.toggle('theme-classic', classic);
}

/** A track type's colour in this theme. */
export function trackColour(kind: InstrumentKind): string {
  return classic ? TEAL : TRACK_COLOURS[kind];
}

/** Knobs of no track. */
export function neutralColour(): string {
  return classic ? TEAL : TRACKS_NEUTRAL;
}

/** FX bus n (1-3), knob module m (0-7): its pair's colour. */
export function fxColour(bus: number, module: number): string {
  const pair = FX_PAIRS[bus - 1];
  return pair ? trackColour(pair[(module >> 1) & 1]) : neutralColour();
}

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

/** The screen shades of a colour (cached); CLASSIC: the screen's own teal. */
export function inkOf(colour: string): Ink {
  if (classic) return INK;
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
