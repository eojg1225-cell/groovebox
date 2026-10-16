/**
 * On-screen knob: vertical drag (multi-touch safe via pointer capture), mouse wheel,
 * double-tap / double-click to reset. Value is normalised 0..1.
 */
import { localY } from './orientation';

// Pixels of vertical drag for the full range (larger = less sensitive).
const DRAG_PIXELS_FULL_RANGE = 400;
const DOUBLE_TAP_MS = 300;
const SWEEP_DEG = 270;

export class Knob {
  readonly el: HTMLElement;
  private readonly indicator: HTMLElement;
  private readonly arc: SVGCircleElement;
  private readonly labelEl: HTMLElement;
  private enabled = true;
  private value: number;
  private dragPointer: number | null = null;
  private dragStartY = 0;
  private dragStartValue = 0;
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
        <svg class="knob-ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="knob-track" cx="50" cy="50" r="44" pathLength="360"/>
          <circle class="knob-arc" cx="50" cy="50" r="44" pathLength="360"/>
        </svg>
        <div class="knob-cap"><div class="knob-indicator"></div></div>
      </div>
      <div class="knob-label"></div>`;
    this.labelEl = el.querySelector('.knob-label') as HTMLElement;
    this.labelEl.textContent = label;
    this.indicator = el.querySelector('.knob-cap') as HTMLElement;
    this.arc = el.querySelector('.knob-arc') as SVGCircleElement;
    this.el = el;

    const body = el.querySelector('.knob-body') as HTMLElement;
    body.addEventListener('pointerdown', (e) => this.onDown(e, body));
    body.addEventListener('pointermove', (e) => this.onMove(e));
    body.addEventListener('pointerup', (e) => this.onUp(e));
    body.addEventListener('pointercancel', (e) => this.onUp(e));
    body.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.render();
  }

  setLabel(label: string): void {
    this.labelEl.textContent = label;
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

  /** Set without emitting. */
  set(value: number): void {
    this.value = Math.min(1, Math.max(0, value));
    this.render();
  }

  private change(value: number): void {
    const v = Math.min(1, Math.max(0, value));
    if (v === this.value) return;
    this.value = v;
    this.render();
    this.onChange(this.id, v);
  }

  private onDown(e: PointerEvent, body: HTMLElement): void {
    if (!this.enabled || this.dragPointer !== null) return; // one finger per knob
    e.preventDefault();
    const now = performance.now();
    if (now - this.lastTap < DOUBLE_TAP_MS) {
      this.lastTap = -Infinity;
      this.change(this.defaultValue);
      return;
    }
    this.lastTap = now;
    this.dragPointer = e.pointerId;
    this.dragStartY = localY(e);
    this.dragStartValue = this.value;
    body.setPointerCapture(e.pointerId);
    this.el.classList.add('active');
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointer) return;
    e.preventDefault();
    const fine = e.shiftKey ? 0.2 : 1;
    const dy = (this.dragStartY - localY(e)) / DRAG_PIXELS_FULL_RANGE;
    this.change(this.dragStartValue + dy * fine);
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointer) return;
    this.dragPointer = null;
    this.el.classList.remove('active');
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.enabled) return;
    const step = e.shiftKey ? 0.002 : 0.01;
    this.change(this.value - Math.sign(e.deltaY) * step);
  }

  private render(): void {
    const deg = -SWEEP_DEG / 2 + this.value * SWEEP_DEG;
    this.indicator.style.transform = `rotate(${deg}deg)`;
    // Arc drawn from the 7:30 position clockwise.
    this.arc.style.strokeDasharray = `${this.value * SWEEP_DEG} 360`;
  }
}
