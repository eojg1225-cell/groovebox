/**
 * On-screen hardware panel: the first ControlSurface implementation.
 * Fixed design-size box scaled to fit the window; on a portrait screen it is rotated
 * so the instrument is always landscape.
 *
 *   [H] [ pixel screen ] [ MODE: design / record / play | MENU          ] [UNDO ]
 *   [G]                  [ SAVE PATTERN, SAVE/LOAD, CANCEL | MASTER TEMPO ] [CLEAR]
 *   [F]                  [ pages                           |              ] [COPY ]
 *   [E]                  [       VOLUME PAN | FX1 SEND FX2 SEND           ] [RESET]
 *   [D] [ 8 track modules, each: knob / M, channel button, S / knob       ] [ARP  ]
 *   [C]                                                                     [LFO  ]
 *   [B]                                                                     [FX 2 ]
 *   [A]                                                                     [FX 1 ]
 *   [ALT] [ function row / step LEDs / 16-button strip (steps or keyboard) ] [PLAY ]
 *   (the strip's dividers sit under the grooves between knob modules 2-3, 4-5 and 6-7;
 *   the MASTER / TEMPO and track knobs line up with knob modules 7-8 and 5-8)
 *
 * Control ids: mode:record|play|design, menu, ch1..8, mute1..8, solo1..8, cancel, savepattern,
 * saveproject, reset, patA..H (the left column), dpage0..2, fx1 / fx2 (FX 1 / 2), fx3 (ARP),
 * fx4 (LFO), play, clear (held: CLEAR + step / channel), copy (held: COPY + channel = same
 * pattern slot there, COPY + A-H = that pattern of this track),
 * step1..16, function row ids (FUNCTION_ROW); knobs k1..k16 (k1..k8 top row, k9..k16
 * bottom row; module i holds k(i+1) and k(i+9)); mmaster, mtempo (the project's MASTER /
 * TEMPO), mvol, mpan, mfx1, mfx2 (the selected track's VOLUME / PAN / FX1 SEND / FX2 SEND).
 */
import { dimOf } from './colours';
import { ControlEmitter, type ControlListener, type ControlSurface } from '../controls/ControlSurface';
import { Knob } from './Knob';
import { setRotated } from './orientation';

const DESIGN_W = 1364;
const DESIGN_H = 760;
export const KNOB_COUNT = 16;
export const KNOBS_PER_ROW = 8;
export const STEP_BUTTONS = 16;
export const DESIGN_PAGE_BUTTONS = 3;
/** FX 1, FX 2, ARP (fx3: the selected track's ARP view) and the LFO (fx4). */
export const FX_SEND_BUTTONS = 4;
/** The project's knobs (beside the page keys) and the selected track's (over modules 5-8). */
const PROJECT_KNOBS = ['mmaster', 'mtempo'] as const;
const TRACK_KNOBS = ['mvol', 'mpan', 'mfx1', 'mfx2'] as const;

/** PLAY's faces (App sets them): play, pause (playing), stop, and SAVE (in MENU). */
const icon = (path: string) => `<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">${path}</svg>`;
export const PLAY_ICON = icon('<path d="M7 4.5v15l13-7.5z" fill="currentColor"/>');
export const PAUSE_ICON = icon('<path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor"/>');
export const STOP_ICON = icon('<path d="M6 6h12v12H6z" fill="currentColor"/>');
export const SAVE_ICON = icon('<path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>');

export const MODES = [
  { id: 'design', label: 'DESIGN' },
  { id: 'record', label: 'RECORD' },
  { id: 'play', label: 'PLAY' },
] as const;

/**
 * Function row: groups of [id, label] (labels may contain <small> lines); 16 keys, each
 * straight above a strip step. An empty id = a blank key (not wired up).
 */
const FUNCTION_ROW: readonly (readonly [string, string])[][] = [
  [['ring', 'RING'], ['slide', 'SLIDE'], ['dyn:accent', 'ACCENT'], ['dyn:ghost', 'GHOST']],
  [['len', '16<small>STEPS</small>'], ['steppage', 'BAR<small>1/1</small>'], ['speed', 'TIME<small>NORMAL</small>'], ['stepedit', 'STEP<small>EDIT</small>']],
  [['arp', 'ARP'], ['view', 'STRIP<small>KEYS</small>'], ['scale', 'SCALE<small>A MIN</small>'], ['rest', 'REST']],
  [['oct-', 'OCT ▼'], ['oct+', 'OCT ▲'], ['cur-', '◀'], ['cur+', '▶']],
];

