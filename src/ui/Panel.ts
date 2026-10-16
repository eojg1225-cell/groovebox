/**
 * On-screen hardware panel: the first ControlSurface implementation.
 * Fixed design-size box scaled to fit the window (landscape first):
 *
 *   [ pixel screen        ] [ channel select / mute, pattern, page ]
 *   [ 8 parameter knobs                                             ]
 *   [ function row: mode, motion, dynamics, length, page, ... ] [      ]
 *   [ 16-button strip (steps or keyboard)                      ] [ PLAY ]
 *
 * Control ids: ch1..ch6, mute1..mute6, patA/patB/patC, page:<name>, step1..step16,
 * play, plus the function row ids in FUNCTION_ROW; knobs k1..k8.
 */
import { ControlEmitter, type ControlListener, type ControlSurface } from '../controls/ControlSurface';
import { Knob } from './Knob';

export const DESIGN_W = 1200;
export const DESIGN_H = 750;
export const KNOB_COUNT = 8;
export const STEP_BUTTONS = 16;

/** Function row: groups of [id, label] (labels may contain <small> lines). */
export const FUNCTION_ROW: readonly (readonly [string, string])[][] = [
  [['mode:record', 'RECORD'], ['mode:play', 'PLAY<small>MODE</small>']],
  [['motion', 'MOTION<small>REC</small>']],
  [['dyn:accent', 'ACCENT'], ['dyn:ghost', 'GHOST']],
  [['len', '16<small>STEPS</small>'], ['steppage', '1-16<small>VIEW</small>']],
  [['oct-', 'OCT −'], ['oct+', 'OCT +']],
  [['cur-', '◀'], ['cur+', '▶'], ['rest', 'REST']],
];

export interface PanelConfig {
  channels: number;
  activeChannels: number;
  patterns: readonly string[];
  pages: readonly { id: string; label: string }[];
}

export class Panel implements ControlSurface {
  readonly root: HTMLElement;
  readonly screenCanvas: HTMLCanvasElement;
  private readonly emitter = new ControlEmitter();
  private readonly knobs = new Map<string, Knob>();
  private readonly buttons = new Map<string, HTMLElement>();
  private readonly disabled = new Set<string>();

