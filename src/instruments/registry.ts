/**
 * Instrument registry: one table entry per track type. Adding a type means one entry
 * here (plus a class if it needs new DSP).
 */
import type { Instrument, Preset } from './Instrument';
import type { InstrumentKind, SoundKind } from '../engine/project';
import type { ParamSpec } from '../engine/params';
import { macroSound } from './macros';
import {
  Drum, HAT_ELEMENTS, HAT_PARAMS, HAT_PRESETS, HAT_VOICE, KICK_ELEMENTS, KICK_PARAMS, KICK_PRESETS, KICK_VOICE,
  PERC_ELEMENTS, PERC_PARAMS, PERC_PRESETS, PERC_VOICE, SNARE_ELEMENTS, SNARE_PARAMS, SNARE_PRESETS, SNARE_VOICE,
} from './Drum';
import {
  BASS_FIXED, BASS_PARAMS, BASS_PRESETS, LEAD_FIXED, LEAD_PARAMS, LEAD_PRESETS, PLUCK_FIXED, PLUCK_PARAMS, PLUCK_PRESETS,
  PAD_FIXED, PAD_PARAMS, PAD_PRESETS, Synth,
} from './Synth';
import { DRIVE_RISE } from './driveComp';

/** Knob slots per page: 2 rows of 8 modules. */
export const PAGE_SLOTS = 16;
const ROW = PAGE_SLOTS / 2;

/**
 * The SOUND page, the same frame on every track: the sound first, then DRIVE / CRUSH, then
 * the performance pair.
 * PAD / LEAD: 1 TIMBRE / INT, 2 OSC 1 ATTACK / RELEASE, 3 OSC 2 ATTACK / RELEASE, 4 CUTOFF /
 * RESO, 5 FILTER ATTACK / DECAY, 6 FLT ENV / FM LVL, 7 DRIVE / CRUSH, 8 `perform` (LEAD
 * SLIDE / DETUNE, PAD CHORD / DETUNE). BASS and PLUCK have their own pages (below).
 */
export function soundPage(elements: readonly string[], perform: readonly [string, string]): string[] {
  const [a1, d1, a2, d2] = elements;
  return [
    'timbre', a1, a2, 'cutoff', 'fattack', 'fenv', 'drive', perform[0],
    'intensity', d1, d2, 'reso', 'fdecay', 'fm', 'crush', perform[1],
  ];
}

/**
 * Drums: 1 TIMBRE / INT, 2 element 1 ATTACK / DECAY, 3 element 2 ATTACK / DECAY, 4 the
 * elements' pitch (`pitch`), 5 and 6 their character (`five`, `six`: sweep, click or metal
 * colour), 7 DRIVE / CRUSH, 8 ROLL DIV / BALANCE (element 1 <-> 2). Elements: KICK body +
 * click, SNARE body + metal (wires), HAT click + metal, PERC body + click (+ metal halfway
 * between them). No filter per drum (FX 1's FILTER is the kit's).
 */
export function drumPage(elements: readonly string[], pitch: readonly [string, string], five: readonly [string, string], six: readonly [string, string]): string[] {
  const [a1, d1, a2, d2] = elements;
  return [
    'timbre', a1, a2, pitch[0], five[0], six[0], 'drive', 'rolldiv',
    'intensity', d1, d2, pitch[1], five[1], six[1], 'crush', 'balance',
  ];
}

/**
 * BASS (one envelope, envelope filter, sidechain): 1 TIMBRE / INT, 2 ATTACK / DECAY (amp +
 * filter), 3 SUSTAIN / RELEASE, 4 CUTOFF / RESO, 5 DUCK / DUCK REL, 6 FLT ENV / FM LVL,
 * 7 DRIVE / CRUSH, 8 SLIDE / SUB.
 */
const BASS_PAGE = [
  'timbre', 'attack', 'sustain', 'cutoff', 'duck', 'fenv', 'drive', 'glide',
  'intensity', 'decay', 'release', 'reso', 'duckrel', 'fm', 'crush', 'sub',
];
/**
 * PLUCK (one envelope, onboard delay + room): 1 TIMBRE / INT, 2 ATTACK / SUSTAIN (a pluck
 * that rings on, up to a held pad), 3 DLY TIME / DLY FDBK, 4 CUTOFF / RESO, 5 FLT ATK / DEC,
 * 6 FLT ENV / FM LVL, 7 DRIVE / CRUSH, 8 CHORD / DETUNE.
 */
