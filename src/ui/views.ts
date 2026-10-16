/**
 * What the pixel screen shows. Pure drawing from plain view-model objects.
 *  - Live view (RECORD / PLAY): six step lanes, then the 12 live knobs (one column per track).
 *  - Design view (SOUND DESIGN): page tabs and the 12 knobs drawn as on the panel.
 */
import { INK, PixelScreen, SCREEN_W } from './screen';
import { textWidth } from './font';

export interface LaneCell {
  /** none = beyond the pattern length. */
  state: 'none' | 'off' | 'ghost' | 'normal' | 'accent';
  /** Note letter for the selected pitched lane, '' otherwise. */
  note: string;
  /** Step has motion-recorded parameter locks. */
  locked: boolean;
  /** Empty step covered by an earlier note's length (tie). */
  tie: boolean;
  /** RING hit (rings until the next hit or rest). */
  ring: boolean;
  /** Rest marker. */
  rest: boolean;
  /** SLIDE: the previous held note glides into this one. */
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
const SLOT_W = 42;
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
      // SLIDE: a low bar from the previous cell into this note.
      if (cell.slide) {
        const gap = CELL_GAP + (i % 4 === 0 ? GROUP_GAP : 0);
        s.rect(x - gap - 3, y + LANE_H - 1, gap + 4, 2, head ? INK.warn : INK.hi);
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
  const ky = LANE_Y + 6 * (LANE_H + LANE_GAP) + 2;
  s.rect(0, ky - 2, SCREEN_W, 1, INK.dim);
  for (let i = 0; i < 12; i++) {
    const slot = v.slots[i];
    const x = 2 + (i % 6) * SLOT_W;
    const y = ky + Math.floor(i / 6) * 23;
    const touched = i === v.touchedSlot;
    if (touched || slot?.highlight) s.rect(x - 1, y - 1, SLOT_W - 1, 22, touched ? INK.dim : INK.shade);
    if (!slot) continue;
    s.text(x, y + 1, fit(slot.name, SLOT_W - 3), touched ? INK.hi : INK.mid);
    s.text(x, y + 8, fit(slot.valueText, SLOT_W - 3), INK.hi);
    s.rect(x, y + 16, SLOT_W - 5, 2, INK.dim);
    s.rect(x, y + 16, Math.round((SLOT_W - 5) * slot.norm), 2, touched ? INK.hi : INK.mid);
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

  // 12 knobs, laid out like the panel (2 rows of 6).
  for (let i = 0; i < 12; i++) {
    const slot = v.slots[i];
    const x = 2 + (i % 6) * SLOT_W;
    const y = 22 + Math.floor(i / 6) * 47;
    const touched = i === v.touchedSlot;
    if (touched) s.rect(x - 1, y - 1, SLOT_W - 1, 45, INK.dim);
    if (!slot) {
      s.text(x + 17, y + 18, '-', INK.dim);
      continue;
    }
    s.text(x, y + 1, fit(slot.name, SLOT_W - 3), touched ? INK.hi : INK.mid);
    drawKnob(s, x + 19, y + 19, 9, slot.norm, touched);
    const big = textWidth(slot.valueText, 2) <= SLOT_W - 9;
    if (big) s.text(x, y + 32, slot.valueText, INK.hi, 2);
    else s.text(x, y + 35, fit(slot.valueText, SLOT_W - 3), INK.hi);
  }

  drawFooter(s, v, v.liveLabel, v.chordLabel);
}
