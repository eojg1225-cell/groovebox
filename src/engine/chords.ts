/**
 * Chord mode: each triggered note plays a chord built on it. Index 0 = off.
 * Voiced close, root position; jungle/DnB staples are the 7ths and 9ths.
 */
export const CHORDS: readonly { name: string; intervals: readonly number[] }[] = [
  { name: 'OFF', intervals: [0] },
  { name: 'MAJOR', intervals: [0, 4, 7] },
  { name: 'MINOR', intervals: [0, 3, 7] },
  { name: 'MIN7', intervals: [0, 3, 7, 10] },
  { name: 'MAJ7', intervals: [0, 4, 7, 11] },
  { name: 'DOM7', intervals: [0, 4, 7, 10] },
  { name: 'MIN9', intervals: [0, 3, 7, 10, 14] },
  { name: 'MAJ9', intervals: [0, 4, 7, 11, 14] },
  { name: 'DOM9', intervals: [0, 4, 7, 10, 14] },
  { name: 'MIN11', intervals: [0, 3, 7, 10, 14, 17] },
  { name: 'SUS4', intervals: [0, 5, 7] },
  // Added later (kept at the end: chords are stored by index).
  { name: '5TH', intervals: [0, 7] },
  { name: '5TH+OCT', intervals: [0, 7, 12] },
  { name: 'MAJ11', intervals: [0, 4, 7, 11, 14, 17] },
];

export const CHORD_NAMES = CHORDS.map((c) => c.name);


/** NOTES: how many of the chord's tones play (the most a chord has; MAX = all). */
export const MAX_CHORD_NOTES = 6;
export const NOTES_NAMES = ['1', '2', '3', '4', '5', 'ALL'];

/** Tone order for NOTES: root, then the 5th, the 3rd (or sus), the 7th, 9th, 11th, octave. */
function toneRank(interval: number): number {
  const order = [0, 7, 4, 3, 5, 2, 10, 11, 14, 17, 12];
  const i = order.indexOf(interval);
  return i < 0 ? order.length + interval : i;
}

/**
 * CHORD_VOICINGS[chord][notes - 1]: the chord's intervals with only its first `notes` tones
 * (in tone order: root, 5th, 3rd, 7th, 9th, 11th), played low to high. Built once.
 */
const CHORD_VOICINGS: readonly (readonly (readonly number[])[])[] = CHORDS.map((c) => {
  const ranked = [...c.intervals].sort((a, b) => toneRank(a) - toneRank(b));
  return Array.from({ length: MAX_CHORD_NOTES }, (_, n) => ranked.slice(0, n + 1).sort((a, b) => a - b));
});

/** The intervals to play for a chord at a NOTES setting (1..MAX_CHORD_NOTES). */
export function chordVoicing(chord: number, notes: number): readonly number[] {
  const v = CHORD_VOICINGS[chord] ?? CHORD_VOICINGS[0];
  return v[Math.max(1, Math.min(MAX_CHORD_NOTES, notes)) - 1];
}
