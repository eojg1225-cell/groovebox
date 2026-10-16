/**
 * What the pixel screen shows. Pure drawing from a plain view-model object.
 */
import { INK, PixelScreen, SCREEN_W } from './screen';

export interface LaneCell {
  /** none = beyond the pattern length. */
  state: 'none' | 'off' | 'ghost' | 'normal' | 'accent';
  /** Note letter for the selected pitched lane, '' otherwise. */
  note: string;
  /** Step has motion-recorded parameter locks. */
  locked: boolean;
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
}

export interface ScreenView {
  channelLabel: string;
  patternLabel: string;
  stepsLabel: string;
  bpmText: string;
  playing: boolean;
  motion: boolean;
  lanes: LaneView[];
  modeLabel: string;
  pageName: string;
  keyboardLabel: string;
  dynamicLabel: string;
  slots: (KnobSlotView | null)[];
  touchedSlot: number;
  peak: number;
  footerRight: string;
  footerAlert: boolean;
  blink: boolean;
}

const LANE_Y = 13;
const LANE_H = 7;
const LANE_GAP = 2;
const GRID_X = 30;
const CELL = 12;
const CELL_GAP = 1;
const GROUP_GAP = 3;
/** Hit height encodes dynamics: tall accent, medium normal, short ghost. */
const DYN_HEIGHT = { ghost: 3, normal: 5, accent: 7 } as const;

export function drawMainView(s: PixelScreen, v: ScreenView): void {
  s.clear();

  // Header
  s.rect(0, 0, SCREEN_W, 9, INK.dim);
  s.text(2, 2, `${v.channelLabel}  ${v.patternLabel}`, INK.hi);
  s.text(100, 2, v.stepsLabel, INK.mid);
  if (v.motion && (v.blink || !v.playing)) s.text(140, 2, 'MOTION', INK.warn);
  s.textRight(SCREEN_W - 12, 2, `${v.bpmText} BPM`, INK.hi);
  if (v.playing) {
    for (let i = 0; i < 4; i++) s.rect(SCREEN_W - 8 + i, 1 + i, 1, 7 - i * 2, INK.hi);
  } else {
    s.rect(SCREEN_W - 8, 2, 5, 5, INK.mid);
  }

  // Step lanes
  v.lanes.forEach((lane, li) => {
    const y = LANE_Y + li * (LANE_H + LANE_GAP);
    if (lane.selected) s.rect(0, y - 1, GRID_X - 3, LANE_H + 2, INK.mid);
    s.text(2, y + 1, lane.name, lane.selected ? INK.bg : lane.muted ? INK.dim : INK.mid);
    lane.cells.forEach((cell, i) => {
      const x = GRID_X + i * (CELL + CELL_GAP) + Math.floor(i / 4) * GROUP_GAP;
      if (cell.state === 'none') return;
      const head = lane.playhead === i;
      if (cell.state === 'off') {
        s.rect(x, y + LANE_H - 1, CELL, 1, head ? INK.hi : INK.dim);
      } else if (cell.note) {
        // Pitched lane being edited: full cells with the note letter; brightness = dynamic.
        const color = head ? INK.warn : cell.state === 'ghost' ? INK.mid : INK.hi;
        s.rect(x, y, CELL, LANE_H, color);
        s.text(x + 1, y + 1, cell.note, INK.bg);
      } else {
        const h = DYN_HEIGHT[cell.state];
        const color = head ? INK.warn : lane.muted ? INK.mid : INK.hi;
        s.rect(x, y + LANE_H - h, CELL, h, color);
      }
      if (cell.locked) s.rect(x + CELL - 2, y - 1, 2, 1, INK.warn);
      if (lane.cursor === i) s.frame(x - 1, y - 1, CELL + 2, LANE_H + 2, INK.warn);
    });
    if (lane.cursor >= 0 && lane.cells[lane.cursor].state === 'off') {
      const x = GRID_X + lane.cursor * (CELL + CELL_GAP) + Math.floor(lane.cursor / 4) * GROUP_GAP;
      s.frame(x - 1, y - 1, CELL + 2, LANE_H + 2, INK.warn);
    }
  });

  // Knob page
  const py = LANE_Y + 4 * (LANE_H + LANE_GAP) + 3;
  s.rect(0, py, SCREEN_W, 1, INK.dim);
  for (let i = 0; i < 8; i++) {
    const slot = v.slots[i];
    const x = (i % 4) * 64;
    const y = py + 3 + Math.floor(i / 4) * 30;
    const touched = i === v.touchedSlot;
    if (touched) s.rect(x + 1, y, 62, 28, INK.dim);
    s.text(x + 3, y + 2, `${i + 1}`, touched ? INK.mid : INK.dim);
    if (!slot) continue;
    s.text(x + 9, y + 2, slot.name, touched ? INK.hi : INK.mid);
    s.text(x + 3, y + 10, slot.valueText, INK.hi, 2);
    s.rect(x + 3, y + 23, 56, 2, INK.bg);
    s.rect(x + 3, y + 23, Math.round(56 * slot.norm), 2, touched ? INK.hi : INK.mid);
  }

  // Footer
  const fy = 119;
  s.rect(0, fy - 3, SCREEN_W, 1, INK.dim);
  s.text(2, fy, `${v.modeLabel} ${v.pageName}`, INK.mid);
  s.text(50, fy, v.keyboardLabel, INK.mid);
  s.text(86, fy, v.dynamicLabel, INK.warn);
  const m = Math.max(0, Math.min(1, v.peak <= 0 ? 0 : (20 * Math.log10(v.peak) + 48) / 48));
  s.rect(122, fy + 1, 36, 3, INK.dim);
  s.rect(122, fy + 1, Math.round(36 * m), 3, v.peak >= 0.99 ? INK.warn : INK.hi);
  if (!v.footerAlert || v.blink) s.textRight(SCREEN_W - 2, fy, v.footerRight, v.footerAlert ? INK.warn : INK.mid);
}
