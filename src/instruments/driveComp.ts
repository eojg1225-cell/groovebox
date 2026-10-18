import type { SoundKind } from '../engine/project';

/**
 * DRIVE level compensation: DRIVE is for colour, so each track type's output is turned
 * down as DRIVE rises, leaving only a small lift (DRIVE_LIFT_DB at full drive). The cut is
 * fixed by the DRIVE value (not the signal), so turning DRIVE back restores the level, and
 * the track's VOLUME is never touched.
 *
 * DRIVE_RISE: how much louder (dB, RMS) each type gets at DRIVE_POINTS without
 * compensation, measured over its TIMBRE sounds (tests/engine.test.ts checks it).
 */
export const DRIVE_POINTS = [1, 1.5, 2, 3, 4, 6, 8, 12, 20, 40, 100, 200] as const;
export const DRIVE_LIFT_DB = 2.5;

export const DRIVE_RISE: Record<SoundKind, readonly number[]> = {
  kick: [0, 1.2, 2.5, 4.4, 5.6, 7.0, 7.8, 8.8, 9.9, 11.0, 12.2, 12.9],
  snare: [0, 1.3, 2.6, 4.5, 5.9, 7.4, 8.4, 9.5, 10.7, 12.0, 13.3, 14.2],
  hat: [0, 2.2, 4.0, 7.0, 9.1, 12.0, 13.9, 16.2, 18.7, 21.1, 23.4, 24.6],
  perc: [0, 1.5, 2.9, 5.0, 6.5, 8.2, 9.2, 10.4, 11.7, 13.1, 14.5, 15.3],
  // Synths: DRIVE tops out at 100x.
  bass: [0, 3.4, 4.7, 6.7, 7.9, 9.0, 9.5, 9.9, 10.1, 10.3, 10.4, 10.4],
  pad: [0, 4.1, 5.9, 8.6, 10.5, 12.7, 13.8, 14.9, 15.7, 16.3, 16.6, 16.6],
  lead: [0, 4.1, 5.8, 8.6, 10.5, 12.7, 13.9, 15.1, 16.0, 16.6, 16.9, 16.9],
  pluck: [0, 4.0, 5.8, 8.4, 10.1, 12.1, 13.0, 13.9, 14.5, 14.9, 15.2, 15.2],
};

/** Output gain after DRIVE for a type's rise curve (1 = none). */
export function driveCompGain(rise: readonly number[] | undefined, drive: number): number {
  if (!rise || drive <= 1) return 1;
  const pts = DRIVE_POINTS;
  const x = Math.log(Math.min(drive, pts[pts.length - 1]));
  let i = 0;
  while (i < pts.length - 2 && x > Math.log(pts[i + 1])) i++;
  const x0 = Math.log(pts[i]), x1 = Math.log(pts[i + 1]);
  const db = rise[i] + (rise[i + 1] - rise[i]) * Math.min(1, (x - x0) / (x1 - x0));
  const top = rise[rise.length - 1];
  // The whole rise is cut except a share that reaches DRIVE_LIFT_DB at the top.
  const cut = top > DRIVE_LIFT_DB ? db * (1 - DRIVE_LIFT_DB / top) : 0;
  return Math.pow(10, -cut / 20);
}
