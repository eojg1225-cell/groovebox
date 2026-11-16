/**
 * Instrument registry: one table entry per track type. Adding a type means one entry
 * here (and its sound in the Rust engine, native/src/instruments, if it needs new DSP).
 */
import type { Preset } from './macroParams';
import type { InstrumentKind, SoundKind } from '../engine/project';
import type { ParamSpec } from '../engine/params';
import { macroSound } from './macros';
import {
  DRUM_ROOT, HAT_ELEMENTS, HAT_PARAMS, HAT_PRESETS, KICK_ELEMENTS, KICK_PARAMS, KICK_PRESETS,
  PERC_ELEMENTS, PERC_PARAMS, PERC_PRESETS, SNARE_ELEMENTS, SNARE_PARAMS, SNARE_PRESETS,
} from './drumSpecs';
import {
  BASS_PARAMS, BASS_PRESETS, LEAD_PARAMS, LEAD_PRESETS, PLUCK_PARAMS, PLUCK_PRESETS, PAD_PARAMS, PAD_PRESETS,
} from './synthSpecs';


/**
 * The SOUND page (2026-11 rework): the main layer is the sound itself, the ALT layer the rest of
 * each type's design, then its effects. On every type: main 1 TIMBRE / INT, main 8 top SLIDE
 * (synths) / ROLL RATE (drums); ALT 1 PRESET / ACC/GHOST, ALT 5 / 6 LIVE 1-4 (beside the filter,
 * which has no ALT knobs), ALT 7 DRIVE / the type's own effect, ALT 8 CRUSH. MID FREQ / MID CUT
 * are on MIX > ALT. Knob groups (lit grooves, boxes on the screen) come from `soundGroups`.
 *
 * Synths: 1 TIMBRE / INT, 2 the amp envelope (`amp`), 3 FM ATK / FM DEC (PAD / PLUCK: CHORD /
 * NOTES, `three`), 4 FM LVL / FLT RES, 5 FLT ATK / FLT DEC, 6 FLT ENV / CUTOFF, 7 UNISON /
 * DETUNE, 8 SLIDE / the type's own (`eight`: BASS SUB, LEAD BEND, PAD / PLUCK none).
 */
function synthPage(amp: readonly [string, string], three: readonly [string, string], eight: readonly [string, string | null]): (string | null)[] {
  return [
    'timbre', amp[0], three[0], 'fm', 'fattack', 'fenv', 'unison', eight[0],
    'intensity', amp[1], three[1], 'reso', 'fdecay', 'cutoff', 'detune', eight[1],
  ];
}

/**
 * Drums: 1 TIMBRE / INT, 2 element 1 ATTACK / DECAY, 3 element 2 ATTACK / DECAY, 4 the
 * elements' pitch (`pitch`), 5 their character (`five`), 6 AIR LVL / AIR TAIL (`six`; PERC its
 * room to come), 7 the rest of the drum's design (`seven`: KICK SWEEP / SWP TIME, SNARE its
 * STICK, HAT its click, PERC CLK PITCH / CLK NOISE), 8 ROLL RATE / BALANCE (element 1 <-> 2).
 * Elements: KICK body + click, SNARE body + metal (wires), HAT click + metal, PERC body + click
 * (+ metal halfway between them). No filter per drum (FX 1's FILTER is the kit's).
 */
function drumPage(elements: readonly string[], pitch: readonly [string, string], five: readonly [string, string], six: readonly [string | null, string | null], seven: readonly [string, string]): (string | null)[] {
  const [a1, d1, a2, d2] = elements;
  return [
    'timbre', a1, a2, pitch[0], five[0], six[0], seven[0], 'rolldiv',
    'intensity', d1, d2, pitch[1], five[1], six[1], seven[1], 'balance',
  ];
}

const _ = null;
/**
 * An ALT (FUNC) layer: each type's own knobs on modules 2-4 (`two`, `three`, `four`: top /
 * bottom) and ALT 7 bottom (`own`, its effect: BASS none, LEAD BEND TIME, PAD LOW CUT, PLUCK DLY
 * MIX); the same knobs on every type everywhere else (PRESET / ACC/GHOST, LIVE 1-4, DRIVE, CRUSH).
 */
