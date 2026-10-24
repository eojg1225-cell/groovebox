/**
 * The three FX buses (pure data: shared by the engine, the UI and the save file).
 *
 * Every bus is four units of two knob modules each (no FUNC layer). An effect unit's first
 * module is VOLUME (its return level; labelled with the effect) over TYPE, its second the
 * two controls of that effect:
 *  FX 1  drums: COMP (in series on the drums: RATIO / THRESH, ATTACK / RELEASE), MOD
 *        (FLANGER, PHASER), DELAY (TAPE, SWEEP, REVERSE), FILTER (FILTER / RESO, ENV / ENV
 *        REL). The drums stay in the mix (through COMP); MOD and DELAY return alongside
 *        them, and FILTER (after COMP) takes the drums and both returns.
 *  FX 2  PAD (a send): MOD (CHORUS, ENSEMBLE, PHASER), DELAY (STEREO, PING-PONG, TAPE),
 *        VERB (HALL, PLATE, SHIMMER), TONE (LOW CUT / HI CUT on the returns, PUMP / PUMP
 *        REL: every KICK hit ducks the returns).
 *  FX 3  LEAD (a send): DIST (TUBE, FUZZ, BIT), DELAY (PING-PONG, DUB TAPE, SLAPBACK), VERB
 *        (ROOM, PLATE, SPRING), TONE (LOW CUT / HI CUT, DUCK / DUCK REL: the lead's own
 *        playing ducks its echoes, so they bloom in the gaps).
 * FILTER: one knob, low-pass left of the centre, high-pass right, off in the middle
 * (djCutoff); RESO; ENV (the bus's level lifts (+) or lowers (-) the cutoff on every hit, up
 * to 8 octaves) / ENV REL (how fast that falls back). MOD: RATE / DEPTH. DELAY: RATE (tempo-synced) / FEEDBACK. VERB: SIZE / LENGTH. DIST:
 * DRIVE / TONE.
 */
import { choice, type ParamSpec } from '../engine/params';
import { COMP_PARAMS } from './Compressor';

export const NUM_BUSES = 3;

export type UnitKind = 'comp' | 'mod' | 'delay' | 'verb' | 'drive' | 'tone' | 'filter';

/** The engine's effect modes, in the order units.ts numbers them (each bus offers some as its TYPE list). */
export const MOD_MODES = ['CHORUS', 'ENSEMBLE', 'FLANGER', 'PHASER'] as const;
export const DELAY_MODES = ['STEREO', 'PING-PONG', 'TAPE', 'DUB TAPE', 'SWEEP', 'REVERSE', 'SLAPBACK'] as const;
export const VERB_MODES = ['ROOM', 'HALL', 'PLATE', 'EARLY', 'SHIMMER', 'SPRING'] as const;
export const DRIVE_MODES = ['TUBE', 'FUZZ', 'BIT'] as const;

/** Tempo-synced delay times, in 16th steps. */
export const FX_DELAY_TIMES = [
  { name: '1/32', steps: 0.5 }, { name: '1/16T', steps: 2 / 3 }, { name: '1/16', steps: 1 }, { name: '1/8T', steps: 4 / 3 },
  { name: '1/8', steps: 2 }, { name: '3/16', steps: 3 }, { name: '1/4T', steps: 8 / 3 }, { name: '1/4', steps: 4 },
  { name: '3/8', steps: 6 }, { name: '1/2', steps: 8 }, { name: '3/4', steps: 12 }, { name: '1 BAR', steps: 16 },
] as const;

/** TONE's ducking: PUMP follows the KICK, DUCK follows the bus's own input. */
export type DuckSource = 'kick' | 'input';

export interface UnitDef {
  kind: UnitKind;
  /** TYPE choices (engine mode names), for effect units. */
  types?: readonly string[];
  /** TONE: what ducks the returns. */
  duck?: DuckSource;
  /** Starting values (by param id; the rest from the specs). */
  defaults: Readonly<Record<string, number>>;
}