const PLUCK_PAGE = [
  'timbre', 'attack', 'dtime', 'cutoff', 'fattack', 'fenv', 'drive', 'track:chord',
  'intensity', 'sustain', 'dfdbk', 'reso', 'fdecay', 'fm', 'crush', 'detune',
];

/** A 2 x 6 layout on the 2 x 8 panel: modules 1-6, modules 7-8 empty. */
export function widen<T>(six: readonly (T | null)[]): (T | null)[] {
  if (six.length === PAGE_SLOTS) return [...six];
  const out: (T | null)[] = new Array(PAGE_SLOTS).fill(null);
  six.forEach((x, i) => { out[i < 6 ? i : i - 6 + ROW] = x; });
  return out;
}

/**
 * The FUNC layer of a SOUND page (FUNC held): top row, then bottom row, 8 each; null = no
 * FUNC parameter on that knob (it does nothing while FUNC is held).
 */
export function funcPage(top: readonly (string | null)[], bottom: readonly (string | null)[]): (string | null)[] {
  return [...top, ...bottom];
}
const _ = null;
/*
 * FUNC layers. Synths: element columns SUSTAIN / RELEASE (each oscillator its own), column
 * 8 under the performance pair (DETUNE or UNISON; PLUCK ARP / ARP RATE, column 7 ARP OCT);
 * CHORD column 1 FEEDBACK, column 4 CARRIERS; PLUCK column 4 UNISON. SHAPE is TIMBRE's.
 * OCTAVE has no knob: OCT - / + in DESIGN (App.stepOctave). Drums: no FUNC layer yet.
 */
const NO_FUNC = funcPage([_, _, _, _, _, _, _, _], [_, _, _, _, _, _, _, _]);
/** BASS FUNC: DETUNE under column 8. */
const BASS_FUNC = funcPage([_, _, _, _, _, _, _, _], [_, _, _, _, _, _, _, 'detune']);
/** PLUCK FUNC: DECAY / RELEASE, DLY MIX / VERB, UNISON, ARP OCT, ARP / ARP RATE. */
const PLUCK_FUNC = funcPage([_, 'decay', 'dmix', 'unison', _, _, _, 'arp'], [_, 'release', 'verb', _, _, _, 'arpoct', 'arprate']);
/**
 * PAD / LEAD FUNC layer: each oscillator's DECAY / SUSTAIN on the element columns (their
 * ATTACK / RELEASE are on the page), the rest as given (columns 1, 4, 7, 8).
 */
function decSus(top: readonly (string | null)[], bottom: readonly (string | null)[]): (string | null)[] {
  return funcPage(
    [top[0], 'decay', 'decay2', top[1], _, _, top[2], top[3]],
    [bottom[0], 'sustain', 'sustain2', bottom[1], _, _, bottom[2], bottom[3]],
  );
}
/**
 * PAD / LEAD: held notes (high SUSTAIN), so RELEASE shapes what is heard: each oscillator's
 * ATTACK / RELEASE on modules 2-3.
 */
const HELD_ELEMENTS = ['attack', 'release', 'attack2', 'release2'];

/**
 * Every track's FUNC layer also holds the track's setup (the same slots on every type):
 * PRESET (module 1 top), MID FREQ (4 bottom: the MID CUT's centre), LIVE 1 / 2 (5) and
 * LIVE 3 / 4 (6) - what the live knobs control.
 */
export const TRACK_FUNC: Readonly<Record<number, string>> = {
  0: 'track:preset', [ROW + 3]: 'midfreq', 4: 'track:live1', [ROW + 4]: 'track:live2', 5: 'track:live3', [ROW + 5]: 'track:live4',
};
function trackFunc(func: readonly (string | null)[]): (string | null)[] {
  const out = [...func];
  for (const [slot, id] of Object.entries(TRACK_FUNC)) {
    if (out[Number(slot)] !== null) throw new Error(`FUNC slot ${slot} is taken by ${out[Number(slot)]}`);
    out[Number(slot)] = id;
  }
  return out;
}

/** How far a relative live knob reaches at full turn: this share of each parameter's range. */
export const LIVE_RANGE = 0.6;
/**
 * The relative knobs' gentle log taper: halfway to either end gives 40 % of the push
 * (|x|^LIVE_TAPER, 0.5^LIVE_TAPER = 0.4), so the area around the centre is finer.
 */
export const LIVE_TAPER = Math.log(0.4) / Math.log(0.5);

