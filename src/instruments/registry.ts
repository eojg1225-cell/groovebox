/**
 * Instrument registry: one table entry per track type. Adding a type means one entry
 * here (plus a class if it needs new DSP).
 */
import type { Instrument, Preset } from './Instrument';
import type { InstrumentKind, SoundKind } from '../engine/project';
import type { ParamSpec } from '../engine/params';
import { macroSound } from './macros';
import {
  DRUM_ROOT, Drum, HAT_ELEMENTS, HAT_PARAMS, HAT_PRESETS, HAT_VOICE, KICK_ELEMENTS, KICK_PARAMS, KICK_PRESETS, KICK_VOICE,
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
 * colour; KICK 5 CLK RESO / CLK NOISE, SNARE 5 MTL TONE / MTL NOISE, both 6 AIR LVL / AIR TAIL),
 * 7 DRIVE / CRUSH, 8 ROLL DIV / BALANCE (element 1 <-> 2). Elements: KICK body + click, SNARE
 * body + metal (wires), HAT click + metal, PERC body + click (+ metal halfway between them).
 * No filter per drum (FX 1's FILTER is the kit's).
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
 * needs (below). SHAPE is TIMBRE's (FM RATIO too, but a FUNC knob on BASS / LEAD). OCTAVE has no knob: OCT - / + in DESIGN
 * (App.stepOctave). Drums: KICK / SNARE SWEEP / SWP TIME (FUNC 2); HAT FOCUS (FUNC 4 top, over
 * MTL PITCH's module); PERC none yet.
 */
const NO_FUNC = funcPage([_, _, _, _, _, _, _, _], [_, _, _, _, _, _, _, _]);
const HAT_FUNC = funcPage([_, _, _, 'h_focus', _, _, _, _], [_, _, _, _, _, _, _, _]);
/** KICK / SNARE FUNC: SWEEP / SWP TIME under the body's ATTACK / DECAY. */
const SWEEP_FUNC = funcPage([_, 't_sweep', _, _, _, _, _, _], [_, 't_stime', _, _, _, _, _, _]);
/** SNARE FUNC: SWEEP / SWP TIME (2), the stick's CLK LEVEL / CLK PITCH (3). */
const SNARE_FUNC = funcPage([_, 't_sweep', 'c_level', _, _, _, _, _], [_, 't_stime', 'c_tone', _, _, _, _, _]);
/** BASS FUNC: SUSTAIN / RELEASE under ATTACK / DECAY, DUCK / DUCK REL (sidechain) under DRIVE / CRUSH, DETUNE under 8. */
// FM RATIO over MID FREQ (4), UNISON / DETUNE (8): a reese is a SAW with both turned up.
const BASS_FUNC = funcPage([_, 'sustain', _, 'fmpair', _, _, 'duck', 'unison'], [_, 'release', _, _, _, _, 'duckrel', 'detune']);
/**
 * LEAD FUNC: SUSTAIN / RELEASE under ATTACK / DECAY, VIBRATO / VIB RATE (3), FM RATIO over MID
 * FREQ (4, as the BASS's), BEND / BEND TIME (7), VIB DELAY / UNISON (8).
 */
const LEAD_FUNC = funcPage([_, 'sustain', 'vibrato', 'fmpair', _, _, 'bend', 'vibdelay'], [_, 'release', 'vibrate', _, _, _, 'bendtime', 'unison']);
/** PLUCK FUNC: DECAY / RELEASE, SLIDE (3), UNISON, CHORD / DETUNE (7), DLY MIX / VERB under the delay (8). */
const PLUCK_FUNC = funcPage([_, 'decay', 'glide', 'unison', _, _, 'track:chord', 'dmix'], [_, 'release', _, _, _, _, 'detune', 'verb']);

/**
 * PAD FUNC layer: DECAY / SUSTAIN (both oscillators) under module 2, OSC 2's own
 * ATTACK / RELEASE on module 3, the rest as given (columns 1, 4, 7, 8).
 */
function heldFunc(top: readonly (string | null)[], bottom: readonly (string | null)[]): (string | null)[] {
  return funcPage(
    [top[0], 'decay', 'attack2', top[1], _, _, top[2], top[3]],
    [bottom[0], 'sustain', 'release2', bottom[1], _, _, bottom[2], bottom[3]],
  );
}

/**
 * PAD: module 2's ATTACK / RELEASE (and FUNC DECAY / SUSTAIN) move both oscillators;
 * OSC 2's own ATTACK / RELEASE (FUNC module 3) set it apart afterwards. FM LVL likewise sets
 * the second stack's FM LVL2 (FUNC module 4).
 */
const BOTH_OSCS: Readonly<Record<string, readonly string[]>> = {
  attack: ['attack2'], decay: ['decay2'], sustain: ['sustain2'], release: ['release2'], fm: ['fm2'],
};
const LINKED: Partial<Record<SoundKind, Readonly<Record<string, readonly string[]>>>> = { pad: BOTH_OSCS };

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

/**
 * LIVE knobs (the top layer: live > SOUND page > TIMBRE / INTENSITY). A macro knob moves several
 * SOUND page parameters (main or FUNC layer) at once, relative to the sound as set: it sits
 * where its parameters sit on average (`macroAnchor`; an ATTACK whose attacks are at their
 * shortest starts fully left), and turning it moves each by the same distance along its own
 * knob range (x its amount), clamped at its limits. Its stored offset is that distance (0 = the
 * sound as set). Every other live knob is absolute (the knob itself).
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
/** KICK / SNARE: the room, louder and bigger together. */
const AIR = macro('AIR', [['air', 1], ['airsize', 1]]);

export const LIVE_MACROS: Record<SoundKind, readonly LiveMacro[]> = {
  kick: [
    drumAttack('t_attack', 'c_attack'),
    macro('DECAY', [['t_decay', 1], ['c_len', 0.5]]),
    GRIT,
    AIR,
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
    AIR,
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
    macro('GRIT', [['drive', 1], ['fm', 1], ['crush', 1, true]]),
    macro('LENGTH', [['decay', 1], ['release', 1], ['fdecay', 1]]),
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

/**
 * What a relative live knob moves on this type: a macro's targets. Every other live knob (a
 * SOUND page knob such as INT or CUTOFF, the mixer, FX, LFO) is absolute: the knob itself,
 * showing and setting the same value as on the SOUND page.
 */
export function liveTargets(kind: InstrumentKind, id: string): readonly LiveTarget[] {
  if (kind === 'none' || !id.startsWith('macro:')) return [];
  return LIVE_MACROS[kind].find((m) => m.id === id)?.targets ?? [];
}

/**
 * How far a macro turned `offset` from its anchor (normalised, -1..1) pushes one target. A
 * `top` target (CRUSH on GRIT) only moves over the second half of the way from the anchor to
 * the right end, up to its whole range there.
 */
export function liveContribution(t: LiveTarget, offset: number, anchor: number): number {
  if (t.top) {
    const half = (1 - anchor) / 2;
    return half > 0 && offset > half ? ((offset - half) / half) * t.amount : 0;
  }
  return offset * t.amount;
}

/**
 * Where a macro knob sits with the sound as set: the average position (0..1) of its targets
 * (`norm` = a parameter's position on its knob; a negative amount counts from the top; the
 * `top` ones left out). A macro with nothing to average sits in the middle.
 */
export function macroAnchor(targets: readonly LiveTarget[], norm: (id: string) => number | undefined): number {
  let sum = 0;
  let n = 0;
  for (const t of targets) {
    if (t.top) continue;
    const v = norm(t.id);
    if (v === undefined) continue;
    sum += t.amount < 0 ? 1 - v : v;
    n++;
  }
  return n ? sum / n : 0.5;
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
   * Default live knobs in RECORD / PLAY: two controls (synths: CUTOFF first; KICK / SNARE /
   * HAT: FX 1's MOD / DELAY / FILTER first), and with FUNC held two more (param ids,
   * "mix:<id>", "fx<n>:<param>").
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
    name: 'KICK', gain: 0.565, live: ['intensity', 'macro:decay'], liveFunc: ['mix:volume', 'macro:air'], params: KICK_PARAMS,
    // TIMBRE / INT set the sweep (SWEEP / SWP TIME fine-tune it on FUNC 2): the click's
    // character on 5, AIR on 6 beside DRIVE / CRUSH.
    layout: drumPage(KICK_ELEMENTS, ['t_pitch', 'c_tone'], ['c_reso', 'c_noise'], ['air', 'airsize']),
    funcLayout: trackFunc(SWEEP_FUNC),
    presets: KICK_PRESETS, drum: true, baseNote: DRUM_ROOT, create: (sr) => new Drum(sr, KICK_PARAMS, KICK_VOICE) },
  snare: {
    name: 'SNARE', gain: 0.467, live: ['fx1:mod_vol', 'intensity'], liveFunc: ['mix:volume', 'macro:air'], params: SNARE_PARAMS,
    // As the KICK: the wires' character on 5, AIR on 6, SWEEP / SWP TIME on FUNC 2.
    layout: drumPage(SNARE_ELEMENTS, ['t_pitch', 'm_pitch'], ['m_tone', 'm_noise'], ['air', 'airsize']),
    funcLayout: trackFunc(SNARE_FUNC),
    presets: SNARE_PRESETS, drum: true, baseNote: DRUM_ROOT, create: (sr) => new Drum(sr, SNARE_PARAMS, SNARE_VOICE) },
  hat: {
    name: 'HAT', gain: 1.783, live: ['fx1:dly_vol', 'macro:attack'], liveFunc: ['mix:volume', 'macro:grit'], params: HAT_PARAMS,
    layout: drumPage(HAT_ELEMENTS, ['c_tone', 'm_pitch'], ['c_reso', 'c_noise'], ['m_tone', 'm_noise']),
    funcLayout: trackFunc(HAT_FUNC),
    presets: HAT_PRESETS, drum: true, baseNote: DRUM_ROOT, create: (sr) => new Drum(sr, HAT_PARAMS, HAT_VOICE) },
  perc: {
    name: 'PERC', gain: 0.537, live: ['fx1:flt', 'intensity'], liveFunc: ['mix:volume', 'macro:grit'], params: PERC_PARAMS,
    layout: drumPage(PERC_ELEMENTS, ['detune', 'm_interval'], ['t_sweep', 't_stime'], ['c_tone', 'c_noise']),
    funcLayout: trackFunc(NO_FUNC),
    presets: PERC_PRESETS, drum: true, pitched: true, baseNote: DRUM_ROOT, create: (sr) => new Drum(sr, PERC_PARAMS, PERC_VOICE) },
  bass: {
    name: 'BASS', gain: 0.557, live: ['cutoff', 'macro:env'], liveFunc: ['mix:volume', 'macro:grit'], params: BASS_PARAMS,
    layout: synthPage(['attack', 'decay'], ['glide', 'sub']),
    funcLayout: trackFunc(BASS_FUNC),
    presets: BASS_PRESETS, drum: false, baseNote: 33, create: (sr) => new Synth(sr, BASS_PARAMS, BASS_FIXED, DRIVE_RISE.bass) },
  pad: {
    name: 'PAD', gain: 0.413, live: ['cutoff', 'macro:length'], liveFunc: ['mix:volume', 'macro:width'], params: PAD_PARAMS,
    // No FM LVL on the PAD (INT sets it) and no CRUSH: DRIVE over RESO (4), DETUNE / UNISON (7).
    layout: synthPage(['attack', 'release'], ['track:chord', 'glide']).map((id) => (id === 'fm' ? 'drive' : id === 'drive' ? 'detune' : id === 'crush' ? 'unison' : id)),
    funcLayout: trackFunc(heldFunc([_, _, _, _], [_, _, _, _])),
    presets: PAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, PAD_PARAMS, PAD_FIXED, DRIVE_RISE.pad) },
  lead: {
    name: 'LEAD', gain: 0.948, live: ['cutoff', 'macro:grit'], liveFunc: ['mix:volume', 'macro:length'], params: LEAD_PARAMS,
    layout: synthPage(['attack', 'decay'], ['glide', 'detune']),
    funcLayout: trackFunc(LEAD_FUNC),
    presets: LEAD_PRESETS, drum: false, baseNote: 45, create: (sr) => new Synth(sr, LEAD_PARAMS, LEAD_FIXED, DRIVE_RISE.lead) },
  pluck: {
    name: 'PLUCK', gain: 1.105, live: ['cutoff', 'macro:space'], liveFunc: ['macro:sustain', 'track:notes'], params: PLUCK_PARAMS,
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
/** Every parameter of a type at its default (no preset: what the TIMBRE sounds are levelled on). */
export function defaultSound(kind: SoundKind): Record<string, number> {
  const sound: Record<string, number> = {};
  for (const p of INSTRUMENTS[kind].params) sound[p.id] = p.defaultValue;
  return sound;
}

export function presetSound(kind: SoundKind, index: number): Record<string, number> {
  const sound = defaultSound(kind);
  const params = INSTRUMENTS[kind].params;
  const values = INSTRUMENTS[kind].presets[index].values;
  const macro = values.timbre !== undefined ? macroSound(kind, values.timbre, values.intensity ?? 0.5, params) : {};
  return { ...sound, ...macro, ...values };
}
