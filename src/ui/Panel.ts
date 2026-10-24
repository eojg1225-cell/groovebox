/**
 * On-screen hardware panel: the first ControlSurface implementation.
 * Fixed design-size box scaled to fit the window; on a portrait screen it is rotated
 * so the instrument is always landscape.
 *
 *   [ pixel screen ] [ MODE: record / play / sound design ]
 *                    [ save  | TEMPO MASTER   ]
 *                    [ pages |                ]
 *                    [ FX 1-3, LFO | PAT A-D ]
 *   [ 8 track modules, each: knob / M, channel button, S / knob ]
 *   [ function row                                 ] | [      ]
 *   [ step LEDs                                    ] | [ FUNC ]
 *   [ 16-button strip (steps or keyboard)          ] | [ PLAY ]
 *   (the strip's right divider sits under the groove between modules 7 and 8)
 *
 * Control ids: mode:record|play|design, ch1..8, mute1..8, solo1..8, save, saveproject,
 * reset, patA..D (beside the FX buttons), dpage0..2, fx1..fx3 + fx4 (LFO), play, clear
 * (held: CLEAR + step / channel), copy (held: COPY + channel = same pattern slot there,
 * COPY + A-D = that pattern of this track),
 * step1..16, function row ids (FUNCTION_ROW); knobs k1..k16 (k1..k8 top row, k9..k16
 * bottom row; module i holds k(i+1) and k(i+9)); master knobs mtempo, mmaster.
 */
import { ControlEmitter, type ControlListener, type ControlSurface } from '../controls/ControlSurface';
import { Knob } from './Knob';
import { setRotated } from './orientation';
import { BPM_MAX, BPM_MIN } from '../engine/mixParams';

const DESIGN_W = 1200;
const DESIGN_H = 760;
export const KNOB_COUNT = 16;
export const KNOBS_PER_ROW = 8;
export const STEP_BUTTONS = 16;
export const DESIGN_PAGE_BUTTONS = 3;
/** FX 1-3 then the LFO (fx4): buses the tracks are put on. */
export const FX_SEND_BUTTONS = 4;
const MASTER_KNOBS = [
  { id: 'mtempo', label: 'TEMPO' },
  { id: 'mmaster', label: 'MASTER' },
] as const;

export const MODES = [
  { id: 'record', label: 'RECORD' },
  { id: 'play', label: 'PLAY' },
  { id: 'design', label: 'DESIGN' },
  { id: 'song', label: 'SONG' },
] as const;

/**
 * Function row: groups of [id, label] (labels may contain <small> lines); 16 keys, each
 * straight above a strip step. An empty id = a blank key (not wired up yet).
 */
