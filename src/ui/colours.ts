/**
 * The look (MENU > GLOBAL SETTINGS, kept on the device): THEME, SATURATION and INVERT.
 *  - COLOUR: each track type has its own colour (panel and screen); white is every track's
 *    second colour (cursor, playhead, accents, held knobs, values away from saved). Knobs of no
 *    track (LFO, project, TEMPO / MASTER, MENU) are neutral grey; FX 1-3's knob modules come
 *    in pairs, two track colours alternating per bus. The screen is neutral grey.
 *  - CLASSIC (first and default): everything teal, gold as the second colour, a teal screen.
 *    REVERSE: gold, teal second. MONO: grey, white second.
 *  - SATURATION: LOW / MEDIUM / HIGH. COLOUR's list is MEDIUM; CLASSIC / REVERSE's teal and
 *    gold are HIGH (the first look). The levels scale each colour's HSL saturation.
 *  - INVERT: every hue turned half way round the colour wheel (not MONO).
 */
import type { InstrumentKind } from '../engine/project';
import { INK } from './screen';
import { deviceSettings } from '../storage/settings';

/** COLOUR's track colours at MEDIUM (the colour tuner of test builds changes them live). */
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

/** FX 1 / 2: the two colours their knob modules alternate in (modules 1-2, 5-6 / 3-4, 7-8). */
const FX_PAIRS: [InstrumentKind, InstrumentKind][] = [['kick', 'perc'], ['snare', 'bass']];

export const THEMES = ['CLASSIC', 'COLOUR', 'MONO', 'REVERSE'] as const;
export const SATURATIONS = ['LOW', 'MEDIUM', 'HIGH'] as const;
/** Saturation against MEDIUM, per level. */
const SAT_SCALE = [0.5, 1, 2.1];
const HIGH = 2;

const TEAL = '#3cc8b4';
const GOLD = '#e8b53a';
const GREY = '#a9b3bd';
const WHITE = '#f4f7fa';
const SCREEN_BG = '#0b0e10';
const GREY_SCREEN = { bg: SCREEN_BG, dim: '#2b3238', mid: '#8d98a3', hi: '#e9eef2', warn: '#ffffff', shade: '#161b1f' };

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hex = (c: Rgb) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

/** A colour with its saturation scaled and its hue turned (degrees), lightness kept. */
function shift(colour: string, satScale: number, turn: number): string {
  if (satScale === 1 && turn === 0) return colour;
  const [r, g, b] = rgb(colour).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  s = Math.min(1, s * satScale);
  h = (h + turn) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return hex([f(0), f(8), f(4)]);
}

let theme: (typeof THEMES)[number] = 'CLASSIC';
let sat = HIGH;
let turn = 0;

/** A colour designed at saturation level `base`, in the current SATURATION and INVERT. */
const tone = (colour: string, base: number) => shift(colour, SAT_SCALE[sat] / SAT_SCALE[base], turn);

/** The one colour of CLASSIC / REVERSE / MONO. */
function primary(): string {
  return theme === 'MONO' ? GREY : tone(theme === 'REVERSE' ? GOLD : TEAL, HIGH);
}

/** Every track's second colour. */
function second(): string {
  return theme === 'CLASSIC' ? tone(GOLD, HIGH) : theme === 'REVERSE' ? tone(TEAL, HIGH) : WHITE;
}

/** THEME / SATURATION / INVERT choices (indexes, as in deviceSettings). */
export interface Look {
  theme: number;
  saturation: number;
  invert: number;
}

/**
 * Set the look (as saved, or one being picked in MENU): screen inks, second colour, screen
 * frame. The panel's own colours follow on its next refresh.
 */
export function applyTheme(look: Look = deviceSettings): void {
  theme = THEMES[look.theme] ?? 'CLASSIC';
  sat = look.saturation;
  turn = look.invert && theme !== 'MONO' ? 180 : 0;
  if (theme === 'COLOUR') Object.assign(INK, GREY_SCREEN);
  else {
    // A screen of the one colour (CLASSIC's teal screen at HIGH).
    const p = primary();
    const dark = (t: number) => mix('#000000', p, t);
    Object.assign(INK, { bg: dark(0.095), dim: dark(0.37), mid: dark(0.83), hi: mix(p, '#ffffff', 0.55), warn: second(), shade: dark(0.18) });
  }
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--hot', second());
  root.style.setProperty('--screen-bg', INK.bg);
  root.classList.toggle('theme-single', theme !== 'COLOUR');
}

/** A track type's colour in this look. */
export function trackColour(kind: InstrumentKind): string {
  return theme === 'COLOUR' ? tone(TRACK_COLOURS[kind], 1) : primary();
}

/** Knobs of no track. */
export function neutralColour(): string {
  return theme === 'COLOUR' ? GREY : primary();
}

/** FX bus n (1-2), knob module m (0-7): its pair's colour. */
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

const inks = new Map<string, Ink>();

/** The screen shades of a colour (cached); one-colour themes: the screen's own. */
export function inkOf(colour: string): Ink {
  if (theme !== 'COLOUR') return INK;
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
