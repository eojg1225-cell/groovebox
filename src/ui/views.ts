/**
 * What the pixel screen shows. Pure drawing from plain view-model objects.
 *  - Live view (RECORD / PLAY): eight step lanes, then the 16 live knobs (one column per track).
 *  - Design view (DESIGN, and an open FX bus): page tabs and the 16 knobs as on the panel.
 */
import { INK, PixelScreen, SCREEN_W } from './screen';
import { textWidth } from './font';

export interface LaneCell {
  /** none = beyond the pattern length. */
  state: 'none' | 'off' | 'ghost' | 'normal' | 'accent';
  /** The step does not play (time signature, triplet time, STEPS): a dot, its note hidden. */
  skip?: boolean;
  /** Note letter for the selected pitched lane, '' otherwise. */
  note: string;
  /** Step has parameter locks (live-recorded). */
  locked: boolean;
  /** Empty step covered by an earlier note's length (tie). */
  tie: boolean;
  /** RING hit (rings until the next hit or rest). */
  ring: boolean;
  /** Rest marker. */
  rest: boolean;
  /** SLIDE: this note glides into the next one. */
  slide: boolean;
  /** Hits in the step (ROLL), 1 = one. */
  roll: number;
}

export interface LaneView {
  name: string;
  cells: LaneCell[]; // 16 cells of the visible page
  playhead: number; // cell index or -1
  cursor: number; // cell index or -1 (step entry)
  muted: boolean;
  selected: boolean;
}

export interface KnobSlotView {
  name: string;
  valueText: string;
  norm: number;
  highlight: boolean;
}

interface HeaderView {
  channelLabel: string;
  patternLabel: string;
  bpmText: string;
  playing: boolean;
  /** Short confirmation (e.g. "PROJECT SAVED") shown in place of the middle text. */
  message: string;
}

interface FooterView {
  peak: number;
  footerRight: string;
  footerAlert: boolean;
  blink: boolean;
}

export interface LiveView extends HeaderView, FooterView {
  stepsLabel: string;
  motion: boolean;
  lanes: LaneView[];
  modeLabel: string;
  keyboardLabel: string;
  dynamicLabel: string;
  slots: (KnobSlotView | null)[];
  touchedSlot: number;
}

export interface DesignView extends HeaderView, FooterView {
  kindLabel: string;
  pages: string[];
  page: number;
  slots: (KnobSlotView | null)[];
  touchedSlot: number;
  liveLabel: string;
  chordLabel: string;
}

const LANE_Y = 12;
const LANE_H = 6;
const LANE_GAP = 2;
const GRID_X = 30;
const CELL = 12;
const CELL_GAP = 1;
const GROUP_GAP = 3;
/** Knob slots: 2 rows of COLS, as on the panel. */
const COLS = 8;
const SLOTS = COLS * 2;
const SLOT_W = 31;
const FOOTER_Y = 120;
/** Hit height encodes dynamics: tall accent, medium normal, short ghost. */
const DYN_HEIGHT = { ghost: 2, normal: 4, accent: 6 } as const;

function fit(text: string, width: number): string {
  const max = Math.floor((width + 1) / 4);
  return text.length > max ? text.slice(0, max) : text;
}

function drawHeader(s: PixelScreen, v: HeaderView, middle: string, middleColor: string): void {
  s.rect(0, 0, SCREEN_W, 9, INK.dim);
  s.text(2, 2, `${v.channelLabel}  ${v.patternLabel}`, INK.hi);
  if (v.message) {
    const w = textWidth(v.message) + 4;
    s.rect(110, 1, w, 7, INK.warn);
    s.text(112, 2, v.message, INK.bg);
  } else {
    s.text(112, 2, middle, middleColor);
  }
  s.textRight(SCREEN_W - 12, 2, `${v.bpmText} BPM`, INK.hi);
  if (v.playing) {
    for (let i = 0; i < 4; i++) s.rect(SCREEN_W - 8 + i, 1 + i, 1, 7 - i * 2, INK.hi);
  } else {
    s.rect(SCREEN_W - 8, 2, 5, 5, INK.mid);
  }
}

