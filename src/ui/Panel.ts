/**
 * On-screen hardware panel: the first ControlSurface implementation.
 * Fixed design-size box scaled to fit the window; on a portrait screen it is rotated
 * so the instrument is always landscape.
 *
 *   [ pixel screen ] [ MODE: record / play / sound design ]
 *                    [ channels 1-8, mutes, pages | FX, save | A-D ]
 *   [ 6 track modules, each: knob / track number / knob     ]
 *   [ function row                                 ] [      ]
 *   [ step LEDs                                    ] [ PLAY ]
 *   [ 16-button strip (steps or keyboard)          ] [      ]
 *
 * Control ids: mode:record|play|design, ch1..8, mute1..8, solo1..8, save, saveproject,
 * reset, patA..D (under the FX buttons), dpage0..2, fx1..fx3 + fx4 (LFO), play, clear
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

/** Function row: groups of [id, label] (labels may contain <small> lines). */
const FUNCTION_ROW: readonly (readonly [string, string])[][] = [
  [['ring', 'RING'], ['slide', 'SLIDE'], ['dyn:accent', 'ACCENT'], ['dyn:ghost', 'GHOST']],
  [['len', '16<small>STEPS</small>'], ['steppage', 'BAR<small>1/1</small>'], ['clear', 'CLEAR<small>HOLD</small>'], ['copy', 'COPY<small>HOLD</small>']],
  [['oct-', 'OCT −'], ['oct+', 'OCT +']],
  [['cur-', '◀'], ['cur+', '▶'], ['rest', 'REST']],
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
  private readonly badges: HTMLElement[] = [];
  private readonly masterKnobs = new Map<string, Knob>();
  private readonly knobEmit = (id: string, value: number) => this.emitter.emit({ type: 'knob', id, value });
  private readonly encoderEmit = (id: string, delta: number) => this.emitter.emit({ type: 'encoder', id, delta });

  private stripSlide = false;
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
          <div class="row channels"></div>
          <div class="row mutes"></div>
          <div class="row pages"><div class="page-buttons"></div><div class="fx-buttons"><span class="fx-label">FX</span></div></div>
          <div class="row patterns"><div class="save-buttons"></div><div class="pat-buttons"><span class="fx-label">PAT</span></div></div>
        </div>
      </div>
      <div class="knob-grid"></div>
      <div class="panel-bottom">
        <div class="bottom-main">
          <div class="function-row"></div>
          <div class="leds"></div>
          <div class="steps"></div>
        </div>
        <div class="play-area"><div class="master-knobs"></div></div>
      </div>`;
    host.appendChild(root);
    this.root = root;
    this.screenCanvas = root.querySelector('.screen') as HTMLCanvasElement;
    const q = (sel: string) => root.querySelector(sel) as HTMLElement;

    for (const m of MODES) q('.modes').appendChild(this.makeButton(`mode:${m.id}`, m.label, 'btn mode'));
    for (let ch = 1; ch <= cfg.channels; ch++) {
      q('.channels').appendChild(this.makeButton(`ch${ch}`, String(ch), 'btn ch'));
      // MUTE and SOLO side by side under each channel.
      const pair = document.createElement('div');
      pair.className = 'mute-solo';
      pair.appendChild(this.makeButton(`mute${ch}`, 'M', 'btn mute'));
      pair.appendChild(this.makeButton(`solo${ch}`, 'S', 'btn solo'));
      q('.mutes').appendChild(pair);
    }
    q('.save-buttons').appendChild(this.makeButton('save', 'SAVE<small>PATTERN</small>', 'btn save'));
    q('.save-buttons').appendChild(this.makeButton('saveproject', 'SAVE/LOAD<small>PROJECT</small>', 'btn save'));
    q('.save-buttons').appendChild(this.makeButton('reset', 'RESET<small>TO SAVED</small>', 'btn save'));
    for (const p of cfg.patterns) q('.pat-buttons').appendChild(this.makeButton(`pat${p}`, p, 'btn pat'));
    for (let i = 0; i < DESIGN_PAGE_BUTTONS; i++) q('.page-buttons').appendChild(this.makeButton(`dpage${i}`, '', 'btn page'));
    for (let i = 1; i <= FX_SEND_BUTTONS; i++) q('.fx-buttons').appendChild(this.makeButton(`fx${i}`, i === 4 ? 'LFO' : String(i), 'btn fxsend'));

    // Knob modules, one per track, separated by grooves like a hardware front panel.
    const grid = q('.knob-grid');
    for (let i = 1; i <= KNOB_COUNT; i++) {
      this.knobs.push(new Knob(`k${i}`, '', 0.5, this.knobEmit, this.encoderEmit));
    }
    for (let m = 0; m < KNOBS_PER_ROW; m++) {
      const module = document.createElement('div');
      module.className = 'knob-module';
      const badge = document.createElement('div');
      badge.className = 'track-badge';
      badge.textContent = String(m + 1);
      this.badges.push(badge);
      module.append(this.knobs[m].el, badge, this.knobs[m + KNOBS_PER_ROW].el);
      grid.appendChild(module);
    }

    const fnRow = q('.function-row');
    for (const group of FUNCTION_ROW) {
      const g = document.createElement('div');
      g.className = 'fn-group';
      for (const [id, label] of group) g.appendChild(this.makeButton(id, label, 'btn fn'));
      fnRow.appendChild(g);
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

  /** Printed track number between a module's knobs: lit = selected track, dim = not in use. */
  setBadge(i: number, state: 'lit' | 'dim' | ''): void {
    const b = this.badges[i];
    if (b && b.dataset.state !== state) {
      b.dataset.state = state;
      b.className = state ? `track-badge ${state}` : 'track-badge';
    }
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

  /** Scale (and on portrait screens rotate) the fixed design box to fit the viewport. */
  fit(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const portrait = vh > vw;
    setRotated(portrait);
    document.documentElement.classList.toggle('rotated', portrait);
    if (portrait) {
      const scale = Math.min(vh / DESIGN_W, vw / DESIGN_H);
      const x = (vw - DESIGN_H * scale) / 2 + DESIGN_H * scale;
      const y = (vh - DESIGN_W * scale) / 2;
      this.root.style.transform = `translate(${x}px, ${y}px) rotate(90deg) scale(${scale})`;
    } else {
      const scale = Math.min(vw / DESIGN_W, vh / DESIGN_H);
      const x = (vw - DESIGN_W * scale) / 2;
      const y = (vh - DESIGN_H * scale) / 2;
      this.root.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }
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
