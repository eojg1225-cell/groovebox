/**
 * On-screen knob: an absolute control with fixed limits, 0-127 (or finer, e.g. TEMPO),
 * drawn with a 270-degree sweep and value arc. Vertical drag (multi-touch safe via
 * pointer capture) sets it, faster the quicker the finger moves (slow = fine, as before;
 * a quick swipe covers the whole range); double-tap / double-click resets to default.
 *
 * The mouse wheel instead sends relative ENCODER steps (+1/-1), the same message a
 * physical rotary encoder will send on the hardware, so that path is exercised too.
 */
import { localY } from './orientation';
import { KNOB_SPEEDS, deviceSettings } from '../storage/settings';

/** Drag speed (design px per ms) below which the knob moves 1:1; above it, it speeds up. */
const ACCEL_FROM = 0.15;
/** Extra gain per px/ms above ACCEL_FROM, and the most it can reach. */
const ACCEL_GAIN = 4;
const ACCEL_MAX = 6;
/** Smoothing of the measured speed (ms), so one jumpy event doesn't fling the knob. */
const SPEED_SMOOTH_MS = 40;
const DOUBLE_TAP_MS = 300;
const SWEEP_DEG = 270;

export class Knob {
  readonly el: HTMLElement;
  private readonly cap: HTMLElement;
  private readonly arc: SVGCircleElement;
  private readonly labelEl: HTMLElement;
  private enabled = true;
  /** Current position in steps, 0..steps. */
  private pos: number;
  private dragPointer: number | null = null;
  private lastY = 0;
  private lastT = 0;
  private speed = 0;
  /** Position while dragging, unrounded (so slow movement still adds up). */
  private dragPos = 0;
  private lastTap = -Infinity;

  /**
   * @param steps resolution: 127 = MIDI-style 0-127 (default).
   * onChange receives the normalised value (pos / steps); onTurn receives encoder deltas.
   */
  constructor(
    readonly id: string,
    label: string,
    private defaultNorm: number,
    private readonly onChange: (id: string, value: number) => void,
    private readonly onTurn: (id: string, delta: number) => void,
    readonly steps = 127,
  ) {
    this.pos = Math.round(defaultNorm * steps);
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
    this.cap = el.querySelector('.knob-cap') as HTMLElement;
    this.arc = el.querySelector('.knob-arc') as SVGCircleElement;
    this.el = el;

    const body = el.querySelector('.knob-body') as HTMLElement;
    body.addEventListener('pointerdown', (e) => this.onDown(e, body));
    body.addEventListener('pointermove', (e) => this.onMove(e));
    body.addEventListener('pointerup', (e) => this.onUp(e));
    body.addEventListener('pointercancel', (e) => this.onUp(e));
    body.addEventListener('lostpointercapture', (e) => this.onUp(e));
    body.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.render();
  }

  /** Where a double tap goes (normalised); away from it the knob is drawn yellow. */
  get defaultValue(): number {
    return this.defaultNorm;
  }

  set defaultValue(value: number) {
    this.defaultNorm = value;
    this.markChanged();
  }

  setLabel(label: string): void {
    if (this.labelEl.textContent !== label) this.labelEl.textContent = label;
  }

  /** A disabled knob ignores input and is drawn dimmed (e.g. unused slot on a page). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.el.classList.toggle('disabled', !enabled);
    this.markChanged();
    if (!enabled) this.dragPointer = null;
  }

  get(): number {
    return this.pos / this.steps;
  }

  /** Set (normalised 0..1) without emitting. */
  set(value: number): void {
    const pos = Math.round(Math.min(1, Math.max(0, value)) * this.steps);
    if (pos === this.pos) return;
    this.pos = pos;
    this.render();
  }

  /** Away from its default (e.g. a SOUND knob off its TIMBRE value): drawn yellow. */
  private markChanged(): void {
    this.el?.classList.toggle('changed', this.enabled && this.pos !== Math.round(this.defaultNorm * this.steps));
  }

  private moveTo(pos: number): void {
    const p = Math.round(Math.min(this.steps, Math.max(0, pos)));
    if (p === this.pos) return;
    this.pos = p;
    this.render();
    this.onChange(this.id, p / this.steps);
  }

  private onDown(e: PointerEvent, body: HTMLElement): void {
    if (!this.enabled || this.dragPointer !== null) return; // one finger per knob
    e.preventDefault();
    const now = performance.now();
    if (now - this.lastTap < DOUBLE_TAP_MS) {
      this.lastTap = -Infinity;
      this.moveTo(this.defaultValue * this.steps);
      return;
    }
    this.lastTap = now;
    this.dragPointer = e.pointerId;
    this.lastY = localY(e);
    this.lastT = e.timeStamp;
    this.speed = 0;
    this.dragPos = this.pos;
    body.setPointerCapture(e.pointerId);
    this.el.classList.add('active');
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointer) return;
    e.preventDefault();
    const y = localY(e);
    const dy = this.lastY - y;
    const dt = Math.max(1, e.timeStamp - this.lastT);
    this.lastY = y;
    this.lastT = e.timeStamp;
    const k = Math.min(1, dt / SPEED_SMOOTH_MS);
    this.speed += (Math.abs(dy) / dt - this.speed) * k;
    // TOUCH SETTINGS: KNOB SPEED = pixels of slow drag for the full range, KNOB ACCEL on / off.
    const accel = deviceSettings.knobAccel ? Math.min(ACCEL_MAX, 1 + Math.max(0, this.speed - ACCEL_FROM) * ACCEL_GAIN) : 1;
    const gain = e.shiftKey ? 0.25 : accel;
    const fullRange = KNOB_SPEEDS[deviceSettings.knobSpeed].px;
    this.dragPos = Math.min(this.steps, Math.max(0, this.dragPos + (dy / fullRange) * gain * this.steps));
    this.moveTo(this.dragPos);
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointer) return;
    this.dragPointer = null;
    this.el.classList.remove('active');
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.enabled) return;
    this.onTurn(this.id, e.deltaY < 0 ? 1 : -1);
  }

  private render(): void {
    const v = this.pos / this.steps;
    this.cap.style.transform = `rotate(${-SWEEP_DEG / 2 + v * SWEEP_DEG}deg)`;
    this.arc.style.strokeDasharray = `${v * SWEEP_DEG} 360`;
    this.markChanged();
  }
}
