/**
 * Chord mode: each triggered note plays a chord built on it. Index 0 = off.
 * Voiced close, root position; jungle/DnB staples are the 7ths and 9ths.
 */
export const CHORDS: readonly { name: string; intervals: readonly number[] }[] = [
  { name: 'OFF', intervals: [0] },
  { name: 'MIN7', intervals: [0, 3, 7, 10] },
  { name: 'MAJ7', intervals: [0, 4, 7, 11] },
  { name: 'DOM7', intervals: [0, 4, 7, 10] },
  { name: 'MIN9', intervals: [0, 3, 7, 10, 14] },
  { name: 'MAJ9', intervals: [0, 4, 7, 11, 14] },
  { name: 'DOM9', intervals: [0, 4, 7, 10, 14] },
  { name: 'MIN11', intervals: [0, 3, 7, 10, 14, 17] },
  { name: 'SUS4', intervals: [0, 5, 7] },
];

export const CHORD_NAMES = CHORDS.map((c) => c.name);
