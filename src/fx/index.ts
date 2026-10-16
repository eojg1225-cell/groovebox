/**
 * The six effects inside every send, in panel order (one knob module each).
 * Each is controlled by a single AMOUNT knob; see SendBus for what it drives.
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

/** Starting amounts per send: 1 = dub delay, 2 = reverb, 3 = dirt (distortion + compression). */
export function defaultSendFx(): number[][] {
  return [
    [0.6, 0, 0, 0, 0.2, 0],
    [0, 0, 0, 0.2, 0.7, 0],
    [0, 0.5, 0.3, 0, 0, 0.5],
  ];
}