/**
 * LIVE knobs (the top layer: live > SOUND page > TIMBRE / INTENSITY) only push SOUND page
 * parameters (main or FUNC layer). They are relative: centred (0) they leave the sound as set on the SOUND page;
 * turned they push parameters up / down by up to LIVE_RANGE of their knob range (on each
 * parameter's own curve, with a gentle taper), clamped at its limits. A macro moves several at once.
 * CUTOFF and RESO (and the mixer, LFO) stay absolute.
 */
export interface LiveTarget {
  id: string;
  /** Share of the push (negative = moves the other way). */
  amount: number;
  /** Only the top quarter of the knob moves it (e.g. CRUSH on GRIT). */
  top?: boolean;
}

export interface LiveMacro {
  /** "macro:<name>" */
  id: string;
  name: string;
  targets: readonly LiveTarget[];
}

const macro = (name: string, targets: [string, number, boolean?][]): LiveMacro => ({
  id: `macro:${name.toLowerCase()}`, name, targets: targets.map(([id, amount, top]) => ({ id, amount, top })),
});
const LENGTH_SYNTH: [string, number][] = [['decay', 1], ['decay2', 1], ['release', 1], ['release2', 1]];

/** Drum ATTACK / GRIT: every drum has them (its two elements' attacks; DRIVE, CRUSH on top). */
const drumAttack = (a1: string, a2: string) => macro('ATTACK', [[a1, 1], [a2, 1]]);
const GRIT = macro('GRIT', [['drive', 1], ['crush', 1, true]]);

export const LIVE_MACROS: Record<SoundKind, readonly LiveMacro[]> = {
  kick: [
    drumAttack('t_attack', 'c_attack'),
    macro('DECAY', [['t_decay', 1], ['c_len', 0.5]]),
    GRIT,
    // BALANCE right = the click.
    macro('PUNCH', [['t_sweep', 1], ['balance', 1], ['drive', 1]]),
    macro('TUNE', [['t_pitch', 1]]),
  ],
  snare: [
    // BALANCE right = the wires.
    macro('SNAP', [['balance', 1], ['m_tone', 1]]),
    macro('DECAY', [['t_decay', 1], ['m_decay', 1]]),
    drumAttack('t_attack', 'm_attack'),
    GRIT,
    macro('TUNE', [['t_pitch', 1], ['m_pitch', 1]]),
  ],
  hat: [
    macro('BRIGHT', [['m_tone', 1], ['c_tone', 1], ['m_noise', 1]]),
    macro('DECAY', [['m_decay', 1], ['c_len', 0.5]]),
    drumAttack('c_attack', 'm_attack'),
    GRIT,
  ],
  perc: [
    // BALANCE right = click + metal.
    macro('KNOCK', [['balance', 1], ['c_noise', 1]]),
    macro('DECAY', [['t_decay', 1], ['c_len', 0.5]]),
    drumAttack('t_attack', 'c_attack'),
    GRIT,
  ],
  // The envelope filter: ENV opens it further and lengthens the envelope driving it.
  bass: [macro('ENV', [['fenv', 1], ['decay', 0.5]]), GRIT],
  pad: [
    macro('LENGTH', LENGTH_SYNTH),
    macro('SWELL', [['attack', 1], ['attack2', 1], ['release', 1], ['release2', 1]]),
    macro('WIDTH', [['detune', 1], ['unison', 1]]),
  ],
  lead: [
    macro('GRIT', [['drive', 1], ['fm', 1], ['crush', 1, true]]),
    macro('LENGTH', LENGTH_SYNTH),
  ],
  pluck: [
    macro('LENGTH', [['decay', 1], ['release', 1], ['fdecay', 1]]),
    macro('BITE', [['fenv', 1], ['drive', 1], ['fm', 1]]),
    // The onboard delay + room: left dries it up, right drowns it.
    macro('SPACE', [['dmix', 1], ['verb', 1]]),
    // Right: each note fades in, rings on and holds (up to a pad; the filter stays open with
    // it); left: tighter. RELEASE stays as set, so notes never smear into each other.
    macro('SUSTAIN', [['attack', 1], ['decay', 1], ['sustain', 1], ['fdecay', 1]]),
  ],
};

/** Live knob ids that stay absolute: the main filter (and the mixer / LFO ids). */
const ABSOLUTE_LIVE = new Set(['cutoff', 'reso', 'track:chord', 'track:notes']);

/**
 * What a relative live knob moves on this type: a macro's targets, a single (non-coarse)
 * sound parameter, or nothing (absolute ids, unknown ids).
 */