function drawFooter(s: PixelScreen, v: FooterView, left: string, extra: string): void {
  s.rect(0, FOOTER_Y - 3, SCREEN_W, 1, INK.dim);
  s.text(2, FOOTER_Y, left, INK.mid);
  s.text(118, FOOTER_Y, extra, INK.warn);
  const m = Math.max(0, Math.min(1, v.peak <= 0 ? 0 : (20 * Math.log10(v.peak) + 48) / 48));
  s.rect(166, FOOTER_Y + 1, 24, 3, INK.dim);
  s.rect(166, FOOTER_Y + 1, Math.round(24 * m), 3, v.peak >= 0.99 ? INK.warn : INK.hi);
  if (!v.footerAlert || v.blink) s.textRight(SCREEN_W - 2, FOOTER_Y, v.footerRight, v.footerAlert ? INK.warn : INK.mid);
}

export function drawLiveView(s: PixelScreen, v: LiveView): void {
  s.clear();
  const showRec = v.motion && v.blink;
  drawHeader(s, v, showRec ? 'REC' : v.stepsLabel, showRec ? INK.warn : INK.mid);

  // Step lanes
  v.lanes.forEach((lane, li) => {
    const y = LANE_Y + li * (LANE_H + LANE_GAP);
    if (lane.selected) s.rect(0, y - 1, GRID_X - 3, LANE_H + 2, INK.mid);
    s.text(2, y + 1, lane.name, lane.selected ? INK.bg : lane.muted ? INK.dim : INK.mid);
    lane.cells.forEach((cell, i) => {
      const x = GRID_X + i * (CELL + CELL_GAP) + Math.floor(i / 4) * GROUP_GAP;
      if (cell.state === 'none') return;
      if (cell.skip) {
        s.rect(x + (CELL >> 1), y + (LANE_H >> 1), 1, 1, INK.dim);
        return;
      }
      const head = lane.playhead === i;
      if (cell.rest) {
        // Rest marker: a small square at the bottom.
        s.rect(x + 4, y + LANE_H - 3, 4, 3, head ? INK.warn : INK.mid);
        return;
      }
      if (cell.state === 'off' && cell.tie) {
        // Note held over from an earlier step: a bar joining it to the note.
        s.rect(x - CELL_GAP - (i % 4 === 0 ? GROUP_GAP : 0), y + 1, CELL + CELL_GAP + (i % 4 === 0 ? GROUP_GAP : 0), 3, head ? INK.warn : INK.mid);
      } else if (cell.state === 'off') {
        s.rect(x, y + LANE_H - 1, CELL, 1, head ? INK.hi : INK.dim);
      } else if (cell.note) {
        const color = head ? INK.warn : cell.state === 'ghost' ? INK.mid : INK.hi;
        s.rect(x, y - 1, CELL, LANE_H + 1, color);
        s.text(x + 1, y, cell.note, INK.bg);
      } else {
        const h = DYN_HEIGHT[cell.state];
        s.rect(x, y + LANE_H - h, CELL, h, head ? INK.warn : lane.muted ? INK.mid : INK.hi);
      }
      if (cell.locked) s.rect(x + CELL - 2, y - 1, 2, 1, INK.warn);
      // ROLL: the cell split into its hits.
      for (let k = 1; k < cell.roll; k++) s.rect(x + Math.round((k * CELL) / cell.roll), y - 1, 1, LANE_H + 1, INK.bg);
      // SLIDE: a low bar from this note on into the next cell (it glides into the next note).
      if (cell.slide) {
        const gap = CELL_GAP + ((i + 1) % 4 === 0 ? GROUP_GAP : 0);
        s.rect(x + CELL - 1, y + LANE_H - 1, gap + 4, 2, head ? INK.warn : INK.hi);
      }
      // RING: a tail running to the right edge of the cell.
      if (cell.ring) s.rect(x + CELL - 1, y + 1, 2, LANE_H - 2, INK.warn);
    });
    if (lane.cursor >= 0) {
      const x = GRID_X + lane.cursor * (CELL + CELL_GAP) + Math.floor(lane.cursor / 4) * GROUP_GAP;
      s.frame(x - 1, y - 2, CELL + 2, LANE_H + 3, INK.warn);
    }
  });

  // Live knobs: column = track, two rows.
  const ky = LANE_Y + v.lanes.length * (LANE_H + LANE_GAP) + 2;
  s.rect(0, ky - 2, SCREEN_W, 1, INK.dim);
  for (let i = 0; i < SLOTS; i++) {
    const slot = v.slots[i];
    const x = 2 + (i % COLS) * SLOT_W;
    const y = ky + Math.floor(i / COLS) * 18;
    const touched = i === v.touchedSlot;
    if (touched || slot?.highlight) s.rect(x - 1, y - 1, SLOT_W - 1, 18, touched ? INK.dim : INK.shade);
    if (!slot) continue;
    s.text(x, y + 1, fit(slot.name, SLOT_W - 3), touched ? INK.hi : INK.mid);
    s.text(x, y + 7, fit(slot.valueText, SLOT_W - 3), INK.hi);
    s.rect(x, y + 14, SLOT_W - 5, 2, INK.dim);
    s.rect(x, y + 14, Math.round((SLOT_W - 5) * slot.norm), 2, touched ? INK.hi : INK.mid);
  }

  drawFooter(s, v, `${v.modeLabel} ${v.keyboardLabel}`, v.dynamicLabel);
}

