/**
 * On-screen rotary ENCODER (continuous rotation, no end stops), as on the planned
 * hardware: turning changes the value relatively; the value itself is shown on the pixel
 * screen. Vertical drag (multi-touch safe via pointer capture), mouse wheel, double-tap /
 * double-click resets to default. Value is normalised 0..1.
 */
import { localY } from './orientation';

// Pixels of vertical drag for the full range (larger = less sensitive).
const DRAG_PIXELS_FULL_RANGE = 400;
/** Visual rotation per pixel of drag; the cap keeps turning past the value's limits. */
const DEGREES_PER_PIXEL = 0.9;
const DOUBLE_TAP_MS = 300;

export class Knob {
  readonly el: HTMLElement;
  private readonly cap: HTMLElement;
  private readonly labelEl: HTMLElement;
  private enabled = true;
  private value: number;
  private angle = 0;
  private dragPointer: number | null = null;
  private lastY = 0;
  private lastTap = -Infinity;

  constructor(
    readonly id: string,
    label: string,
    public defaultValue: number,
    private readonly onChange: (id: string, value: number) => void,
  ) {
    this.value = defaultValue;
    const el = document.createElement('div');
    el.className = 'knob';
    el.innerHTML = `
      <div class="knob-body">
        <div class="knob-ticks"></div>
        <div class="knob-cap"><div class="knob-indicator"></div></div>
      </div>
      <div class="knob-label"></div>`;
    this.labelEl = el.querySelector('.knob-label') as HTMLElement;
    this.labelEl.textContent = label;
    this.cap = el.querySelector('.knob-cap') as HTMLElement;
    this.el = el;

    const body = el.querySelector('.knob-body') as HTMLElement;
    body.addEventListener('pointerdown', (e) => this.onDown(e, body));
    body.addEventListener('pointermove', (e) => this.onMove(e));
    body.addEventListener('pointerup', (e) => this.onUp(e));
    body.addEventListener('pointercancel', (e) => this.onUp(e));
    body.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  setLabel(label: string): void {
    if (this.labelEl.textContent !== label) this.labelEl.textContent = label;
  }

  /** A disabled knob ignores input and is drawn dimmed (e.g. unused slot on a page). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.el.classList.toggle('disabled', !enabled);
    if (!enabled) this.dragPointer = null;
  }

  get(): number {
    return this.value;
  }

  /** Set the value without emitting. An encoder has no position, so nothing moves. */
  set(value: number): void {
    this.value = Math.min(1, Math.max(0, value));
  }

  /** Turn by a number of pixels of drag (positive = clockwise / up). */
  private turn(pixels: number, fine: boolean): void {
    this.angle += pixels * DEGREES_PER_PIXEL * (fine ? 0.2 : 1);
    this.cap.style.transform = `rotate(${this.angle}deg)`;
    const v = Math.min(1, Math.max(0, this.value + (pixels / DRAG_PIXELS_FULL_RANGE) * (fine ? 0.2 : 1)));
    if (v === this.value) return;
    this.value = v;
    this.onChange(this.id, v);
  }

  private onDown(e: PointerEvent, body: HTMLElement): void {
    if (!this.enabled || this.dragPointer !== null) return; // one finger per knob
    e.preventDefault();
    const now = performance.now();
    if (now - this.lastTap < DOUBLE_TAP_MS) {
      this.lastTap = -Infinity;
      if (this.value !== this.defaultValue) {
        this.value = this.defaultValue;
        this.onChange(this.id, this.value);
      }
      return;
    }
    this.lastTap = now;
    this.dragPointer = e.pointerId;
    this.lastY = localY(e);
    body.setPointerCapture(e.pointerId);
    this.el.classList.add('active');
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointer) return;
    e.preventDefault();
    const y = localY(e);
    this.turn(this.lastY - y, e.shiftKey);
    this.lastY = y;
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointer) return;
    this.dragPointer = null;
    this.el.classList.remove('active');
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.enabled) return;
    this.turn(-Math.sign(e.deltaY) * 4, e.shiftKey);
  }
}