export function liveTargets(kind: InstrumentKind, id: string): readonly LiveTarget[] {
  if (kind === 'none' || ABSOLUTE_LIVE.has(id) || id.includes(':') && !id.startsWith('macro:')) return [];
  if (id.startsWith('macro:')) return LIVE_MACROS[kind].find((m) => m.id === id)?.targets ?? [];
  const spec = INSTRUMENTS[kind].params.find((p) => p.id === id);
  return spec && !spec.coarse ? [{ id, amount: 1 }] : [];
}

/** How far a relative live knob at `offset` (-1..1) pushes one target (normalised units). */
export function liveContribution(t: LiveTarget, offset: number): number {
  if (t.top) return offset > 0.5 ? Math.pow((offset - 0.5) * 2, LIVE_TAPER) * LIVE_RANGE * t.amount : 0;
  const shaped = Math.pow(Math.abs(offset), LIVE_TAPER) * LIVE_RANGE * t.amount;
  return offset < 0 ? -shaped : shaped;
}

/** CHORD / LEAD / PLUCK output trim (-14 dB). */
export const SYNTH_TRIM = 0.2;
/** Per type balance on top of it (so their defaults sit together). */
const CHORD_GAIN = SYNTH_TRIM * 1.1;
const LEAD_GAIN = SYNTH_TRIM * 0.88;
const PLUCK_GAIN = SYNTH_TRIM * 1.1;

export interface InstrumentEntry {
  name: string;
  /** All of the type's parameters (stored, set by presets, lockable). */
  params: readonly ParamSpec[];
  /** The SOUND page: 16 knob slots (2 rows of 8): the type's params ("track:chord" = the chord). */
  layout: readonly (string | null)[];
  /** The SOUND page's FUNC layer (16 slots, see funcPage). */
  funcLayout: readonly (string | null)[];
  /**
   * Default live knobs in RECORD / PLAY: two sound controls (synths: CUTOFF first), and with
   * FUNC held two more (param ids or "mix:volume|pan|send").
   */
  live: readonly [string, string];
  liveFunc: readonly [string, string];
  /**
   * Output trim of the type (applied with the track volume): the sustained synths (CHORD,
   * LEAD, PLUCK) sit -14 dB so they don't swamp the drums; full VOLUME = the old 20 %.
   */
  gain?: number;
  presets: readonly Preset[];
  /** Drum voices use the step strip when recording; pitched types get a keyboard. */
  drum: boolean;
  /** A drum played from the keyboard in step entry (each step has its own pitch). */
  pitched?: boolean;
  /** Lowest note on the keyboard (an A, so the strip starts on A). */
  baseNote: number;
  create: (sampleRate: number) => Instrument;
}