/** Pixel knob: 270-degree ring with the value arc and a pointer. */
function drawKnob(s: PixelScreen, cx: number, cy: number, r: number, norm: number, active: boolean): void {
  const steps = 28;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const a = (-135 + t * 270) * (Math.PI / 180);
    const x = Math.round(cx + r * Math.sin(a));
    const y = Math.round(cy - r * Math.cos(a));
    s.rect(x, y, 1, 1, t <= norm ? (active ? INK.hi : INK.mid) : INK.dim);
  }
  const a = (-135 + norm * 270) * (Math.PI / 180);
  for (let d = 0; d <= r - 2; d++) {
    s.rect(Math.round(cx + d * Math.sin(a)), Math.round(cy - d * Math.cos(a)), 1, 1, INK.hi);
  }
}

export function drawDesignView(s: PixelScreen, v: DesignView): void {
  s.clear();
  drawHeader(s, v, v.kindLabel, INK.mid);

  // Page tabs
  let tx = 2;
  v.pages.forEach((name, i) => {
    const w = textWidth(name) + 6;
    if (i === v.page) s.rect(tx, 11, w, 8, INK.mid);
    else s.frame(tx, 11, w, 8, INK.dim);
    s.text(tx + 3, 12, name, i === v.page ? INK.bg : INK.mid);
    tx += w + 3;
  });

  // 16 knobs, laid out like the panel (2 rows of 8).
  for (let i = 0; i < SLOTS; i++) {
    const slot = v.slots[i];
    const x = 2 + (i % COLS) * SLOT_W;
    const y = 22 + Math.floor(i / COLS) * 47;
    const touched = i === v.touchedSlot;
    if (touched) s.rect(x - 1, y - 1, SLOT_W - 1, 45, INK.dim);
    if (!slot) {
      s.text(x + 13, y + 18, '-', INK.dim);
      continue;
    }
    s.text(x, y + 1, fit(slot.name, SLOT_W - 2), touched ? INK.hi : INK.mid);
    drawKnob(s, x + 14, y + 19, 9, slot.norm, touched);
    const big = textWidth(slot.valueText, 2) <= SLOT_W - 3;
    if (big) s.text(x, y + 32, slot.valueText, INK.hi, 2);
    else s.text(x, y + 35, fit(slot.valueText, SLOT_W - 2), INK.hi);
  }

  drawFooter(s, v, v.liveLabel, v.chordLabel);
}

export interface SongStripView extends HeaderView, FooterView {
  /** One label per track. */
  tracks: string[];
  selected: number;
  /** The page's first bar (0 = the song's first). */
  firstBar: number;
  /** Per track, its clips (absolute bars; the drawing keeps to the page). */
  lanes: { at: number; bars: number; name: string }[][];
  /** The cursor on the selected lane: bars `from`-`to` (yellow). */
  cursorFrom: number;
  cursorTo: number;
  playingBar: number;
  /** Bars the song lasts (the end shows as a line). */
  endBar: number;
  footerLeft: string;
}

