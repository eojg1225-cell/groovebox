/**
 * The two FX buses (pure data: shared by the engine, the UI and the save file).
 *
 * Every track is on one bus (`ChannelState.bus`) and has a level into each of its four slots
 * (`fxLevels`), so it can feed one effect without the others. A slot is two knob modules:
 *  FX 1  the drum processor: COMP (slot 1: RATIO / THRESH, ATTACK / RELEASE; in parallel: a
 *        track's level is its MIX, that much of it through the compressor, the rest straight
 *        out), two free effects (slots 2-3), FILTER (slot 4: FILTER / RESO, ENV / ENV REL;
 *        one set of knobs, a filter of its own on every track, before everything else; the
 *        track's level is its MIX).
 *  FX 2  the synths' multi FX: four free effects. Their returns pass a built-in TONE (LOW
 *        CUT 200 Hz / HI CUT 16 kHz, DUCK under what the tracks send): no knobs; a project
 *        keeps the values it was saved with (`tone_...`).
 * A free slot: VOLUME (its return level; labelled with the effect) over TYPE, then the two
 * controls of whatever it holds. TYPE picks from the whole bank (`FX_BANK`: DIST, MOD, DELAY
 * and VERB types in one list), so a bus can hold four choruses; the controls are stored as
 * knob positions (0-1) and read in the loaded effect's own scale (`FX_FAMILIES`: MOD RATE /
 * DEPTH, DELAY RATE (tempo-synced) / FDBK, VERB SIZE / LENGTH, DIST DRIVE / TONE), so a TYPE of
 * another family leaves the knobs where they are and gives them its own meaning (the UI puts
 * them on that family's defaults).
 * FILTER: one knob, low-pass left of the centre, high-pass right, off in the middle
 * (djCutoff); RESO; ENV (the track's level lifts (+) or lowers (-) its cutoff on every hit,
 * up to 8 octaves) / ENV REL (how fast that falls back).
 */
import { choice, toNorm, toValue, type ParamSpec } from '../engine/params';

/**
 * FX 1's COMP (the engine's: native/src/fx/compressor.rs): THRESH and RATIO set how hard
 * levels above the threshold are held down, ATTACK / RELEASE how fast it grabs and lets go;
 * automatic make-up; RATIO 1:1 = off.
 */
const COMP_PARAMS: readonly ParamSpec[] = [
  { id: 'cmp_thresh', name: 'THRESH', min: -60, max: 0, defaultValue: -18, unit: 'DB', curve: 'linear', decimals: 0 },
  { id: 'cmp_ratio', name: 'RATIO', min: 1, max: 20, defaultValue: 1, unit: ':1', curve: 'exp', decimals: 1 },
  { id: 'cmp_attack', name: 'CMP ATK', min: 0.0001, max: 0.1, defaultValue: 0.005, unit: 'S', curve: 'exp', decimals: 4 },
  { id: 'cmp_release', name: 'CMP REL', min: 0.01, max: 2, defaultValue: 0.15, unit: 'S', curve: 'exp', decimals: 3 },
];

export const NUM_BUSES = 2;

/** GLITCH's note values, in 16th steps: STUTTER's slice and hold, TAPE STOP's time and how often. */
const STUTTER_SLICES = [{ name: '1/64', steps: 0.25 }, { name: '1/32', steps: 0.5 }, { name: '1/16', steps: 1 }, { name: '1/8', steps: 2 }, { name: '1/4', steps: 4 }] as const;
const STUTTER_HOLDS = [{ name: '1/8', steps: 2 }, { name: '1/4', steps: 4 }, { name: '1/2', steps: 8 }, { name: '1 BAR', steps: 16 }] as const;
const TAPE_STOP_TIMES = [{ name: '1/16', steps: 1 }, { name: '1/8', steps: 2 }, { name: '1/4', steps: 4 }, { name: '1/2', steps: 8 }, { name: '1 BAR', steps: 16 }] as const;
const TAPE_STOP_EVERY = [{ name: '1/2 BAR', steps: 8 }, { name: '1 BAR', steps: 16 }, { name: '2 BARS', steps: 32 }, { name: '4 BARS', steps: 64 }] as const;

/** Tempo-synced delay times, in 16th steps. */
export const FX_DELAY_TIMES = [
  { name: '1/32', steps: 0.5 }, { name: '1/16T', steps: 2 / 3 }, { name: '1/16', steps: 1 }, { name: '1/8T', steps: 4 / 3 },
  { name: '1/8', steps: 2 }, { name: '3/16', steps: 3 }, { name: '1/4T', steps: 8 / 3 }, { name: '1/4', steps: 4 },
  { name: '3/8', steps: 6 }, { name: '1/2', steps: 8 }, { name: '3/4', steps: 12 }, { name: '1 BAR', steps: 16 },
] as const;