interface BusDef {
  name: string;
  /** FX 1: the members pass through it (COMP in series), not a send. */
  insert: boolean;
  units: readonly UnitDef[];
}

export const BUSES: readonly BusDef[] = [
  {
    name: 'FX 1', insert: true, units: [
      { kind: 'comp', defaults: {} },
      { kind: 'mod', types: ['FLANGER', 'PHASER'], defaults: { mod_vol: 0, mod_rate: 0.3, mod_depth: 0.5 } },
      { kind: 'delay', types: ['TAPE', 'SWEEP', 'REVERSE'], defaults: { dly_vol: 0, dly_rate: 4, dly_fdbk: 0.35 } },
      { kind: 'filter', defaults: {} },
    ],
  },
  {
    name: 'FX 2', insert: false, units: [
      { kind: 'mod', types: ['CHORUS', 'ENSEMBLE', 'PHASER'], defaults: { mod_vol: 0.3, mod_type: 1, mod_rate: 0.5, mod_depth: 0.5 } },
      { kind: 'delay', types: ['STEREO', 'PING-PONG', 'TAPE'], defaults: { dly_vol: 0.15, dly_rate: 8, dly_fdbk: 0.45 } },
      { kind: 'verb', types: ['HALL', 'PLATE', 'SHIMMER'], defaults: { vrb_vol: 0.45, vrb_size: 0.7, vrb_len: 0.6 } },
      { kind: 'tone', duck: 'kick', defaults: { tone_low: 150, tone_high: 14000, tone_duck: 0, tone_rel: 0.25 } },
    ],
  },
  {
    name: 'FX 3', insert: false, units: [
      { kind: 'drive', types: ['TUBE', 'FUZZ', 'BIT'], defaults: { drv_vol: 0, drv_drive: 0.4, drv_tone: 5000 } },
      { kind: 'delay', types: ['PING-PONG', 'DUB TAPE', 'SLAPBACK'], defaults: { dly_vol: 0.35, dly_rate: 5, dly_fdbk: 0.4 } },
      { kind: 'verb', types: ['ROOM', 'PLATE', 'SPRING'], defaults: { vrb_vol: 0.25, vrb_type: 1, vrb_size: 0.5, vrb_len: 0.5 } },
      { kind: 'tone', duck: 'input', defaults: { tone_low: 200, tone_high: 16000, tone_duck: 0.4, tone_rel: 0.3 } },
    ],
  },
];

const linear = (id: string, name: string, min: number, max: number, defaultValue: number, unit = '', decimals?: number): ParamSpec =>
  ({ id, name, min, max, defaultValue, unit, curve: 'linear', ...(decimals !== undefined ? { decimals } : {}) });
const exp = (id: string, name: string, min: number, max: number, defaultValue: number, unit: string, decimals?: number): ParamSpec =>
  ({ id, name, min, max, defaultValue, unit, curve: 'exp', ...(decimals !== undefined ? { decimals } : {}) });

const COMP = Object.fromEntries(COMP_PARAMS.map((p) => [p.id, p]));

/**
 * A unit's four knobs in panel order: module 1 top, module 1 bottom, module 2 top, module 2
 * bottom (an effect: VOLUME, TYPE, then its two controls).
 */
