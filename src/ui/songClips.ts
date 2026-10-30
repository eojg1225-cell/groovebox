import { NUM_CHANNELS, SONG_MAX_ROWS, speedSteps, type ChannelState, type SongRow } from '../engine/project';

/**
 * The SONG strip (preview): the song as one lane per track, each a run of clips: a pattern
 * placed on a bar, as long as it plays (a tie over the strip's bars, one step = one bar).
 * Stored as the song's rows (split wherever any lane changes); `SongRow.keep` marks a track
 * whose clip runs on from the row before, so it carries on instead of restarting.
 */
export interface Clip {
  /** First bar (0 = the song's first). */
  at: number;
  pattern: number;
  bars: number;
}

/** The longest song the strip edits (16 pages of 16 bars). */
export const STRIP_MAX_BARS = 256;

/** How many bars a pattern lasts (its steps at its speed; a bar = 16 steps of normal time). */
export function patternBars(c: ChannelState, pattern: number): number {
  const p = c.patterns[pattern];
  return Math.max(1, Math.ceil((p.length * speedSteps(p.speed)) / 16 - 1e-9));
}

/** The song's length in bars. */
export function songBars(rows: SongRow[]): number {
  return rows.reduce((n, r) => n + r.bars, 0);
}

/**
 * Each track's clips. A grid row that plays a pattern longer than the pattern (it loops)
 * becomes one clip per loop, the last one cut short.
 */
export function songClips(rows: SongRow[], barsOf: (ch: number, pattern: number) => number): Clip[][] {
  const out: Clip[][] = Array.from({ length: NUM_CHANNELS }, () => []);
  let bar = 0;
  for (const r of rows) {
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const p = r.patterns[ch];
      if (p < 0) continue;
      const lane = out[ch];
      const last = lane[lane.length - 1];
      let left = r.bars;
      let at = bar;
      if (r.keep?.[ch] && last && last.pattern === p && last.at + last.bars === bar) {
        const room = Math.max(0, barsOf(ch, p) - last.bars);
        const grow = Math.min(room, left);
        last.bars += grow;
        left -= grow;
        at += grow;
      }
      const len = barsOf(ch, p);
      for (; left > 0; left -= len, at += len) lane.push({ at, pattern: p, bars: Math.min(len, left) });
    }
    bar += r.bars;
  }
  return out;
}

/**
 * The rows for these clips: a new row wherever any clip starts or ends; a clip crossing a
 * row line is kept (`keep`). Null when that needs more rows than a song holds.
 */
export function clipRows(clips: Clip[][]): SongRow[] | null {
  const cuts = new Set<number>([0]);
  let end = 0;
  for (const lane of clips) {
    for (const c of lane) {
      cuts.add(c.at);
      cuts.add(c.at + c.bars);
      end = Math.max(end, c.at + c.bars);
    }
  }
  const lines = [...cuts].filter((b) => b < end).sort((x, y) => x - y);
  if (lines.length > SONG_MAX_ROWS) return null;
  return lines.map((at, i) => {
    const bars = (lines[i + 1] ?? end) - at;
    const patterns = new Array<number>(NUM_CHANNELS).fill(-1);
    const keep = new Array<number>(NUM_CHANNELS).fill(0);
    clips.forEach((lane, ch) => {
      const c = lane.find((k) => k.at <= at && at < k.at + k.bars);
      if (!c) return;
      patterns[ch] = c.pattern;
      if (c.at < at) keep[ch] = 1;
    });
    return keep.some((k) => k) ? { bars, patterns, keep } : { bars, patterns };
  });
}

/** The clip covering bar `bar` of a lane (or undefined). */
export function clipAt(lane: Clip[], bar: number): Clip | undefined {
  return lane.find((c) => c.at <= bar && bar < c.at + c.bars);
}

/**
 * Place a clip: what it covers goes (a clip running into it ends where it starts, ones
 * starting under it are taken out).
 */
export function placeClip(lane: Clip[], clip: Clip): Clip[] {
  const end = clip.at + clip.bars;
  const out: Clip[] = [];
  for (const c of lane) {
    if (c.at >= clip.at && c.at < end) continue;
    if (c.at < clip.at && c.at + c.bars > clip.at) out.push({ ...c, bars: clip.at - c.at });
    else out.push(c);
  }
  out.push(clip);
  return out.sort((x, y) => x.at - y.at);
}

/** The row holding song bar `bar` and the bar within it (past the end: the last row's end). */
export function rowOfBar(rows: SongRow[], bar: number): { row: number; bar: number } {
  let start = 0;
  for (let i = 0; i < rows.length; i++) {
    if (bar < start + rows[i].bars) return { row: i, bar: bar - start };
    start += rows[i].bars;
  }
  return { row: 0, bar: 0 };
}