const linear = (id: string, name: string, min: number, max: number, defaultValue: number, unit = '', decimals?: number): ParamSpec =>
  ({ id, name, min, max, defaultValue, unit, curve: 'linear', ...(decimals !== undefined ? { decimals } : {}) });
const exp = (id: string, name: string, min: number, max: number, defaultValue: number, unit: string, decimals?: number): ParamSpec =>
  ({ id, name, min, max, defaultValue, unit, curve: 'exp', ...(decimals !== undefined ? { decimals } : {}) });

/**
 * The effect families a free slot can hold: the name on its VOLUME knob and its two
 * controls (ids = the engine unit's own, native/src/fx/units.rs).
 */
export const FX_FAMILIES: readonly { name: string; a: ParamSpec; b: ParamSpec }[] = [
  { name: 'DIST', a: linear('drv_drive', 'DRIVE', 0, 1, 0.4), b: exp('drv_tone', 'TONE', 300, 16000, 5000, 'HZ', 0) },
  { name: 'MOD', a: exp('mod_rate', 'RATE', 0.05, 10, 0.5, 'HZ', 2), b: linear('mod_depth', 'DEPTH', 0, 1, 0.5) },
  { name: 'DELAY', a: choice('dly_rate', 'RATE', FX_DELAY_TIMES.map((d) => d.name), 4), b: linear('dly_fdbk', 'FDBK', 0, 1.1, 0.4) },
  { name: 'VERB', a: linear('vrb_size', 'SIZE', 0, 1, 0.5), b: linear('vrb_len', 'LENGTH', 0, 1, 0.5) },
  // GLITCH (v97): STUTTER's controls (TAPE STOP has its own); runs on the slot's delay unit.
  { name: 'GLITCH', a: choice('gl_slice', 'SLICE', STUTTER_SLICES.map((d) => d.name), 2), b: choice('gl_hold', 'HOLD', STUTTER_HOLDS.map((d) => d.name), 1) },
];
const [DIST, MOD, DELAY, VERB, GLITCH] = [0, 1, 2, 3, 4];

/** An effect a free slot can load: the engine's mode name, its family, and its own two controls where they are not the family's. */
interface FxType { name: string; family: number; a?: ParamSpec; b?: ParamSpec }
/**
 * The bank a free slot's TYPE picks from (the engine's mode names), family by family. Stored
 * by index: a new type in the middle needs a load migration (`typeV97`).
 */
export const FX_BANK: readonly FxType[] = [
  ...['TUBE', 'FUZZ', 'BIT', 'FOLD'].map((name) => ({ name, family: DIST })),
  ...['CHORUS', 'FLANGER', 'PHASER'].map((name) => ({ name, family: MOD })),
  // RING MOD: the input times a sine carrier at FREQ; SPREAD detunes the right side's carrier (up to +50 %).
  { name: 'RING', family: MOD, a: exp('rm_freq', 'FREQ', 20, 2000, 220, 'HZ', 0), b: linear('rm_spread', 'SPREAD', 0, 1, 0.2) },
  ...['TAPE', 'SWEEP', 'REVERSE', 'PING-PONG', 'DUB TAPE', 'SLAPBACK'].map((name) => ({ name, family: DELAY })),
  ...['ROOM', 'PLATE', 'SPRING', 'HALL'].map((name) => ({ name, family: VERB })),
  { name: 'STUTTER', family: GLITCH },
  { name: 'TAPE STOP', family: GLITCH, a: choice('gl_time', 'TIME', TAPE_STOP_TIMES.map((d) => d.name), 2), b: choice('gl_every', 'EVERY', TAPE_STOP_EVERY.map((d) => d.name), 1) },
];

/** A bank entry's two controls: its own, else its family's. */
export function typeSpec(type: number, which: 'a' | 'b'): ParamSpec {
  const t = FX_BANK[Math.min(FX_BANK.length - 1, Math.max(0, Math.round(type)))];
  return t[which] ?? FX_FAMILIES[t.family][which];
}
/** A bank entry's index by name. */
export const fxType = (name: string): number => Math.max(0, FX_BANK.findIndex((t) => t.name === name));

type SlotDef =
  | { kind: 'comp' | 'filter' }
  /** A free slot `n` (its ids `s<n>_vol` ...): what it holds to start with (control values in real units). */
  | { kind: 'free'; n: number; type: string; vol: number; a?: number; b?: number };

interface BusDef {
  name: string;
  slots: readonly SlotDef[];
  /** FX 2's built-in TONE (no knobs): its settings. */
  tone?: Readonly<Record<string, number>>;
}