const STRIP_Y = 20;
const STRIP_ROW = 11;
const STRIP_X = 34;
const STRIP_CELL = 12;

/** Left edge of page cell i (groups of four, a gap between them). */
const stripCellX = (i: number) => STRIP_X + i * (STRIP_CELL + 1) + Math.floor(i / 4) * 2;

/**
 * SONG (strip preview): a lane per track over the page's 16 bars, each clip a bar as long as
 * it plays with its pattern's letter at its start; the cursor yellow, the bar playing shaded.
 */
export function drawSongStripView(s: PixelScreen, v: SongStripView): void {
  s.clear();
  drawHeader(s, v, '', INK.mid);
  const last = STRIP_Y + v.tracks.length * STRIP_ROW - 2;
  for (let i = 0; i < 16; i++) {
    const bar = v.firstBar + i;
    const x = stripCellX(i);
    if (bar === v.playingBar) s.rect(x - 1, STRIP_Y - 2, STRIP_CELL + 2, last - STRIP_Y + 3, INK.shade);
    if (i % 4 === 0 || bar === v.playingBar) s.text(x, 12, String(bar + 1), bar === v.playingBar ? INK.hi : INK.mid);
    if (bar === v.endBar) s.rect(x - 2, STRIP_Y - 2, 1, last - STRIP_Y + 3, INK.mid);
  }
  v.tracks.forEach((t, ch) => {
    const y = STRIP_Y + ch * STRIP_ROW;
    const sel = ch === v.selected;
    s.text(2, y + 2, t, sel ? INK.warn : INK.mid);
    for (let i = 0; i < 16; i++) s.rect(stripCellX(i), y + 4, STRIP_CELL, 1, INK.shade);
    for (const c of v.lanes[ch]) {
      const from = Math.max(c.at, v.firstBar) - v.firstBar;
      const to = Math.min(c.at + c.bars, v.firstBar + 16) - v.firstBar - 1;
      if (to < 0 || from > 15) continue;
      const x0 = stripCellX(from);
      s.rect(x0, y, stripCellX(to) + STRIP_CELL - x0, STRIP_ROW - 2, sel ? INK.mid : INK.dim);
      if (c.at >= v.firstBar) {
        s.rect(x0, y, 1, STRIP_ROW - 2, INK.hi);
        s.text(x0 + 3, y + 2, c.name, sel ? INK.bg : INK.hi);
      }
    }
    if (sel) {
      const from = Math.max(v.cursorFrom, v.firstBar) - v.firstBar;
      const to = Math.min(v.cursorTo, v.firstBar + 15) - v.firstBar;
      if (to >= 0 && from <= 15) {
        const x0 = stripCellX(from) - 1;
        s.frame(x0, y - 1, stripCellX(to) + STRIP_CELL + 1 - x0, STRIP_ROW, INK.warn);
      }
    }
  });
  drawFooter(s, v, v.footerLeft, '');
}

export interface ProjectView {
  kind: 'save' | 'load';
  bank: number;
  banks: number;
  /** SAVE: the name being entered, and the character the knobs set. */
  name: string;
  cursor: number;
  slots: { number: number; name: string; used: boolean; open: boolean; confirm: boolean }[];
  message: string;
  blink: boolean;
}

const PROJ_ROW_H = 8;
const PROJ_COL_W = 128;

