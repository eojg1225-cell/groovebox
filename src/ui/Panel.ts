/**
 * On-screen hardware panel: the first ControlSurface implementation.
 * Lays out the pixel screen, transport, knob bank and a tap pad in a fixed design-size
 * box that is scaled to fit the window (landscape first).
 */
import { ControlEmitter, type ControlListener, type ControlSurface } from '../controls/ControlSurface';
import { Knob } from './Knob';

export const DESIGN_W = 1200;
export const DESIGN_H = 720;

export interface KnobDef {
  id: string;
  label: string;
  defaultValue: number;
}

export class Panel implements ControlSurface {
  readonly root: HTMLElement;
  readonly screenCanvas: HTMLCanvasElement;
  private readonly emitter = new ControlEmitter();
  private readonly knobs = new Map<string, Knob>();
  private readonly buttons = new Map<string, HTMLElement>();

  constructor(host: HTMLElement, knobDefs: KnobDef[]) {
    const root = document.createElement('div');
    root.className = 'panel';
    root.style.width = `${DESIGN_W}px`;
    root.style.height = `${DESIGN_H}px`;
    root.innerHTML = `
      <div class="panel-top">
        <div class="screen-bezel"><canvas class="screen"></canvas></div>
        <div class="transport"></div>
      </div>
      <div class="panel-bottom">
        <div class="knob-bank"></div>
        <div class="pad-area"></div>
      </div>`;
    host.appendChild(root);
    this.root = root;
    this.screenCanvas = root.querySelector('.screen') as HTMLCanvasElement;

    const transport = root.querySelector('.transport') as HTMLElement;
    transport.appendChild(this.makeButton('play', 'PLAY', 'btn'));
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Space: play · T: tap · drag knobs vertically · double-tap resets';
    transport.appendChild(hint);

    const bank = root.querySelector('.knob-bank') as HTMLElement;
    for (const def of knobDefs) {
      const knob = new Knob(def.id, def.label, def.defaultValue, (id, value) =>
        this.emitter.emit({ type: 'knob', id, value }),
      );
      this.knobs.set(def.id, knob);
      bank.appendChild(knob.el);
    }

    const padArea = root.querySelector('.pad-area') as HTMLElement;
    padArea.appendChild(this.makeButton('tap', 'TAP', 'pad'));

    this.installKeyboard();
    this.fit();
    window.addEventListener('resize', () => this.fit());
    window.addEventListener('orientationchange', () => this.fit());
  }

  subscribe(listener: ControlListener): () => void {
    return this.emitter.subscribe(listener);
  }

  setKnob(id: string, value: number): void {
    this.knobs.get(id)?.set(value);
  }

  setButtonLit(id: string, lit: boolean): void {
    this.buttons.get(id)?.classList.toggle('lit', lit);
  }

  knobValue(id: string): number {
    return this.knobs.get(id)?.get() ?? 0;
  }

  /** Scale the fixed design box to fit the viewport. */
  fit(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(vw / DESIGN_W, vh / DESIGN_H);
    const x = (vw - DESIGN_W * scale) / 2;
    const y = (vh - DESIGN_H * scale) / 2;
    this.root.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  private makeButton(id: string, label: string, cls: string): HTMLElement {
    const b = document.createElement('div');
    b.className = cls;
    b.textContent = label;
    b.setAttribute('role', 'button');
    const pointers = new Set<number>();
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (pointers.size === 0) {
        b.classList.add('down');
        this.emitter.emit({ type: 'button', id, pressed: true });
      }
      pointers.add(e.pointerId);
      b.setPointerCapture(e.pointerId);
    });
    const release = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId) || pointers.size > 0) return;
      b.classList.remove('down');
      this.emitter.emit({ type: 'button', id, pressed: false });
    };
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    this.buttons.set(id, b);
    return b;
  }

  private installKeyboard(): void {
    const keyToButton: Record<string, string> = { Space: 'play', KeyT: 'tap', Enter: 'tap' };
    const held = new Set<string>();
    window.addEventListener('keydown', (e) => {
      const id = keyToButton[e.code];
      if (!id) return;
      e.preventDefault();
      if (held.has(e.code)) return;
      held.add(e.code);
      this.buttons.get(id)?.classList.add('down');
      this.emitter.emit({ type: 'button', id, pressed: true });
    });
    window.addEventListener('keyup', (e) => {
      const id = keyToButton[e.code];
      if (!id || !held.delete(e.code)) return;
      this.buttons.get(id)?.classList.remove('down');
      this.emitter.emit({ type: 'button', id, pressed: false });
    });
  }
}
