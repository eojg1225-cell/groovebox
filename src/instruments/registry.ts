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
const PAGE_SLOTS = 16;
const ROW = PAGE_SLOTS / 2;

/**
 * The SOUND page, the same frame on every track: the sound first, then DRIVE / CRUSH, then
 * the performance pair. Synths follow the sound chain: TIMBRE / INT, the amp envelope, FM
 * (FM ATK / FM DEC, FM LVL / RESO), the filter (FLT ATK / FLT DEC, FLT ENV / CUTOFF), DRIVE /
 * CRUSH, then module 8: BASS SLIDE / SUB, LEAD SLIDE / DETUNE, PAD CHORD / DETUNE, PLUCK its
 * delay (DLY TIME / DLY FDBK). `amp` = module 2 (BASS ATTACK / DECAY, PAD and LEAD ATTACK /
 * RELEASE of both oscillators, PLUCK ATTACK / SUSTAIN).
 */
export function synthPage(amp: readonly [string, string], perform: readonly [string, string]): string[] {
  return [
    'timbre', amp[0], 'fmattack', 'fm', 'fattack', 'fenv', 'drive', perform[0],
    'intensity', amp[1], 'fmdecay', 'reso', 'fdecay', 'cutoff', 'crush', perform[1],
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
 * The FUNC layer of a SOUND page (FUNC held): top row, then bottom row, 8 each; null = no
 * FUNC parameter on that knob (it does nothing while FUNC is held).
 */
function funcPage(top: readonly (string | null)[], bottom: readonly (string | null)[]): (string | null)[] {
  return [...top, ...bottom];
}
const _ = null;
/*
 * FUNC layers. Synths: the rest of the amp envelope under module 2, then what each type
 * needs (below). SHAPE and FM RATIO are TIMBRE's. OCTAVE has no knob: OCT - / + in DESIGN
 * (App.stepOctave). Drums: no FUNC layer yet.
 */
const NO_FUNC = funcPage([_, _, _, _, _, _, _, _], [_, _, _, _, _, _, _, _]);
/** BASS FUNC: SUSTAIN / RELEASE under ATTACK / DECAY, DUCK / DUCK REL (sidechain) under DRIVE / CRUSH, DETUNE under 8. */
const BASS_FUNC = funcPage([_, 'sustain', _, _, _, _, 'duck', _], [_, 'release', _, _, _, _, 'duckrel', 'detune']);
/** PLUCK FUNC: DECAY / RELEASE, SLIDE (3), UNISON, CHORD / DETUNE (7), DLY MIX / VERB under the delay (8). */
const PLUCK_FUNC = funcPage([_, 'decay', 'glide', 'unison', _, _, 'track:chord', 'dmix'], [_, 'release', _, _, _, _, 'detune', 'verb']);

/**
 * PAD / LEAD FUNC layer: DECAY / SUSTAIN (both oscillators) under module 2, OSC 2's own
 * ATTACK / RELEASE on module 3, the rest as given (columns 1, 4, 7, 8).
 */
function heldFunc(top: readonly (string | null)[], bottom: readonly (string | null)[]): (string | null)[] {
  return funcPage(
    [top[0], 'decay', 'attack2', top[1], _, _, top[2], top[3]],
    [bottom[0], 'sustain', 'release2', bottom[1], _, _, bottom[2], bottom[3]],
  );
}

/**
 * PAD / LEAD: module 2's ATTACK / RELEASE (and FUNC DECAY / SUSTAIN) move both oscillators;
 * OSC 2's own ATTACK / RELEASE (FUNC module 3) set it apart afterwards. FM LVL likewise sets
 * the second stack's FM LVL2 (FUNC module 4).
 */
const BOTH_OSCS: Readonly<Record<string, readonly string[]>> = {
  attack: ['attack2'], decay: ['decay2'], sustain: ['sustain2'], release: ['release2'], fm: ['fm2'],
};
const LINKED: Partial<Record<SoundKind, Readonly<Record<string, readonly string[]>>>> = { pad: BOTH_OSCS, lead: BOTH_OSCS };

/** Parameters a SOUND page knob on `id` sets along with it (none = just itself). */
export function linkedParams(kind: InstrumentKind, id: string): readonly string[] {
  return kind === 'none' ? [] : LINKED[kind]?.[id] ?? [];
}

/**
 * Every track's FUNC layer also holds the track's setup (the same slots on every type):
 * PRESET (module 1 top), MID FREQ (4 bottom: the MID CUT's centre), LIVE 1 / 2 (5) and
 * LIVE 3 / 4 (6) - what the live knobs control.
 */
const TRACK_FUNC: Readonly<Record<number, string>> = {
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
const LIVE_RANGE = 0.6;
/**
 * The relative knobs' gentle log taper: halfway to either end gives 40 % of the push
 * (|x|^LIVE_TAPER, 0.5^LIVE_TAPER = 0.4), so the area around the centre is finer.
 */
const LIVE_TAPER = Math.log(0.4) / Math.log(0.5);

/**
 * LIVE knobs (the top layer: live > SOUND page > TIMBRE / INTENSITY) only push SOUND page
 * parameters (main or FUNC layer). They are relative: centred (0) they leave the sound as set on the SOUND page;
 * turned they push parameters up / down by up to LIVE_RANGE of their knob range (on each
 * parameter's own curve, with a gentle taper), clamped at its limits. A macro moves several at once.
 * CUTOFF and RESO (and the mixer, LFO) stay absolute.
 */
interface LiveTarget {
  id: string;
  /** Share of the push (negative = moves the other way). */
  amount: number;
  /** Only the top quarter of the knob moves it (e.g. CRUSH on GRIT). */
  top?: boolean;
}

interface LiveMacro {
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
  // ENV opens the filter envelope further and lengthens its decay.
  bass: [macro('ENV', [['fenv', 1], ['fdecay', 0.5]]), GRIT],
  pad: [
    macro('LENGTH', LENGTH_SYNTH),
    macro('SWELL', [['attack', 1], ['attack2', 1], ['release', 1], ['release2', 1]]),
    macro('WIDTH', [['detune', 1], ['unison', 1]]),
  ],
  lead: [
    macro('GRIT', [['drive', 1], ['fm', 1], ['fm2', 1], ['crush', 1, true]]),
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
  // A knob that sets others along with it (PAD / LEAD ATTACK, FM LVL ...) pushes them too.
  return spec && !spec.coarse ? [id, ...linkedParams(kind, id)].map((t) => ({ id: t, amount: 1 })) : [];
}

/** How far a relative live knob at `offset` (-1..1) pushes one target (normalised units). */
export function liveContribution(t: LiveTarget, offset: number): number {
  if (t.top) return offset > 0.5 ? Math.pow((offset - 0.5) * 2, LIVE_TAPER) * LIVE_RANGE * t.amount : 0;
  const shaped = Math.pow(Math.abs(offset), LIVE_TAPER) * LIVE_RANGE * t.amount;
  return offset < 0 ? -shaped : shaped;
}

interface InstrumentEntry {
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
   * Output trim of the type (applied with the track volume): with each sound's OUT GAIN
   * ('ogain', set by TIMBRE), every sound plays equally loud at the track's default VOLUME
   * (one hit / a half-second note, max momentary K-weighted loudness).
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
    name: 'KICK', gain: 0.565, live: ['macro:attack', 'macro:decay'], liveFunc: ['mix:volume', 'macro:grit'], params: KICK_PARAMS,
    layout: drumPage(KICK_ELEMENTS, ['t_pitch', 'c_tone'], ['t_sweep', 't_stime'], ['c_reso', 'c_noise']),
    funcLayout: trackFunc(NO_FUNC),
    presets: KICK_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, KICK_PARAMS, KICK_VOICE) },
  snare: {
    name: 'SNARE', gain: 0.797, live: ['macro:snap', 'macro:decay'], liveFunc: ['mix:volume', 'macro:grit'], params: SNARE_PARAMS,
    layout: drumPage(SNARE_ELEMENTS, ['t_pitch', 'm_pitch'], ['t_sweep', 't_stime'], ['m_tone', 'm_noise']),
    funcLayout: trackFunc(NO_FUNC),
    presets: SNARE_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, SNARE_PARAMS, SNARE_VOICE) },
  hat: {
    name: 'HAT', gain: 4.359, live: ['macro:bright', 'macro:decay'], liveFunc: ['mix:volume', 'macro:grit'], params: HAT_PARAMS,
    layout: drumPage(HAT_ELEMENTS, ['c_tone', 'm_pitch'], ['c_reso', 'c_noise'], ['m_tone', 'm_noise']),
    funcLayout: trackFunc(NO_FUNC),
    presets: HAT_PRESETS, drum: true, baseNote: 33, create: (sr) => new Drum(sr, HAT_PARAMS, HAT_VOICE) },
  perc: {
    name: 'PERC', gain: 0.778, live: ['macro:knock', 'macro:decay'], liveFunc: ['mix:volume', 'macro:grit'], params: PERC_PARAMS,
    layout: drumPage(PERC_ELEMENTS, ['detune', 'm_interval'], ['t_sweep', 't_stime'], ['c_tone', 'c_noise']),
    funcLayout: trackFunc(NO_FUNC),
    presets: PERC_PRESETS, drum: true, pitched: true, baseNote: 33, create: (sr) => new Drum(sr, PERC_PARAMS, PERC_VOICE) },
  bass: {
    name: 'BASS', gain: 0.383, live: ['cutoff', 'macro:env'], liveFunc: ['mix:volume', 'macro:grit'], params: BASS_PARAMS,
    layout: synthPage(['attack', 'decay'], ['glide', 'sub']),
    funcLayout: trackFunc(BASS_FUNC),
    presets: BASS_PRESETS, drum: false, baseNote: 33, create: (sr) => new Synth(sr, BASS_PARAMS, BASS_FIXED, DRIVE_RISE.bass) },
  pad: {
    name: 'PAD', gain: 0.273, live: ['cutoff', 'macro:length'], liveFunc: ['mix:volume', 'macro:width'], params: PAD_PARAMS,
    layout: synthPage(['attack', 'release'], ['track:chord', 'detune']).map((id) => (id === 'crush' ? null : id)), // no CRUSH on the PAD
    funcLayout: trackFunc(heldFunc([_, 'fm2', _, 'glide'], ['feedback', _, _, 'unison'])),
    presets: PAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PAD_PARAMS, PAD_FIXED, DRIVE_RISE.pad) },
  lead: {
    name: 'LEAD', gain: 0.633, live: ['cutoff', 'macro:grit'], liveFunc: ['mix:volume', 'macro:length'], params: LEAD_PARAMS,
    layout: synthPage(['attack', 'release'], ['glide', 'detune']),
    funcLayout: trackFunc(heldFunc([_, 'fm2', _, _], [_, _, _, _])),
    presets: LEAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, LEAD_PARAMS, LEAD_FIXED, DRIVE_RISE.lead) },
  pluck: {
    name: 'PLUCK', gain: 1.366, live: ['cutoff', 'track:notes'], liveFunc: ['macro:sustain', 'macro:space'], params: PLUCK_PARAMS,
    layout: synthPage(['attack', 'sustain'], ['dtime', 'dfdbk']),
    funcLayout: trackFunc(PLUCK_FUNC),
    presets: PLUCK_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PLUCK_PARAMS, PLUCK_FIXED, DRIVE_RISE.pluck) },
};