  constructor(host: HTMLElement, cfg: PanelConfig) {
    const root = document.createElement('div');
    root.className = 'panel';
    root.style.width = `${DESIGN_W}px`;
    root.style.height = `${DESIGN_H}px`;
    root.innerHTML = `
      <div class="panel-top">
        <div class="screen-bezel"><canvas class="screen"></canvas></div>
        <div class="side">
          <div class="group-label">CHANNEL</div>
          <div class="row channels"></div>
          <div class="row mutes"></div>
          <div class="group-label">PATTERN</div>
          <div class="row patterns"></div>
          <div class="group-label">KNOBS</div>
          <div class="row pages"></div>
        </div>
      </div>
      <div class="knob-row"></div>
      <div class="panel-bottom">
        <div class="bottom-main">
          <div class="function-row"></div>
          <div class="steps"></div>
        </div>
        <div class="play-area"></div>
      </div>`;
    host.appendChild(root);
    this.root = root;
    this.screenCanvas = root.querySelector('.screen') as HTMLCanvasElement;
    const q = (sel: string) => root.querySelector(sel) as HTMLElement;

    for (let ch = 1; ch <= cfg.channels; ch++) {
      const enabled = ch <= cfg.activeChannels;
      q('.channels').appendChild(this.makeButton(`ch${ch}`, String(ch), 'btn ch', enabled));
      q('.mutes').appendChild(this.makeButton(`mute${ch}`, 'MUTE', 'btn mute', enabled));
    }
    for (const p of cfg.patterns) q('.patterns').appendChild(this.makeButton(`pat${p}`, p, 'btn pat'));
    for (const p of cfg.pages) q('.pages').appendChild(this.makeButton(`page:${p.id}`, p.label, 'btn page'));

    const knobRow = q('.knob-row');
    for (let i = 1; i <= KNOB_COUNT; i++) {
      const knob = new Knob(`k${i}`, '', 0.5, (id, value) => this.emitter.emit({ type: 'knob', id, value }));
      this.knobs.set(knob.id, knob);
      knobRow.appendChild(knob.el);
    }

    const fnRow = q('.function-row');
    for (const group of FUNCTION_ROW) {
      const g = document.createElement('div');
      g.className = 'fn-group';
      for (const [id, label] of group) g.appendChild(this.makeButton(id, label, 'btn fn'));
      fnRow.appendChild(g);
    }

    const steps = q('.steps');
    for (let i = 1; i <= STEP_BUTTONS; i++) {
      const b = this.makeButton(`step${i}`, String(i), 'step');
      if ((i - 1) % 4 === 0) b.classList.add('beat');
      steps.appendChild(b);
    }
    q('.play-area').appendChild(this.makeButton('play', 'PLAY', 'btn play'));

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

  /** Configure a knob slot: label and default, or null to disable the slot. */
  configureKnob(id: string, slot: { label: string; value: number; defaultValue: number } | null): void {
    const k = this.knobs.get(id);
    if (!k) return;
    k.setEnabled(slot !== null);
    k.setLabel(slot?.label ?? '');
    if (slot) {
      k.defaultValue = slot.defaultValue;
      k.set(slot.value);
    } else {
      k.set(0);
    }
  }

  setButtonLit(id: string, lit: boolean): void {
    this.setButtonFlag(id, 'lit', lit);
  }

  setButtonFlag(id: string, flag: string, on: boolean): void {
    const b = this.buttons.get(id);
    if (b && b.classList.contains(flag) !== on) b.classList.toggle(flag, on);
  }

  /** Greys a button out and ignores presses on it. */
  setButtonEnabled(id: string, enabled: boolean): void {
    if (enabled) this.disabled.delete(id);
    else this.disabled.add(id);
    this.setButtonFlag(id, 'disabled', !enabled);
  }

  setButtonText(id: string, html: string): void {
    const b = this.buttons.get(id);
    if (b && b.innerHTML !== html) b.innerHTML = html;
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

  private press(id: string, pressed: boolean): void {
    if (!pressed) this.buttons.get(id)?.classList.remove('down');
    if (this.disabled.has(id)) return;
    if (pressed) this.buttons.get(id)?.classList.add('down');
    this.emitter.emit({ type: 'button', id, pressed });
  }

  private makeButton(id: string, label: string, cls: string, enabled = true): HTMLElement {
    const b = document.createElement('div');
    b.className = cls;
    b.innerHTML = label;
    b.setAttribute('role', 'button');
    if (!enabled) {
      b.classList.add('disabled');
      this.disabled.add(id);
    }
    const pointers = new Set<number>();
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (pointers.size === 0) this.press(id, true);
      pointers.add(e.pointerId);
      b.setPointerCapture(e.pointerId);
    });
    const release = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId) || pointers.size > 0) return;
      this.press(id, false);
    };
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    this.buttons.set(id, b);
    return b;
  }

  /**
   * Space: play. 1-6: select channel, Shift+1-6: mute.
   * Q..I: steps 1-8, A..K: steps 9-16.
   */
  private installKeyboard(): void {
    const stepKeys = 'QWERTYUIASDFGHJK';
    const toId = (e: KeyboardEvent): string | null => {
      if (e.code === 'Space') return 'play';
      const digit = /^Digit([1-6])$/.exec(e.code);
      if (digit) return e.shiftKey ? `mute${digit[1]}` : `ch${digit[1]}`;
      const key = /^Key([A-Z])$/.exec(e.code);
      if (key) {
        const i = stepKeys.indexOf(key[1]);
        if (i >= 0) return `step${i + 1}`;
      }
      return null;
    };
    const held = new Map<string, string>();
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const id = toId(e);
      if (!id) return;
      e.preventDefault();
      if (held.has(e.code)) return;
      held.set(e.code, id);
      this.press(id, true);
    });
    window.addEventListener('keyup', (e) => {
      const id = held.get(e.code);
      if (!id) return;
      held.delete(e.code);
      this.press(id, false);
    });
  }
}