function altPage(two: readonly (string | null)[], three: readonly (string | null)[], four: readonly (string | null)[], own: string | null = null): (string | null)[] {
  return [
    'track:preset', two[0], three[0], four[0], 'track:live1', 'track:live3', 'drive', 'crush',
    'mix:dyn', two[1], three[1], four[1], 'track:live2', 'track:live4', own, null,
  ];
}
const NONE = [_, _] as const;
/** SNARE ALT: SWEEP / SWP TIME (2). */
const SNARE_FUNC = altPage(['t_sweep', 't_stime'], NONE, NONE);
/** HAT ALT: FOCUS (4 top). */
const HAT_FUNC = altPage(NONE, NONE, ['h_focus', _]);
const DRUM_FUNC = altPage(NONE, NONE, NONE);
/** BASS ALT: SUSTAIN / RELEASE (2), DUCK / DUCK REL (3, the sidechain), FM RATIO (4 top). */
const BASS_FUNC = altPage(['sustain', 'release'], ['duck', 'duckrel'], ['fmpair', _]);
/** LEAD ALT: SUSTAIN / RELEASE (2), VIBRATO / VIB RATE (3), FM RATIO / VIB DELAY (4), BEND TIME (7 bottom). */
const LEAD_FUNC = altPage(['sustain', 'release'], ['vibrato', 'vibrate'], ['fmpair', 'vibdelay'], 'bendtime');
/** PLUCK ALT: DECAY / RELEASE (2), DLY TIME / DLY FDBK (3), FM ATK / FM DEC (4), DLY MIX (7 bottom). */
const PLUCK_FUNC = altPage(['decay', 'release'], ['dtime', 'dfdbk'], ['fmattack', 'fmdecay'], 'dmix');
/** PAD ALT: DECAY / SUSTAIN (2, both oscillators), OSC 2's own ATTACK / RELEASE (3), FM ATK / FM DEC (4), LOW CUT (7 bottom). */
const PAD_FUNC = altPage(['decay', 'sustain'], ['attack2', 'release2'], ['fmattack', 'fmdecay'], 'lowcut');
/** PAD and PLUCK: CHORD / NOTES on module 3 (their FM envelope on ALT 4), SLIDE on 8. */
const CHORD_THREE = ['track:chord', 'track:notes'] as const;

/**
 * Knob groups on a SOUND page (main layer / ALT): each a run of whole modules (1-based, first
 * and last), drawn as lit grooves on the panel and boxes on the screen.
 */
export interface KnobGroup { from: number; to: number }
const SYNTH_GROUPS: readonly KnobGroup[] = [{ from: 1, to: 1 }, { from: 2, to: 3 }, { from: 4, to: 6 }, { from: 7, to: 8 }];
const CHORD_GROUPS: readonly KnobGroup[] = [{ from: 1, to: 1 }, { from: 2, to: 2 }, { from: 3, to: 3 }, { from: 4, to: 6 }, { from: 7, to: 8 }];
const DRUM_GROUPS: readonly KnobGroup[] = [{ from: 1, to: 1 }, { from: 2, to: 5 }, { from: 6, to: 6 }, { from: 7, to: 8 }];
const ALT_GROUPS: readonly KnobGroup[] = [{ from: 1, to: 1 }, { from: 2, to: 4 }, { from: 5, to: 6 }, { from: 7, to: 8 }];
/**
 * A SOUND page's knob groups. Synths: TIMBRE / INT | the envelopes (amp + FM; PAD / PLUCK: the
 * amp envelope | CHORD / NOTES) | the filter (FM LVL / FLT RES with it) | UNISON / DETUNE + SLIDE.
 * Drums: TIMBRE / INT | the elements | AIR | the rest + ROLL. ALT: PRESET / ACC | the type's own
 * | LIVE 1-4 | the effects.
 */
export function soundGroups(kind: SoundKind, alt: boolean): readonly KnobGroup[] {
  if (alt) return ALT_GROUPS;
  if (INSTRUMENTS[kind].drum) return DRUM_GROUPS;
  return kind === 'pad' || kind === 'pluck' ? CHORD_GROUPS : SYNTH_GROUPS;
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
  /** The SOUND page: 16 knob slots (2 rows of 8): the type's params ("track:chord" / "track:notes" = the chord; null = no knob). */
  layout: readonly (string | null)[];
  /** The SOUND page's FUNC (ALT) layer (16 slots, see altPage). */
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
}