export const SOUND_KINDS = Object.keys(INSTRUMENTS) as SoundKind[];

/** The parameters with a knob on a type's SOUND page (main or FUNC layer). */
export function pageParams(kind: SoundKind): ReadonlySet<string> {
  const e = INSTRUMENTS[kind];
  return new Set([...e.layout, ...e.funcLayout].filter((id): id is string => !!id));
}

function instrumentParams(kind: InstrumentKind): readonly ParamSpec[] {
  return kind === 'none' ? [] : INSTRUMENTS[kind].params;
}

export function isDrum(kind: InstrumentKind): boolean {
  return kind === 'none' || INSTRUMENTS[kind].drum;
}

/**
 * Polyphonic tracks (PAD, PLUCK): up to STEP_NOTES notes per step, each with its own length,
 * entered and recorded as chords. The others play one note at a time.
 */
export function playsChords(kind: InstrumentKind): boolean {
  return kind === 'pad' || kind === 'pluck';
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
export function presetSound(kind: SoundKind, index: number): Record<string, number> {
  const sound: Record<string, number> = {};
  const params = INSTRUMENTS[kind].params;
  for (const p of params) sound[p.id] = p.defaultValue;
  const values = INSTRUMENTS[kind].presets[index].values;
  const macro = values.timbre !== undefined ? macroSound(kind, values.timbre, values.intensity ?? 0.5, params) : {};
  return { ...sound, ...macro, ...values };
}