function unitSpecs(u: UnitDef): ParamSpec[] {
  const types = u.types ?? [];
  const specs: ParamSpec[] = (() => {
    switch (u.kind) {
      case 'comp': return [
        { ...COMP.cmp_ratio, name: 'RATIO' }, { ...COMP.cmp_thresh, name: 'THRESH' },
        { ...COMP.cmp_attack, name: 'ATTACK' }, { ...COMP.cmp_release, name: 'RELEASE' },
      ];
      case 'mod': return [
        linear('mod_vol', 'MOD', 0, 1, 0), choice('mod_type', 'TYPE', types),
        exp('mod_rate', 'RATE', 0.05, 10, 0.5, 'HZ', 2), linear('mod_depth', 'DEPTH', 0, 1, 0.5),
      ];
      case 'delay': return [
        linear('dly_vol', 'DELAY', 0, 1, 0), choice('dly_type', 'TYPE', types),
        choice('dly_rate', 'RATE', FX_DELAY_TIMES.map((d) => d.name), 4), linear('dly_fdbk', 'FDBK', 0, 1.1, 0.4),
      ];
      case 'verb': return [
        linear('vrb_vol', 'VERB', 0, 1, 0), choice('vrb_type', 'TYPE', types),
        linear('vrb_size', 'SIZE', 0, 1, 0.5), linear('vrb_len', 'LENGTH', 0, 1, 0.5),
      ];
      case 'drive': return [
        linear('drv_vol', 'DIST', 0, 1, 0), choice('drv_type', 'TYPE', types),
        linear('drv_drive', 'DRIVE', 0, 1, 0.4), exp('drv_tone', 'TONE', 300, 16000, 5000, 'HZ', 0),
      ];
      case 'filter': return [
        { ...linear('flt', 'FILTER', 0, 1, 0.5), display: 'dj' }, linear('flt_reso', 'RESO', 0, 1, 0),
        linear('flt_env', 'ENV', -1, 1, 0), exp('flt_rel', 'ENV REL', 0.005, 2, 0.15, 'S', 3),
      ];
      case 'tone': {
        const pump = u.duck === 'kick';
        return [
          exp('tone_low', 'LOW CUT', 20, 1000, 20, 'HZ', 0), exp('tone_high', 'HI CUT', 1000, 20000, 20000, 'HZ', 0),
          linear('tone_duck', pump ? 'PUMP' : 'DUCK', 0, 1, 0), exp('tone_rel', pump ? 'PUMP REL' : 'DUCK REL', 0.03, 2, 0.25, 'S', 2),
        ];
      }
    }
  })();
  return specs.map((s) => ({ ...s, defaultValue: u.defaults[s.id] ?? s.defaultValue }));
}

/** Each bus's parameters, by id. */
export const BUS_PARAMS: readonly (readonly ParamSpec[])[] = BUSES.map((b) => b.units.flatMap(unitSpecs));

/** Each bus's 16 knobs (top row, then bottom row): unit u on modules 2u + 1 and 2u + 2. */
export const BUS_LAYOUT: readonly (readonly string[])[] = BUSES.map((b) => {
  const top: string[] = [];
  const bottom: string[] = [];
  for (const u of b.units) {
    const [m1t, m1b, m2t, m2b] = unitSpecs(u).map((s) => s.id);
    top.push(m1t, m2t);
    bottom.push(m1b, m2b);
  }
  return [...top, ...bottom];
});

/**
 * What a live knob may take from the buses: each effect's VOLUME and FX 1's FILTER (a unit's
 * first knob; not COMP / TONE), id "fx<n>:<param>", named "FX<n>:<knob>".
 */
export const FX_LIVE: readonly { id: string; bus: number; param: string; name: string }[] = BUSES.flatMap((b, k) =>
  b.units.filter((u) => u.kind !== 'comp' && u.kind !== 'tone').map((u) => {
    const spec = unitSpecs(u)[0];
    return { id: `fx${k + 1}:${spec.id}`, bus: k, param: spec.id, name: `FX${k + 1}:${spec.name}` };
  }));

export function busParam(bus: number, id: string): ParamSpec | undefined {
  return BUS_PARAMS[bus]?.find((p) => p.id === id);
}

/** A bus's starting settings. */
export function defaultBus(bus: number): Record<string, number> {
  return Object.fromEntries(BUS_PARAMS[bus].map((p) => [p.id, p.defaultValue]));
}

export function defaultBuses(): Record<string, number>[] {
  return BUSES.map((_, k) => defaultBus(k));
}

/** The engine mode name of a unit's TYPE index on a bus. */
export function typeName(bus: number, kind: UnitKind, index: number): string {
  const types = BUSES[bus].units.find((u) => u.kind === kind)?.types ?? [];
  return types[Math.max(0, Math.min(types.length - 1, Math.round(index)))] ?? '';
}