export const INSTRUMENTS: Record<SoundKind, InstrumentEntry> = {
  kick: {
    name: 'KICK', gain: 0.565, live: ['intensity', 'macro:decay'], liveFunc: ['mix:volume', 'air'], params: KICK_PARAMS,
    // TIMBRE / INT set the sweep (SWEEP / SWP TIME fine-tune it on 7): the click's character on 5.
    layout: drumPage(KICK_ELEMENTS, ['t_pitch', 'c_tone'], ['c_reso', 'c_noise'], ['air', 'airsize'], ['t_sweep', 't_stime']),
    funcLayout: DRUM_FUNC,
    presets: KICK_PRESETS, drum: true, baseNote: DRUM_ROOT },
  snare: {
    name: 'SNARE', gain: 0.467, live: ['fx1:s2_vol', 'intensity'], liveFunc: ['mix:volume', 'air'], params: SNARE_PARAMS,
    // The wires' character on 5, its STICK (CLK LEVEL / CLK PITCH) on 7, SWEEP / SWP TIME on ALT 2.
    layout: drumPage(SNARE_ELEMENTS, ['t_pitch', 'm_pitch'], ['m_tone', 'm_noise'], ['air', 'airsize'], ['c_level', 'c_tone']),
    funcLayout: SNARE_FUNC,
    presets: SNARE_PRESETS, drum: true, baseNote: DRUM_ROOT },
  hat: {
    name: 'HAT', gain: 1.783, live: ['fx1:s3_vol', 'macro:attack'], liveFunc: ['mix:volume', 'air'], params: HAT_PARAMS,
    // The metal's character on 5, AIR (its natural room, v81) on 6, the click's on 7.
    layout: drumPage(HAT_ELEMENTS, ['c_tone', 'm_pitch'], ['m_tone', 'm_noise'], ['air', 'hairsize'], ['c_reso', 'c_noise']),
    funcLayout: HAT_FUNC,
    presets: HAT_PRESETS, drum: true, baseNote: DRUM_ROOT },
  perc: {
    name: 'PERC', gain: 0.537, live: ['fx1:flt', 'intensity'], liveFunc: ['mix:volume', 'macro:grit'], params: PERC_PARAMS,
    // 6 waits for its AIR.
    layout: drumPage(PERC_ELEMENTS, ['detune', 'm_interval'], ['t_sweep', 't_stime'], [_, _], ['c_tone', 'c_noise']),
    funcLayout: DRUM_FUNC,
    presets: PERC_PRESETS, drum: true, pitched: true, baseNote: DRUM_ROOT },
  bass: {
    name: 'BASS', gain: 0.557, live: ['fx2:s1_vol', 'cutoff'], liveFunc: ['mix:volume', 'macro:env'], params: BASS_PARAMS,
    layout: synthPage(['attack', 'decay'], ['fmattack', 'fmdecay'], ['glide', 'sub']),
    funcLayout: BASS_FUNC,
    presets: BASS_PRESETS, drum: false, baseNote: 33 },
  pad: {
    name: 'PAD', gain: 0.413, live: ['fx2:s2_vol', 'cutoff'], liveFunc: ['mix:volume', 'macro:length'], params: PAD_PARAMS,
    layout: synthPage(['attack', 'release'], CHORD_THREE, ['glide', _]),
    funcLayout: PAD_FUNC,
    presets: PAD_PRESETS, drum: false, baseNote: 45 },
  lead: {
    name: 'LEAD', gain: 0.948, live: ['fx2:s3_vol', 'cutoff'], liveFunc: ['mix:volume', 'macro:grit'], params: LEAD_PARAMS,
    layout: synthPage(['attack', 'decay'], ['fmattack', 'fmdecay'], ['glide', 'bend']),
    funcLayout: LEAD_FUNC,
    presets: LEAD_PRESETS, drum: false, baseNote: 45 },
  pluck: {
    name: 'PLUCK', gain: 1.105, live: ['fx2:s4_vol', 'cutoff'], liveFunc: ['mix:volume', 'macro:sustain'], params: PLUCK_PARAMS,
    // Module 2 ATTACK / SUSTAIN (a pluck's own envelope; DECAY / RELEASE on ALT).
    layout: synthPage(['attack', 'sustain'], CHORD_THREE, ['glide', _]),
    funcLayout: PLUCK_FUNC,
    presets: PLUCK_PRESETS, drum: false, baseNote: 45 },
};

export const SOUND_KINDS = Object.keys(INSTRUMENTS) as SoundKind[];

/** The parameters with a knob on a type's SOUND page (main or FUNC layer), and those a knob sets along with it. */
export function pageParams(kind: SoundKind): ReadonlySet<string> {
  const e = INSTRUMENTS[kind];
  // MID FREQ (MIX > ALT) is part of the sound too.
  const ids = [...e.layout, ...e.funcLayout, 'midfreq'].filter((id): id is string => !!id);
  // A knob's followers (PAD FM LVL2, OSC 2 DECAY / SUSTAIN) keep their edits too: without them a
  // reload put them back to TIMBRE's while their knob kept its own.
  return new Set([...ids, ...ids.flatMap((id) => linkedParams(kind, id))]);
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
