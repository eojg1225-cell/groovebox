/**
 * On-screen knob: an absolute control with fixed limits, 0-127 (or finer, e.g. TEMPO),
 * drawn with a 270-degree sweep and value arc. Vertical drag (multi-touch safe via
 * pointer capture) sets it; double-tap / double-click resets to default.
 *
 * The mouse wheel instead sends relative ENCODER steps (+1/-1), the same message a
 * physical rotary encoder will send on the hardware, so that path is exercised too.
 */
import { localY } from './orientation';

/** Pixels of vertical drag for the full range (larger = less sensitive). */
const DRAG_PIXELS_FULL_RANGE = 400;
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
  private dragStartY = 0;
  private dragStartPos = 0;
  private lastTap = -Infinity;

  /**
   * @param steps resolution: 127 = MIDI-style 0-127 (default).
   * onChange receives the normalised value (pos / steps); onTurn receives encoder deltas.
   */
  constructor(
    readonly id: string,
    label: string,
    public defaultValue: number,
    private readonly onChange: (id: string, value: number) => void,
    private readonly onTurn: (id: string, delta: number) => void,
    readonly steps = 127,
  ) {
    this.pos = Math.round(defaultValue * steps);
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
    return this.pos / this.steps;
  }

  /** Set (normalised 0..1) without emitting. */
  set(value: number): void {
    const pos = Math.round(Math.min(1, Math.max(0, value)) * this.steps);
    if (pos === this.pos) return;
    this.pos = pos;
    this.render();
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
    this.dragStartY = localY(e);
    this.dragStartPos = this.pos;
    body.setPointerCapture(e.pointerId);
    this.el.classList.add('active');
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId !== this.dragPointer) return;
    e.preventDefault();
    const fine = e.shiftKey ? 0.25 : 1;
    const travel = ((this.dragStartY - localY(e)) / DRAG_PIXELS_FULL_RANGE) * fine;
    this.moveTo(this.dragStartPos + travel * this.steps);
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
  }
}