export const INSTRUMENTS: Record<SoundKind, InstrumentEntry> = {
  kick: {
    name: 'KICK', live: ['macro:attack', 'macro:decay'], liveFunc: ['mix:volume', 'macro:grit'], params: KICK_PARAMS,
    layout: drumPage(KICK_ELEMENTS, ['t_pitch', 'c_tone'], ['t_sweep', 't_stime'], ['c_reso', 'c_noise']),
    funcLayout: trackFunc(NO_FUNC),
    presets: KICK_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, KICK_PARAMS, KICK_VOICE) },
  snare: {
    name: 'SNARE', live: ['macro:snap', 'macro:decay'], liveFunc: ['mix:volume', 'macro:grit'], params: SNARE_PARAMS,
    layout: drumPage(SNARE_ELEMENTS, ['t_pitch', 'm_pitch'], ['t_sweep', 't_stime'], ['m_tone', 'm_noise']),
    funcLayout: trackFunc(NO_FUNC),
    presets: SNARE_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, SNARE_PARAMS, SNARE_VOICE) },
  hat: {
    name: 'HAT', live: ['macro:bright', 'macro:decay'], liveFunc: ['mix:volume', 'macro:grit'], params: HAT_PARAMS,
    layout: drumPage(HAT_ELEMENTS, ['c_tone', 'm_pitch'], ['c_reso', 'c_noise'], ['m_tone', 'm_noise']),
    funcLayout: trackFunc(NO_FUNC),
    presets: HAT_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, HAT_PARAMS, HAT_VOICE) },
  perc: {
    name: 'PERC', live: ['macro:knock', 'macro:decay'], liveFunc: ['mix:volume', 'macro:grit'], params: PERC_PARAMS,
    layout: drumPage(PERC_ELEMENTS, ['detune', 'm_interval'], ['t_sweep', 't_stime'], ['c_tone', 'c_noise']),
    funcLayout: trackFunc(NO_FUNC),
    presets: PERC_PRESETS, drum: true, pitched: true, baseNote: 33, create: (sr) => new Drum(sr, PERC_PARAMS, PERC_VOICE) },
  bass: {
    name: 'BASS', live: ['cutoff', 'macro:env'], liveFunc: ['mix:volume', 'macro:grit'], params: BASS_PARAMS,
    layout: BASS_PAGE,
    funcLayout: trackFunc(BASS_FUNC),
    presets: BASS_PRESETS, drum: false, baseNote: 33, create: (sr) => new Synth(sr, BASS_PARAMS, BASS_FIXED, DRIVE_RISE.bass) },
  pad: {
    name: 'PAD', gain: CHORD_GAIN, live: ['cutoff', 'macro:length'], liveFunc: ['mix:volume', 'macro:width'], params: PAD_PARAMS,
    layout: soundPage(HELD_ELEMENTS, ['track:chord', 'detune']),
    funcLayout: trackFunc(decSus([_, 'carriers', _, _], ['feedback', _, _, 'unison'])),
    presets: PAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PAD_PARAMS, PAD_FIXED, DRIVE_RISE.pad) },
  lead: {
    name: 'LEAD', gain: LEAD_GAIN, live: ['cutoff', 'macro:grit'], liveFunc: ['mix:volume', 'macro:length'], params: LEAD_PARAMS,
    layout: soundPage(HELD_ELEMENTS, ['glide', 'detune']),
    funcLayout: trackFunc(decSus([_, _, _, _], [_, _, _, _])),
    presets: LEAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, LEAD_PARAMS, LEAD_FIXED, DRIVE_RISE.lead) },
  pluck: {
    name: 'PLUCK', gain: PLUCK_GAIN, live: ['cutoff', 'track:notes'], liveFunc: ['macro:sustain', 'macro:space'], params: PLUCK_PARAMS,
    layout: PLUCK_PAGE,
    funcLayout: trackFunc(PLUCK_FUNC),
    presets: PLUCK_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PLUCK_PARAMS, PLUCK_FIXED, DRIVE_RISE.pluck) },
};

export const SOUND_KINDS = Object.keys(INSTRUMENTS) as SoundKind[];

/** The parameters with a knob on a type's SOUND page (main or FUNC layer). */
export function pageParams(kind: SoundKind): ReadonlySet<string> {
  const e = INSTRUMENTS[kind];
  return new Set([...e.layout, ...e.funcLayout].filter((id): id is string => !!id));
}

export function instrumentParams(kind: InstrumentKind): readonly ParamSpec[] {
  return kind === 'none' ? [] : INSTRUMENTS[kind].params;
}

export function isDrum(kind: InstrumentKind): boolean {
  return kind === 'none' || INSTRUMENTS[kind].drum;
}

/** Steps are tapped on the strip in step entry (drums), not entered from the keyboard. */
export function stepsOnStrip(kind: InstrumentKind): boolean {
  return kind === 'none' || (INSTRUMENTS[kind].drum && !INSTRUMENTS[kind].pitched);
}

export function paramSpec(kind: InstrumentKind, id: string): ParamSpec | undefined {
  return instrumentParams(kind).find((p) => p.id === id);
}

/**
 * Full sound for a preset: defaults, then (when the preset names a TIMBRE position) the
 * sound TIMBRE / INTENSITY produce there, then the preset's own values.
 */
/**
 * Sounds saved before each synth oscillator had its own SUSTAIN / RELEASE: OSC 2 takes
 * OSC 1's (as it did then). In place.
 */
export function mirrorOsc2(values: Record<string, number>): void {
  if (values.sustain !== undefined && values.sustain2 === undefined) values.sustain2 = values.sustain;
  if (values.release !== undefined && values.release2 === undefined) values.release2 = values.release;
}

export function presetSound(kind: SoundKind, index: number): Record<string, number> {
  const sound: Record<string, number> = {};
  const params = INSTRUMENTS[kind].params;
  for (const p of params) sound[p.id] = p.defaultValue;
  const values = INSTRUMENTS[kind].presets[index].values;
  const macro = values.timbre !== undefined ? macroSound(kind, values.timbre, values.intensity ?? 0.5, params) : {};
  return { ...sound, ...macro, ...values };
}