/** SAVE / LOAD PROJECT: the name being entered (SAVE) and the bank's 16 slots, 2 columns of 8. */
export function drawProjectView(s: PixelScreen, v: ProjectView): void {
  s.clear();
  const save = v.kind === 'save';
  // A loud title band: which one this is can't be missed.
  s.rect(0, 0, SCREEN_W, 13, save ? INK.warn : INK.hi);
  s.text(3, 2, save ? 'SAVE' : 'LOAD', INK.bg, 2);
  s.text(40, 4, 'PROJECT', INK.bg);
  s.textRight(SCREEN_W - 3, 4, `BANK ${v.bank + 1}/${v.banks}`, INK.bg);
  let y = 18;
  if (save) {
    s.text(3, y + 2, 'NAME', INK.mid);
    const x = 24;
    s.text(x, y, v.name, INK.hi, 2, true);
    // The character the knobs set (blinking underline).
    if (v.blink) s.rect(x + v.cursor * 8, y + 11, 6, 1, INK.warn);
    y = 34;
  }
  s.rect(0, y - 2, SCREEN_W, 1, INK.dim);
  v.slots.forEach((slot, i) => {
    const col = i < 8 ? 0 : 1;
    const row = i % 8;
    const x = 3 + col * PROJ_COL_W;
    const ry = y + row * PROJ_ROW_H;
    if (slot.confirm) s.rect(x - 2, ry - 1, PROJ_COL_W - 4, PROJ_ROW_H - 1, INK.warn);
    const ink = slot.confirm ? INK.bg : slot.open ? INK.hi : slot.used ? INK.mid : INK.dim;
    s.text(x, ry, String(slot.number).padStart(2, '0'), ink);
    s.text(x + 12, ry, slot.used ? slot.name : '--', ink, 1, true);
    if (slot.open && !slot.confirm) s.text(x + PROJ_COL_W - 14, ry, '<', INK.hi);
  });
  const hint = save
    ? '< > MOVE  KNOBS 1-4 LETTER  BAR+< > BANK  TAP SLOT = SAVE'
    : '< > BANK  TAP = LOAD (EMPTY = NEW)  CLEAR+SLOT = DELETE';
  s.rect(0, FOOTER_Y - 3, SCREEN_W, 1, INK.dim);
  if (v.message) s.text(2, FOOTER_Y, v.message, INK.warn);
  else s.text(2, FOOTER_Y, hint, INK.mid);
}

export interface MenuView {
  /** The pages gone into, e.g. MENU > PROJECT SETTINGS > TRACKS. */
  title: string;
  /** value: a setting's choice ('' = none); page: the line opens a page; pending: a choice waiting for its strip key. */
  items: { label: string; value: string; page: boolean; pending: boolean }[];
  item: number;
  /** A confirmation, or how to use the page. */
  message: string;
}

const MENU_ROW_H = 11;

/** MENU: one line per item (number = its strip key), the cursor's line inverted. */
export function drawMenuView(s: PixelScreen, v: MenuView): void {
  s.clear();
  s.rect(0, 0, SCREEN_W, 13, INK.hi);
  s.text(3, 4, v.title, INK.bg);
  v.items.forEach((it, i) => {
    const y = 18 + i * MENU_ROW_H;
    const on = i === v.item;
    if (on) s.rect(0, y - 2, SCREEN_W, MENU_ROW_H - 1, INK.hi);
    const ink = on ? INK.bg : INK.mid;
    s.text(3, y, String(i + 1).padStart(2, '0'), ink);
    s.text(20, y, it.label, on ? INK.bg : INK.hi);
    if (it.page) s.text(SCREEN_W - 8, y, '>', ink);
    else if (it.value) {
      const valueInk = it.pending ? (on ? INK.bg : INK.warn) : ink;
      s.textRight(SCREEN_W - 12, y, it.value, valueInk);
      s.text(SCREEN_W - 8, y, on ? '<>' : '', ink);
    }
  });
  s.rect(0, FOOTER_Y - 3, SCREEN_W, 1, INK.dim);
  s.text(2, FOOTER_Y, v.message, INK.mid);
}

/**
 * The start-up title card, as the hardware would show it while it boots: the name, the
 * credit and a status line (TAP TO START blinks until audio is allowed).
 */
export function drawTitleView(s: PixelScreen, status: string, blink: boolean): void {
  s.clear(INK.bg);
  const name = 'GrooveAccess';
  const credit = 'A Garibaldi Production';
  s.text(Math.round((SCREEN_W - textWidth(name, 3)) / 2), 34, name, INK.hi, 3, true);
  s.text(Math.round((SCREEN_W - textWidth(credit)) / 2), 60, credit, INK.mid, 1, true);
  if (blink) s.text(Math.round((SCREEN_W - textWidth(status)) / 2), 100, status, INK.mid);
}