interface PanelConfig {
  channels: number;
  patterns: readonly string[];
}

export class Panel implements ControlSurface {
  readonly root: HTMLElement;
  readonly screenCanvas: HTMLCanvasElement;
  private readonly emitter = new ControlEmitter();
  private readonly knobs: Knob[] = [];
  private readonly buttons = new Map<string, HTMLElement>();
  private readonly disabled = new Set<string>();
  private readonly leds: HTMLElement[] = [];
  private readonly modules: HTMLElement[] = [];
  private readonly masterKnobs = new Map<string, Knob>();
  private readonly knobEmit = (id: string, value: number) => this.emitter.emit({ type: 'knob', id, value });
  private readonly encoderEmit = (id: string, delta: number) => this.emitter.emit({ type: 'encoder', id, delta });
  private readonly touchEmit = (id: string, down: boolean) => this.emitter.emit({ type: down ? 'touch' : 'release', id });

  private stripSlide = false;
  private zoom = 0;
  private readonly stepIds = new Map<HTMLElement, string>();
  /** Pointer id -> the step it is pressing now (it may have slid on from where it went down). */
  private readonly stripPointers = new Map<number, string>();
  /** Fingers / mouse buttons down on each button (a button is up when the last one lifts). */
  private readonly buttonPointers = new Map<string, Set<number>>();
  /** Computer keys held (key code -> control id). */
  private readonly heldKeys = new Map<string, string>();

