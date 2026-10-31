/**
 * Chord mode: each triggered note plays a chord built on it. Index 0 = off.
 * Voiced close, root position; jungle/DnB staples are the 7ths and 9ths.
 */
export const CHORDS: readonly { name: string; intervals: readonly number[]; key?: number }[] = [
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
  // KEY chords: `key` tones stacked in thirds along SCALE's natural minor from the note played
  // (A minor: A = Am, C = C, E = Em; KEY7 on C = Cmaj7, on E = Em7, on B = Bm7b5).
  { name: 'KEY', intervals: [0, 4, 7], key: 3 },
  { name: 'KEY7', intervals: [0, 4, 7, 11], key: 4 },
  { name: 'KEY9', intervals: [0, 4, 7, 11, 14], key: 5 },
  { name: 'KEY11', intervals: [0, 4, 7, 11, 14, 17], key: 6 },
];

export const CHORD_NAMES = CHORDS.map((c) => c.name);

/** The CHORD knob's order (chords are stored by index): each size grouped, KEY last in it. */
export const CHORD_KNOB: readonly number[] = [
  'OFF', '5TH', '5TH+OCT', 'SUS4', 'MAJOR', 'MINOR', 'KEY', 'MAJ7', 'MIN7', 'DOM7', 'KEY7',
  'MAJ9', 'MIN9', 'DOM9', 'KEY9', 'MAJ11', 'MIN11', 'KEY11',
].map((n) => CHORD_NAMES.indexOf(n));

/** KEY chords' scale: the natural minor's steps from the root. */
const KEY_SCALE = [0, 2, 3, 5, 7, 8, 10];


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

/**
 * KEY_VOICINGS[chord][degree][notes - 1]: a KEY chord on each degree of the scale, its tones
 * ranked as above by their place in the stack (root, 5th, 3rd, 7th, 9th, 11th). Built once.
 */
const STACK_RANK = [0, 2, 1, 3, 4, 5];
const KEY_VOICINGS: readonly (readonly (readonly (readonly number[])[])[] | null)[] = CHORDS.map((c) => {
  const size = c.key;
  if (!size) return null;
  return KEY_SCALE.map((_, d) => {
    const at = (k: number) => KEY_SCALE[(d + k) % 7] + 12 * Math.floor((d + k) / 7) - KEY_SCALE[d];
    const ranked = STACK_RANK.filter((k) => k < size).map((k) => at(2 * k));
    return Array.from({ length: MAX_CHORD_NOTES }, (_, n) => ranked.slice(0, n + 1).sort((a, b) => a - b));
  });
});

/**
 * The intervals to play for a chord at a NOTES setting (1..MAX_CHORD_NOTES) on `note`. KEY
 * chords follow SCALE (`root`, a pitch class): the note's degree of its natural minor (off the
 * scale: the degree below) gives the chord's shape.
 */
export function chordVoicing(chord: number, notes: number, note = 0, root = 9): readonly number[] {
  const n = Math.max(1, Math.min(MAX_CHORD_NOTES, notes)) - 1;
  const key = KEY_VOICINGS[chord];
  if (key) {
    const pc = (((note - root) % 12) + 12) % 12;
    let d = KEY_SCALE.length - 1;
    while (KEY_SCALE[d] > pc) d--;
    return key[d][n];
  }
  return (CHORD_VOICINGS[chord] ?? CHORD_VOICINGS[0])[n];
}
