/**
 * The panel is designed landscape. On a portrait screen it is drawn rotated 90 degrees
 * clockwise, so "up" on the panel points to the right of the screen. Widgets that read
 * drag direction use localY() to stay in panel coordinates.
 */
let rotated = false;

export function setRotated(value: boolean): void {
  rotated = value;
}

export function isRotated(): boolean {
  return rotated;
}

/** Pointer position along the panel's vertical axis (grows downward on the panel). */
export function localY(e: { clientX: number; clientY: number }): number {
  return rotated ? -e.clientX : e.clientY;
}