  constructor(host: HTMLElement, cfg: PanelConfig) {
    const root = document.createElement('div');
    root.className = 'panel';
    root.style.width = `${DESIGN_W}px`;
    root.style.height = `${DESIGN_H}px`;
    root.innerHTML = `
      <div class="side-keys left"></div>
      <div class="side-keys right"></div>
      <div class="panel-top">
        <div class="screen-bezel"><canvas class="screen"></canvas></div>
        <div class="side">
          <div class="row modes"></div>
          <div class="lower">
            <div class="lower-rows">
              <div class="row patterns"><div class="save-buttons"></div></div>
              <div class="row pages"><div class="page-buttons"></div></div>
            </div>
            <div class="master-knobs project-knobs"></div>
          </div>
          <div class="row buses"><div class="master-knobs track-knobs"></div></div>
        </div>
      </div>
      <div class="knob-grid"></div>
      <div class="panel-bottom">
        <div class="bottom-main">
          <div class="function-row"></div>
          <div class="leds"></div>
          <div class="steps"></div>
        </div>
      </div>`;
    host.appendChild(root);
    this.root = root;
    this.screenCanvas = root.querySelector('.screen') as HTMLCanvasElement;
    const q = (sel: string) => root.querySelector(sel) as HTMLElement;

    for (const m of MODES) q('.modes').appendChild(this.makeButton(`mode:${m.id}`, m.label, 'btn mode'));
    q('.modes').appendChild(this.makeButton('menu', 'MENU', 'btn mode'));
    q('.save-buttons').appendChild(this.makeButton('savepattern', 'SAVE<small>PATTERN</small>', 'btn save'));
    q('.save-buttons').appendChild(this.makeButton('saveproject', 'SAVE/LOAD<small>PROJECT</small>', 'btn save'));
    q('.save-buttons').appendChild(this.makeButton('cancel', 'CANCEL', 'btn save'));
    for (let i = 0; i < DESIGN_PAGE_BUTTONS; i++) q('.page-buttons').appendChild(this.makeButton(`dpage${i}`, '', 'btn page'));
    // The left column: the pattern keys, A at the bottom.
    for (const p of [...cfg.patterns].reverse()) q('.side-keys.left').appendChild(this.makeButton(`pat${p}`, `<small>PATTERN</small>${p}`, 'btn pat'));
    // The right column: UNDO, CLEAR, COPY, RESET, then ARP, LFO, FX 2, FX 1.
    const right = q('.side-keys.right');
    right.appendChild(this.makeButton('undo', 'UNDO', 'btn side'));
    right.appendChild(this.makeButton('clear', 'CLEAR<small>HOLD</small>', 'btn side'));
    right.appendChild(this.makeButton('copy', 'COPY<small>HOLD</small>', 'btn side'));
    right.appendChild(this.makeButton('reset', 'RESET<small>TO SAVED</small>', 'btn side'));
    for (const i of [3, 4, 2, 1]) right.appendChild(this.makeButton(`fx${i}`, i === 4 ? 'LFO' : i === 3 ? 'ARP' : `FX ${i}`, 'btn side fxsend'));

    // Knob modules, one per track, separated by grooves like a hardware front panel; the
    // track's channel button sits between its two knobs, MUTE left of it, SOLO right.
    const grid = q('.knob-grid');
    for (let i = 1; i <= KNOB_COUNT; i++) {
      this.knobs.push(new Knob(`k${i}`, '', 0.5, this.knobEmit, this.encoderEmit, 127, this.touchEmit));
    }
    for (let m = 0; m < KNOBS_PER_ROW; m++) {
      const module = document.createElement('div');
      module.className = 'knob-module';
      const track = document.createElement('div');
      track.className = 'module-track';
      if (m < cfg.channels) {
        const ch = m + 1;
        track.append(
          this.makeButton(`mute${ch}`, 'M', 'btn mute'),
          this.makeButton(`ch${ch}`, String(ch), 'btn ch'),
          this.makeButton(`solo${ch}`, 'S', 'btn solo'),
        );
      }
      module.append(this.knobs[m].el, track, this.knobs[m + KNOBS_PER_ROW].el);
      grid.appendChild(module);
      this.modules.push(module);
    }

    const fnRow = q('.function-row');
    for (const [id, label] of FUNCTION_ROW.flat()) {
      if (id) {
        fnRow.appendChild(this.makeButton(id, label, 'btn fn'));
      } else {
        const blank = document.createElement('div');
        blank.className = 'btn fn blank';
        fnRow.appendChild(blank);
      }
    }

    const leds = q('.leds');
    const steps = q('.steps');
    for (let i = 1; i <= STEP_BUTTONS; i++) {
      const led = document.createElement('div');
      led.className = 'led';
      leds.appendChild(led);
      this.leds.push(led);
      const b = this.makeStep(`step${i}`, String(i));
      if ((i - 1) % 4 === 0) b.classList.add('beat');
      steps.appendChild(b);
    }
    // A divider after each of the first three groups of four, from the function row down
    // through the strip. Steps of 64 px, gaps of 6 px and 14 px between groups (style.css),
    // the strip 7 px in from the knob panel: the gap after step 4k is centred 288k - 7 px in,
    // under the groove between knob modules 2k and 2k + 1; the line is 4 px wide.
    const bottom = q('.bottom-main');
    for (let k = 1; k <= 3; k++) {
      const line = document.createElement('div');
      line.className = 'strip-divider';
      line.style.left = `${288 * k - 9}px`;
      bottom.appendChild(line);
    }
    // ALT (hold: the knobs' second layer; tap: latch) left of the strip, PLAY right of it.
    root.append(this.makeButton('func', 'ALT', 'btn func'), this.makeButton('play', PLAY_ICON, 'btn play'));
    // MASTER / TEMPO beside the page keys, the track's knobs over knob modules 5-8: each in a
    // module of its own (the name up its left side), a lit groove between the track's two
    // and its two sends.
    const sideKnob = (id: string, box: HTMLElement, lit = false) => {
      const knob = new Knob(id, '', 0.5, this.knobEmit, this.encoderEmit, 127);
      this.masterKnobs.set(id, knob);
      const module = document.createElement('div');
      module.className = lit ? 'knob-module lit-groove' : 'knob-module';
      module.appendChild(knob.el);
      box.appendChild(module);
    };
    for (const id of PROJECT_KNOBS) sideKnob(id, q('.project-knobs'));
    for (const id of TRACK_KNOBS) sideKnob(id, q('.track-knobs'), id === 'mfx1');

    this.installKeyboard();
    // Nothing stays held when the app loses focus or goes to the background (the lift that
    // would release it never arrives).
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.releaseAll(); });
    this.fit();
    window.addEventListener('resize', () => this.fit());
    window.addEventListener('orientationchange', () => this.fit());
  }

  subscribe(listener: ControlListener): () => void {
    return this.emitter.subscribe(listener);
  }

  setKnob(id: string, value: number): void {
    this.knobs.find((k) => k.id === id)?.set(value);
  }

  /** Configure knob slot i (0-based): label, value and default, or null to disable it. */
  configureKnob(i: number, slot: { label: string; value: number; defaultValue: number; highlight?: boolean; staged?: boolean; colour?: string } | null): void {
    const k = this.knobs[i];
    if (!k) return;
    if (slot?.colour) k.el.style.setProperty('--accent', slot.colour);
    k.setEnabled(slot !== null);
    k.setLabel(slot?.label ?? '');
    k.el.classList.toggle('highlight', !!slot?.highlight);
    // SONG RECORD: a knob that will be locked on the primed step.
    k.el.classList.toggle('staged', !!slot?.staged);
    if (slot) {
      k.defaultValue = slot.defaultValue;
      k.set(slot.value);
    } else {
      k.set(0);
    }
  }

  /**
   * Light the grooves left of these knob modules (0-based, 1-7): a knob group's edge (an FX
   * view's units, two modules each).
   */
  setLitGrooves(modules: readonly number[]): void {
    this.modules.forEach((m, i) => {
      const on = modules.includes(i);
      if (m.classList.contains('lit-groove') !== on) m.classList.toggle('lit-groove', on);
    });
  }

  /** A knob of the project's or the selected track's (above the knob panel), or null: off. */
  configureMaster(id: string, slot: { label: string; value: number; defaultValue: number; colour: string } | null): void {
    const k = this.masterKnobs.get(id);
    if (!k) return;
    k.setEnabled(slot !== null);
    if (!slot) return;
    k.el.style.setProperty('--accent', slot.colour);
    k.setLabel(slot.label);
    k.defaultValue = slot.defaultValue;
    k.set(slot.value);
  }

  /** LED states for the 16 lights above the strip. */
  setLed(i: number, state: '' | 'on' | 'rec' | 'cursor'): void {
    const led = this.leds[i];
    if (led && led.dataset.state !== state) {
      led.dataset.state = state;
      led.className = state ? `led ${state}` : 'led';
    }
  }

  /**
   * Track colours: the panel takes the selected track's (strip, LEDs, lit keys), each
   * channel button its own track's.
   */
  setTrackColours(colours: string[], selected: string): void {
    if (this.root.style.getPropertyValue('--accent') !== selected) {
      this.root.style.setProperty('--accent', selected);
      this.root.style.setProperty('--accent-dim', dimOf(selected));
    }
    colours.forEach((c, i) => this.buttons.get(`ch${i + 1}`)?.style.setProperty('--accent', c));
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

  /** 1 = zoomed in until the pixel screen fills the window (start-up), 0 = the whole panel. */
  setZoom(t: number): void {
    this.zoom = Math.min(1, Math.max(0, t));
    this.fit();
  }

  /** The screen bezel's centre and size, in design pixels (layout only, no transforms). */
  private screenBox(): { cx: number; cy: number; w: number; h: number } {
    const el = this.root.querySelector('.screen-bezel') as HTMLElement;
    let x = this.root.clientLeft;
    let y = this.root.clientTop;
    for (let e: HTMLElement | null = el; e && e !== this.root; e = e.offsetParent as HTMLElement | null) {
      x += e.offsetLeft;
      y += e.offsetTop;
    }
    return { cx: x + el.offsetWidth / 2, cy: y + el.offsetHeight / 2, w: el.offsetWidth, h: el.offsetHeight };
  }

  /**
   * Scale (and on portrait screens rotate) the fixed design box to fit the viewport; with a
   * zoom, scale up around the screen (its centre glides to the middle of the window).
   */
  fit(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const portrait = vh > vw;
    setRotated(portrait);
    document.documentElement.classList.toggle('rotated', portrait);
    // The whole panel, centred.
    const s0 = portrait ? Math.min(vh / DESIGN_W, vw / DESIGN_H) : Math.min(vw / DESIGN_W, vh / DESIGN_H);
    const x0 = portrait ? (vw + DESIGN_H * s0) / 2 : (vw - DESIGN_W * s0) / 2;
    const y0 = (vh - (portrait ? DESIGN_W : DESIGN_H) * s0) / 2;
    const rotate = portrait ? ' rotate(90deg)' : '';
    if (this.zoom <= 0) {
      this.root.style.transform = `translate(${x0}px, ${y0}px)${rotate} scale(${s0})`;
      return;
    }
    // Where a design point lands: portrait rotates it a quarter turn clockwise.
    const b = this.screenBox();
    const at = (x: number, y: number, s: number): [number, number] => (portrait ? [x - s * b.cy, y + s * b.cx] : [x + s * b.cx, y + s * b.cy]);
    const s1 = 0.94 * (portrait ? Math.min(vh / b.w, vw / b.h) : Math.min(vw / b.w, vh / b.h));
    const t = this.zoom;
    const s = Math.pow(s0, 1 - t) * Math.pow(s1, t);
    const [fx, fy] = at(x0, y0, s0);
    const cx = fx + (vw / 2 - fx) * t;
    const cy = fy + (vh / 2 - fy) * t;
    const x = portrait ? cx + s * b.cy : cx - s * b.cx;
    const y = portrait ? cy - s * b.cx : cy - s * b.cy;
    this.root.style.transform = `translate(${x}px, ${y}px)${rotate} scale(${s})`;
  }

  private press(id: string, pressed: boolean): void {
    if (!pressed) this.buttons.get(id)?.classList.remove('down');
    if (this.disabled.has(id) && pressed) return;
    if (pressed) this.buttons.get(id)?.classList.add('down');
    this.emitter.emit({ type: 'button', id, pressed });
  }

  /** Let go of every held step, button and key (focus lost, app in the background). */
  releaseAll(): void {
    for (const k of this.knobs) k.release();
    for (const [pointer, id] of [...this.stripPointers]) {
      this.stripPointers.delete(pointer);
      this.press(id, false);
    }
    for (const [id, pointers] of this.buttonPointers) {
      if (pointers.size === 0) continue;
      pointers.clear();
      this.press(id, false);
    }
    for (const [code, id] of [...this.heldKeys]) {
      this.heldKeys.delete(code);
      this.press(id, false);
    }
  }

  /** Sliding along the strip presses each step in turn (paint strokes); set by the app. */
  setStripSlide(on: boolean): void {
    this.stripSlide = on;
  }

  /**
   * A strip button. With strip sliding on, a finger (or the mouse) moving onto another step
   * presses that one and then releases the one before, as a finger rolled along hardware
   * buttons would.
   */
  private makeStep(id: string, label: string): HTMLElement {
    const b = document.createElement('div');
    b.className = 'step';
    b.innerHTML = label;
    b.setAttribute('role', 'button');
    this.stepIds.set(b, id);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      this.stripPointers.set(e.pointerId, id);
      this.press(id, true);
    });
    b.addEventListener('pointermove', (e) => {
      const cur = this.stripPointers.get(e.pointerId);
      if (!cur || !this.stripSlide) return;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.step');
      const next = el ? this.stepIds.get(el as HTMLElement) : undefined;
      if (!next || next === cur || [...this.stripPointers.values()].includes(next)) return;
      this.stripPointers.set(e.pointerId, next);
      this.press(next, true);
      this.press(cur, false);
    });
    const release = (e: PointerEvent) => {
      const cur = this.stripPointers.get(e.pointerId);
      if (!cur) return;
      this.stripPointers.delete(e.pointerId);
      this.press(cur, false);
    };
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    // The browser can drop a touch without an up or cancel: let go then too.
    b.addEventListener('lostpointercapture', release);
    this.buttons.set(id, b);
    return b;
  }

  private makeButton(id: string, label: string, cls: string): HTMLElement {
    const b = document.createElement('div');
    b.className = cls;
    b.innerHTML = label;
    b.setAttribute('role', 'button');
    const pointers = new Set<number>();
    this.buttonPointers.set(id, pointers);
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
    b.addEventListener('lostpointercapture', release);
    this.buttons.set(id, b);
    return b;
  }

  /**
   * Space: play. Z: FUNC (hold). Escape: CANCEL. Backspace: UNDO. 1-8: select channel, Shift+1-8: mute, Alt+1-8: solo.
   * Q..I: strip buttons 1-8, A..K: strip buttons 9-16.
   */
  private installKeyboard(): void {
    const stepKeys = 'QWERTYUIASDFGHJK';
    const toId = (e: KeyboardEvent): string | null => {
      if (e.code === 'Space') return 'play';
      if (e.code === 'KeyZ') return 'func';
      if (e.code === 'Escape') return 'cancel';
      if (e.code === 'Backspace') return 'undo';
      const digit = /^Digit([1-8])$/.exec(e.code);
      if (digit) return e.shiftKey ? `mute${digit[1]}` : e.altKey ? `solo${digit[1]}` : `ch${digit[1]}`;
      const key = /^Key([A-Z])$/.exec(e.code);
      if (key) {
        const i = stepKeys.indexOf(key[1]);
        if (i >= 0) return `step${i + 1}`;
      }
      return null;
    };
    const held = this.heldKeys;
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
