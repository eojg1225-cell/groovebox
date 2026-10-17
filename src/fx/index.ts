import { COMP_PARAMS as COMP_PARAMS_LIST } from './Compressor';

/**
 * FX 1 is the drum bus (DrumBus: tracks pass through it). FX 2 and FX 3 are sends.
 * The five effects inside each send, in panel order (one knob module each): WET (its
 * return volume) on top, INTENSITY below; then the bus COMPRESSOR (modules 7-8, like FX 1).
 * See SendBus for what intensity drives.
 */
export const EFFECTS = [
  { id: 'delay', name: 'DELAY' },
  { id: 'dist', name: 'DISTORT' },
  { id: 'midcut', name: 'MID CUT' },
  { id: 'chorus', name: 'CHORUS' },
  { id: 'reverb', name: 'REVERB' },
] as const;

export const NUM_SEND_BUSES = 3;

/** Send bus numbers (FX 2, FX 3) as indexes into the [3][6] send grids; row 0 is FX 1. */
export const SEND_BUSES = [1, 2] as const;

/**
 * Starting send settings, [bus][effect]. Row 0 belongs to FX 1 (the drum bus, which has
 * its own controls) and is unused. FX 2 (bass / lead) = dub delay, FX 3 (pad) = reverb + chorus.
 */
export function defaultSendWet(): number[][] {
  return [
    [0, 0, 0, 0, 0],
    [0.6, 0, 0, 0, 0.2],
    [0, 0, 0, 0.3, 0.7],
  ];
}

export function defaultSendInt(): number[][] {
  return [
    [0.5, 0.5, 0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5, 0.4, 0.6],
  ];
}

export { DRUM_BUS_LAYOUT, DRUM_BUS_PARAMS, defaultDrumBus } from './DrumBus';
export { COMP_PARAMS } from './Compressor';

/** Starting bus compressor settings per send (row 0 = FX 1, which keeps its own in fx1). */
export function defaultSendComp(): Record<string, number>[] {
  const one = (): Record<string, number> => Object.fromEntries(COMP_PARAMS_LIST.map((p) => [p.id, p.defaultValue]));
  return [one(), one(), one()];
}
