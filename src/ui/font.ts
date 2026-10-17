/**
 * 3x5 pixel font. Each glyph is 5 rows of 3 bits, top row first.
 * Advance is 4 px per character, line height 6 px (at scale 1).
 */
const GLYPHS: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
  E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
  I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
  Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111',
  '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010',
  '8': '111101111101111', '9': '111101111001110',
  '.': '000000000000010', '-': '000000111000000', ':': '000010000010000', '/': '001001010100100',
  '%': '101001010100101', '+': '000010111010000', '=': '000111000111000', '>': '100010001010100',
  '<': '001010100010001', '(': '010100100100010', ')': '010001001001010', '_': '000000000000111',
  '!': '010010010000010', '#': '101111101111101', '?': '110001010000010', ' ': '000000000000000',
};

/**
 * Lowercase (only where text asks for mixed case, e.g. the title screen); letters without
 * a lowercase glyph use the capital.
 */
const LOWER: Record<string, string> = {
  a: '000011101101011', b: '100100110101110', c: '000011100100011', d: '001001011101011',
  e: '000011111100011', i: '010000010010010', l: '010010010010001', n: '000110101101101',
  o: '000010101101010', r: '000101110100100', s: '000011100001110', t: '010111010010001',
  u: '000101101101011', v: '000101101101010',
};

export const GLYPH_W = 3;
export const GLYPH_H = 5;
export const ADVANCE = 4;

const toBits = (s: string) => Uint8Array.from(s, (c) => (c === '1' ? 1 : 0));
const BITS: Record<string, Uint8Array> = {};
for (const [ch, s] of Object.entries(GLYPHS)) BITS[ch] = toBits(s);
const LOWER_BITS: Record<string, Uint8Array> = {};
for (const [ch, s] of Object.entries(LOWER)) LOWER_BITS[ch] = toBits(s);

/** Glyph for a character; text is shown in capitals unless mixedCase is asked for. */
export function glyphBits(ch: string, mixedCase = false): Uint8Array {
  return (mixedCase ? LOWER_BITS[ch] : undefined) ?? BITS[ch.toUpperCase()] ?? BITS['?'];
}

export function textWidth(text: string, scale = 1): number {
  return text.length === 0 ? 0 : (text.length * ADVANCE - 1) * scale;
}
