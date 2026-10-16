/**
 * The six effects inside every send, in panel order (one knob module each): WET (its
 * return volume) on top, INTENSITY below. See SendBus for what intensity drives.
 */
export const EFFECTS = [
  { id: 'delay', name: 'DELAY' },
  { id: 'dist', name: 'DISTORT' },
  { id: 'midcut', name: 'MID CUT' },
  { id: 'chorus', name: 'CHORUS' },
  { id: 'reverb', name: 'REVERB' },
  { id: 'comp', name: 'COMP' },
] as const;

export const NUM_SEND_BUSES = 3;

/** Starting send settings: 1 = dub delay, 2 = reverb (+ chorus), 3 = dirt. [send][effect] */
export function defaultSendWet(): number[][] {
  return [
    [0.6, 0, 0, 0, 0.2, 0],
    [0, 0, 0, 0.2, 0.7, 0],
    [0, 0.5, 0.3, 0, 0, 0.5],
  ];
}

export function defaultSendInt(): number[][] {
  return [
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5, 0.4, 0.6, 0.5],
    [0.5, 0.5, 0.6, 0.5, 0.5, 0.6],
  ];
}