export const BUSES: readonly BusDef[] = [
  {
    name: 'FX 1', slots: [
      { kind: 'comp' },
      { kind: 'free', n: 2, type: 'FLANGER', vol: 0, a: 0.3 },
      { kind: 'free', n: 3, type: 'TAPE', vol: 0, b: 0.35 },
      { kind: 'filter' },
    ],
  },
  {
    name: 'FX 2', slots: [
      { kind: 'free', n: 1, type: 'TUBE', vol: 0 },
      { kind: 'free', n: 2, type: 'PING-PONG', vol: 0.35, a: 5 },
      { kind: 'free', n: 3, type: 'PLATE', vol: 0.25 },
      { kind: 'free', n: 4, type: 'CHORUS', vol: 0 },
    ],
    tone: { tone_low: 200, tone_high: 16000, tone_duck: 0.4, tone_rel: 0.3 },
  },
];

/**
 * The order a bus's slots are shown in (stored slot indices, 0-based): FX 1 in its routing
 * order, FILTER (each track's own, first), COMP, then the two free slots (MOD, DELAY to start);
 * FX 2 as stored. Storage keeps COMP as slot 1 and FILTER as slot 4 (`lvl1` = COMP MIX, `lvl4` =
 * FLT MIX), so saves and the engine are untouched; only the panel, screen and live knobs follow this.
 */
export const SLOT_ORDER: readonly (readonly number[])[] = [[3, 0, 1, 2], [0, 1, 2, 3]];

const COMP = Object.fromEntries(COMP_PARAMS.map((p) => [p.id, p]));

/** A control's default knob position for a family (`which`: 'a' / 'b'), or of a real value. */
export function controlNorm(family: number, which: 'a' | 'b', value?: number): number {
  const spec = FX_FAMILIES[family][which];
  return toNorm(spec, value ?? spec.defaultValue);
}

/** The same for a bank entry (its own controls where it has them). */
export function typeNorm(type: number, which: 'a' | 'b', value?: number): number {
  const spec = typeSpec(type, which);
  return toNorm(spec, value ?? spec.defaultValue);
}

/**
 * A slot's four knobs in panel order: module 1 top, module 1 bottom, module 2 top, module 2
 * bottom (a free slot: VOLUME, TYPE, then its two controls as knob positions).
 */
function slotSpecs(u: SlotDef): ParamSpec[] {
  switch (u.kind) {
    case 'comp': return [
      { ...COMP.cmp_ratio, name: 'RATIO' }, { ...COMP.cmp_thresh, name: 'THRESH' },
      { ...COMP.cmp_attack, name: 'ATTACK' }, { ...COMP.cmp_release, name: 'RELEASE' },
    ];
    case 'filter': return [
      { ...linear('flt', 'FILTER', 0, 1, 0.5), display: 'dj' }, linear('flt_reso', 'FLT RES', 0, 1, 0),
      linear('flt_env', 'ENV', -1, 1, 0), exp('flt_rel', 'ENV REL', 0.005, 2, 0.15, 'S', 3),
    ];
    case 'free': {
      const t = fxType(u.type);
      return [
        linear(`s${u.n}_vol`, 'FX', 0, 1, u.vol),
        choice(`s${u.n}_type`, 'TYPE', FX_BANK.map((b) => b.name), t),
        linear(`s${u.n}_a`, 'A', 0, 1, typeNorm(t, 'a', u.a)),
        linear(`s${u.n}_b`, 'B', 0, 1, typeNorm(t, 'b', u.b)),
      ];
    }
  }
}

/** FX 2's TONE: stored and sent with the bus, on no knob. */
const TONE_PARAMS: readonly ParamSpec[] = [
  exp('tone_low', 'LOW CUT', 20, 1000, 20, 'HZ', 0), exp('tone_high', 'HI CUT', 1000, 20000, 20000, 'HZ', 0),
  linear('tone_duck', 'DUCK', 0, 1, 0), exp('tone_rel', 'DUCK REL', 0.03, 2, 0.25, 'S', 2),
];

/** Each bus's parameters, by id (as stored and sent: a free slot's controls as knob positions). */
export const BUS_PARAMS: readonly (readonly ParamSpec[])[] = BUSES.map((b) => [
  ...b.slots.flatMap(slotSpecs),
  ...(b.tone ? TONE_PARAMS.map((s) => ({ ...s, defaultValue: b.tone![s.id] ?? s.defaultValue })) : []),
]);

/** Each bus's 16 knobs (top row, then bottom row): slot u on modules 2u + 1 and 2u + 2. */
export const BUS_LAYOUT: readonly (readonly string[])[] = BUSES.map((b, k) => {
  const top: string[] = [];
  const bottom: string[] = [];
  for (const u of SLOT_ORDER[k].map((i) => b.slots[i])) {
    const [m1t, m1b, m2t, m2b] = slotSpecs(u).map((s) => s.id);
    top.push(m1t, m2t);
    bottom.push(m1b, m2b);
  }
  return [...top, ...bottom];
});

