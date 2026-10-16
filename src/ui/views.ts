/**
 * What the pixel screen shows. Pure drawing from a plain view-model object.
 */
import { INK, PixelScreen, SCREEN_W } from './screen';

export interface LaneView {
  name: string;
  steps: boolean[]; // the pattern currently heard (or being edited, for the selected lane)
  playhead: number; // -1 when stopped
  muted: boolean;
  selected: boolean;
}

export interface KnobSlotView {
  name: string;
  valueText: string;
  norm: number;
}

export interface ScreenView {
  channelLabel: string; // e.g. "CH1 KICK"
  patternLabel: string; // e.g. "PAT A" or "PAT A>B"
  bpmText: string;
  playing: boolean;
  lanes: LaneView[];
  pageName: string;
  slots: (KnobSlotView | null)[];
  touchedSlot: number; // -1 for none
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

export function drawMainView(s: PixelScreen, v: ScreenView): void {
  s.clear();

  // Header
  s.rect(0, 0, SCREEN_W, 9, INK.dim);
  s.text(2, 2, `${v.channelLabel}  ${v.patternLabel}`, INK.hi);
  s.textRight(SCREEN_W - 12, 2, `${v.bpmText} BPM`, INK.hi);
  if (v.playing) {
    // play triangle
    for (let i = 0; i < 4; i++) s.rect(SCREEN_W - 8 + i, 1 + i, 1, 7 - i * 2, INK.hi);
  } else {
    s.rect(SCREEN_W - 8, 2, 5, 5, INK.mid);
  }

  // Step lanes
  v.lanes.forEach((lane, li) => {
    const y = LANE_Y + li * (LANE_H + LANE_GAP);
    if (lane.selected) s.rect(0, y - 1, GRID_X - 3, LANE_H + 2, INK.mid);
    s.text(2, y + 1, lane.name, lane.selected ? INK.bg : lane.muted ? INK.dim : INK.mid);
    for (let i = 0; i < 16; i++) {
      const x = GRID_X + i * (CELL + CELL_GAP) + Math.floor(i / 4) * GROUP_GAP;
      const on = lane.steps[i];
      const head = lane.playhead === i;
      let color: string = on ? (lane.muted ? INK.mid : INK.hi) : INK.dim;
      if (head) color = on ? INK.warn : INK.mid;
      if (on || head) s.rect(x, y, CELL, LANE_H, color);
      else s.rect(x, y + LANE_H - 2, CELL, 2, color);
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
  s.text(2, fy, `KNOBS: ${v.pageName}`, INK.mid);
  // Mini output meter
  const m = Math.max(0, Math.min(1, v.peak <= 0 ? 0 : (20 * Math.log10(v.peak) + 48) / 48));
  s.rect(96, fy + 1, 50, 3, INK.dim);
  s.rect(96, fy + 1, Math.round(50 * m), 3, v.peak >= 0.99 ? INK.warn : INK.hi);
  if (!v.footerAlert || v.blink) s.textRight(SCREEN_W - 2, fy, v.footerRight, v.footerAlert ? INK.warn : INK.mid);
}