const FUNCTION_ROW: readonly (readonly [string, string])[][] = [
  [['ring', 'RING'], ['slide', 'SLIDE'], ['dyn:accent', 'ACCENT'], ['dyn:ghost', 'GHOST']],
  [['len', '16<small>STEPS</small>'], ['steppage', 'BAR<small>1/1</small>'], ['clear', 'CLEAR<small>HOLD</small>'], ['copy', 'COPY<small>HOLD</small>']],
  [['speed', 'TIME<small>NORMAL</small>'], ['', ''], ['', ''], ['rest', 'REST']],
  [['oct-', 'OCT −'], ['oct+', 'OCT +'], ['cur-', '◀'], ['cur+', '▶']],
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
  private readonly masterKnobs = new Map<string, Knob>();
  private readonly knobEmit = (id: string, value: number) => this.emitter.emit({ type: 'knob', id, value });
  private readonly encoderEmit = (id: string, delta: number) => this.emitter.emit({ type: 'encoder', id, delta });

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
      <div class="panel-top">
        <div class="screen-bezel"><canvas class="screen"></canvas></div>
        <div class="side">
          <div class="row modes"></div>
          <div class="lower">
            <div class="lower-rows">
              <div class="row patterns"><div class="save-buttons"></div></div>
              <div class="row pages"><div class="page-buttons"></div></div>
            </div>
            <div class="master-knobs"></div>
          </div>
          <div class="row buses">
            <div class="key-group"><div class="group-label">FX</div><div class="key-row fx-buttons"></div></div>
            <div class="key-group"><div class="group-label">PATTERN</div><div class="key-row pat-buttons"></div></div>
          </div>
        </div>
      </div>
      <div class="knob-grid"></div>
      <div class="panel-bottom">
        <div class="bottom-main">
          <div class="function-row"></div>
          <div class="leds"></div>
          <div class="steps"></div>
        </div>
        <div class="play-area"></div>
      </div>`;
    host.appendChild(root);
    this.root = root;
    this.screenCanvas = root.querySelector('.screen') as HTMLCanvasElement;
    const q = (sel: string) => root.querySelector(sel) as HTMLElement;

    for (const m of MODES) q('.modes').appendChild(this.makeButton(`mode:${m.id}`, m.label, 'btn mode'));
    q('.save-buttons').appendChild(this.makeButton('save', 'SAVE<small>PATTERN</small>', 'btn save'));
    q('.save-buttons').appendChild(this.makeButton('saveproject', 'SAVE/LOAD<small>PROJECT</small>', 'btn save'));
    q('.save-buttons').appendChild(this.makeButton('reset', 'RESET<small>TO SAVED</small>', 'btn save'));
    for (const p of cfg.patterns) q('.pat-buttons').appendChild(this.makeButton(`pat${p}`, p, 'btn pat'));
    for (let i = 0; i < DESIGN_PAGE_BUTTONS; i++) q('.page-buttons').appendChild(this.makeButton(`dpage${i}`, '', 'btn page'));
    for (let i = 1; i <= FX_SEND_BUTTONS; i++) q('.fx-buttons').appendChild(this.makeButton(`fx${i}`, i === 4 ? 'LFO' : String(i), 'btn fxsend'));

    // Knob modules, one per track, separated by grooves like a hardware front panel; the
    // track's channel button sits between its two knobs, MUTE left of it, SOLO right.
    const grid = q('.knob-grid');
    for (let i = 1; i <= KNOB_COUNT; i++) {
      this.knobs.push(new Knob(`k${i}`, '', 0.5, this.knobEmit, this.encoderEmit));
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
    // A divider after every four steps, from the function row down through the strip. With
    // 16 steps, gaps of 6 px and 14 px more between groups, the gap after step 4k is
    // centred k/4 of the way across plus 5k - 10 px; the line is 4 px wide.
    const bottom = q('.bottom-main');
    for (let k = 1; k <= 4; k++) {
      const line = document.createElement('div');
      line.className = 'strip-divider';
      line.style.left = `calc(${k * 25}% + ${5 * k - 12}px)`;
      bottom.appendChild(line);
    }
    // FUNC (hold: the knobs' second layer; tap: latch) beside PLAY.
    const playRow = document.createElement('div');
    playRow.className = 'play-row';
    playRow.append(this.makeButton('func', 'FUNC', 'btn func'), this.makeButton('play', 'PLAY', 'btn play'));
    q('.play-area').prepend(playRow);
    for (const m of MASTER_KNOBS) {
      // TEMPO moves in whole BPM steps; everything else is 0-127.
      const knob = new Knob(m.id, m.label, 0.5, this.knobEmit, this.encoderEmit, m.id === 'mtempo' ? BPM_MAX - BPM_MIN : 127);
      knob.el.classList.add('master');
      this.masterKnobs.set(m.id, knob);
      q('.master-knobs').appendChild(knob.el);
    }

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
  configureKnob(i: number, slot: { label: string; value: number; defaultValue: number; highlight?: boolean } | null): void {
    const k = this.knobs[i];
    if (!k) return;
    k.setEnabled(slot !== null);
    k.setLabel(slot?.label ?? '');
    k.el.classList.toggle('highlight', !!slot?.highlight);
    if (slot) {
      k.defaultValue = slot.defaultValue;
      k.set(slot.value);
    } else {
      k.set(0);
    }
  }

  /** Master knob (TEMPO / MASTER): current value and default, normalised. */
  configureMaster(id: string, value: number, defaultValue: number): void {
    const k = this.masterKnobs.get(id);
    if (!k) return;
    k.defaultValue = defaultValue;
    k.set(value);
  }

  /** LED states for the 16 lights above the strip. */
  setLed(i: number, state: '' | 'on' | 'rec' | 'cursor'): void {
    const led = this.leds[i];
    if (led && led.dataset.state !== state) {
      led.dataset.state = state;
      led.className = state ? `led ${state}` : 'led';
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
   * Space: play. Z: FUNC (hold). 1-8: select channel, Shift+1-8: mute, Alt+1-8: solo.
   * Q..I: strip buttons 1-8, A..K: strip buttons 9-16.
   */
  private installKeyboard(): void {
    const stepKeys = 'QWERTYUIASDFGHJK';
    const toId = (e: KeyboardEvent): string | null => {
      if (e.code === 'Space') return 'play';
      if (e.code === 'KeyZ') return 'func';
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