export function busParam(bus: number, id: string): ParamSpec | undefined {
  return BUS_PARAMS[bus]?.find((p) => p.id === id);
}

/** A free slot's knob id: its slot number and which knob (null: not one). */
function slotKnob(id: string): { n: number; knob: 'vol' | 'type' | 'a' | 'b' } | null {
  const m = /^s(\d)_(vol|type|a|b)$/.exec(id);
  return m ? { n: Number(m[1]), knob: m[2] as 'vol' | 'type' | 'a' | 'b' } : null;
}

/** The bank entry a bus's free slot `n` holds now (`values`: the bus's settings). */
export function slotType(bus: number, n: number, values: Readonly<Record<string, number>>): number {
  const t = Math.round(values[`s${n}_type`] ?? busParam(bus, `s${n}_type`)?.defaultValue ?? 0);
  return Math.min(FX_BANK.length - 1, Math.max(0, t));
}

/** The family of the effect a bus's free slot `n` holds now. */
export function slotFamily(bus: number, n: number, values: Readonly<Record<string, number>>): number {
  return FX_BANK[slotType(bus, n, values)].family;
}

/**
 * A bus knob as the panel shows it with the bus's settings as they are: a free slot's
 * VOLUME carries its effect's name, its controls are the loaded effect's own (`control`:
 * the stored value is a knob position, shown and set through this spec, `controlValue` /
 * `controlStored`); every other knob is as stored.
 */
export function busKnob(bus: number, id: string, values: Readonly<Record<string, number>>): { spec: ParamSpec; control: boolean } | undefined {
  const spec = busParam(bus, id);
  if (!spec) return undefined;
  const k = slotKnob(id);
  if (!k || k.knob === 'type') return { spec, control: false };
  const family = FX_FAMILIES[slotFamily(bus, k.n, values)];
  // A GLITCH slot is an insert: its VOLUME is MIX (dry / effected, for what the tracks put through it).
  if (k.knob === 'vol') return { spec: { ...spec, name: family.name === 'GLITCH' ? 'MIX' : family.name }, control: false };
  // The loaded effect's own spec (else its family's) under the slot's id.
  return { spec: { ...typeSpec(slotType(bus, k.n, values), k.knob), id }, control: true };
}
/** A free slot's control: its stored knob position as the value the panel shows, and back. */
export const controlValue = (spec: ParamSpec, stored: number): number => toValue(spec, stored);
export const controlStored = (spec: ParamSpec, value: number): number => toNorm(spec, value);

/**
 * The name of slot `slot` (0-3) of a bus as the track's level knob shows it: COMP MIX,
 * FILTER MIX, or the loaded effect's family, numbered where the bus holds it more than once
 * (DELAY 1, DELAY 2).
 */
export function slotName(bus: number, slot: number, values: Readonly<Record<string, number>>): string {
  // Named in the order the slots are shown (two of a family numbered left to right).
  const order = SLOT_ORDER[bus];
  const names = order.map((i) => BUSES[bus].slots[i]).map((u) => (u.kind === 'free' ? FX_FAMILIES[slotFamily(bus, u.n, values)].name : u.kind === 'comp' ? 'COMP MIX' : 'FLT MIX'));
  const at = order.indexOf(slot);
  const name = names[at] ?? '';
  if (names.filter((x) => x === name).length < 2) return name;
  return `${name} ${names.slice(0, at + 1).filter((x) => x === name).length}`;
}

/**
 * What a live knob may take from the buses: each free slot's VOLUME and FX 1's FILTER, id
 * "fx<n>:<param>"; `fxLiveName` names it with what the slot holds ("FX1:DELAY").
 */
export const FX_LIVE: readonly { id: string; bus: number; param: string }[] = BUSES.flatMap((b, k) =>
  SLOT_ORDER[k].map((i) => b.slots[i]).filter((u) => u.kind !== 'comp').map((u) => {
    const param = u.kind === 'free' ? `s${u.n}_vol` : 'flt';
    return { id: `fx${k + 1}:${param}`, bus: k, param };
  }));
export function fxLiveName(fx: { bus: number; param: string }, values: Readonly<Record<string, number>>): string {
  return `FX${fx.bus + 1}:${busKnob(fx.bus, fx.param, values)?.spec.name ?? ''}`;
}

/** A bus's starting settings. */
export function defaultBus(bus: number): Record<string, number> {
  return Object.fromEntries(BUS_PARAMS[bus].map((p) => [p.id, p.defaultValue]));
}

export function defaultBuses(): Record<string, number>[] {
  return BUSES.map((_, k) => defaultBus(k));
}
