/**
 * App controller: owns the project (source of truth on the UI side), turns ControlSurface
 * events into project edits + engine messages, persists the session and builds the
 * screen view-model.
 *
 * Two modes, each tuned for its job:
 *  RECORD (building): pattern buttons switch at once; drums: the strip toggles steps (with
 *    the armed accent/ghost) and you page through long patterns yourself; pitched
 *    tracks: the strip is a step-entry keyboard (note at the cursor, then advance).
 *  PLAY (performing): pattern switches wait for the loop end; drums: steps toggle live and
 *    the view follows the playhead; pitched tracks: the strip is a live keyboard.
 * MOTION REC (either mode, while playing): knob moves on the SOUND page become per-step
 * locks, and live keyboard notes are written to the nearest step.
 */
import type { ControlEvent } from '../controls/ControlSurface';
import { formatValue, toNorm, toValue, type ParamSpec } from '../engine/params';
import { GLOBAL_PARAMS, MIX_PARAMS } from '../engine/mixParams';
import {
  ACTIVE_CHANNELS, MAX_STEPS, NUM_CHANNELS, PATTERN_NAMES, STEP_LENGTHS,
  setStepDynamic, stepDynamic, type Dynamic, type Project, type Step,
} from '../engine/project';
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';
import { INSTRUMENTS, instrumentName, instrumentParams, isDrum } from '../instruments/registry';
import { saveSession } from '../storage/session';
import { KNOB_COUNT, STEP_BUTTONS, type Panel } from './Panel';
import type { LaneCell, ScreenView } from './views';

export type PageId = 'sound' | 'mix' | 'global';
export type Mode = 'record' | 'play';
export const PAGES: readonly { id: PageId; label: string }[] = [
  { id: 'sound', label: 'SOUND' },
  { id: 'mix', label: 'MIX' },
  { id: 'global', label: 'GLOBAL' },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}
const isBlackKey = (n: number) => NOTE_NAMES[n % 12].length > 1;

type Status = Extract<WorkletToMain, { type: 'status' }>;
type Recorded = Extract<WorkletToMain, { type: 'recordedNote' | 'recordedLock' }>;

export interface AudioInfo {
  state: 'off' | 'starting' | 'on' | 'error';
  latencyMs: number;
  peak: number;
}

export class App {
  selected = 0;
  page: PageId = 'sound';
  mode: Mode = 'record';
  motion = false;
  dynamic: Dynamic = 'normal';
  playing = false;
  /** Per channel: manually chosen 16-step view (record mode, drums). */
  private readonly viewPage: number[] = new Array(NUM_CHANNELS).fill(0);
  /** Per channel: step-entry cursor (record mode, pitched tracks). */
  private readonly cursor: number[] = new Array(NUM_CHANNELS).fill(0);
  /** Per channel: lowest note on the keyboard. */
  private readonly octave: number[];
  private touchedSlot = -1;
  private touchedAt = 0;
  private status: Status | null = null;

  constructor(
    readonly project: Project,
    private readonly panel: Panel,
    private send: (msg: MainToWorklet) => void,
  ) {
    this.octave = project.channels.map((c) => (c.instrument === 'none' ? 36 : INSTRUMENTS[c.instrument].baseNote));
    panel.subscribe((e) => this.onControl(e));
    this.refreshPanel();
  }

  setStatus(s: Status): void {
    this.status = s;
  }

  /** Messages that bring a freshly started engine in line with the UI. */
  syncMessages(): MainToWorklet[] {
    return [
      { type: 'loadProject', project: this.project },
      { type: 'transport', playing: this.playing },
    ];
  }

  /** Motion-record results from the worklet: mirror them into the project. */
  onRecorded(m: Recorded): void {
    const step = this.project.channels[m.channel].patterns[m.pattern].steps[m.index];
    if (m.type === 'recordedNote') {
      step.active = true;
      step.note = m.note;
      step.velocity = m.velocity;
      step.accent = m.accent;
    } else {
      step.locks = { ...step.locks, [m.id]: m.value };
    }
    this.save();
  }

  // ---------------------------------------------------------------- helpers

  private get channel() {
    return this.project.channels[this.selected];
  }

  private get pattern() {
    return this.channel.patterns[this.channel.activePattern];
  }

  private get keyboard(): boolean {
    return !isDrum(this.channel.instrument);
  }

  private pageCount(ch = this.selected): number {
    const c = this.project.channels[ch];
    return Math.ceil(c.patterns[c.activePattern].length / 16);
  }

  /** Which block of 16 steps the strip/screen shows for a channel. */
  private visiblePage(ch: number): number {
    const c = this.project.channels[ch];
    const heard = this.status?.patterns[ch] ?? c.activePattern;
    const head = this.status?.steps[ch] ?? -1;
    const following = ch !== this.selected || this.mode === 'play';
    let page: number;
    if (following) page = this.playing && head >= 0 && heard === c.activePattern ? Math.floor(head / 16) : 0;
    else if (!isDrum(c.instrument)) page = Math.floor(this.cursor[ch] / 16);
    else page = this.viewPage[ch];
    return Math.min(page, this.pageCount(ch) - 1);
  }

  private sendStep(index: number, step: Step): void {
    this.send({ type: 'setStep', channel: this.selected, pattern: this.channel.activePattern, index, step });
  }

  // ---------------------------------------------------------------- controls

  private onControl(e: ControlEvent): void {
    if (e.type === 'knob') return this.onKnob(Number(e.id.slice(1)) - 1, e.value);
    if (e.type !== 'button' || !e.pressed) return;
    const id = e.id;
    let m: RegExpExecArray | null;
    if (id === 'play') {
      this.playing = !this.playing;
      this.send({ type: 'transport', playing: this.playing });
    } else if ((m = /^ch(\d)$/.exec(id))) {
      this.selected = Number(m[1]) - 1;
    } else if ((m = /^mute(\d)$/.exec(id))) {
      const ch = Number(m[1]) - 1;
      const c = this.project.channels[ch];
      c.mute = !c.mute;
      this.send({ type: 'setMix', channel: ch, id: 'mute', value: c.mute ? 1 : 0 });
      this.save();
    } else if ((m = /^pat([A-C])$/.exec(id))) {
      const pattern = PATTERN_NAMES.indexOf(m[1] as (typeof PATTERN_NAMES)[number]);
      this.channel.activePattern = pattern;
      this.clampCursor();
      // Record mode: hear what you edit at once. Play mode: keep the groove, switch at loop end.
      this.send({ type: 'selectPattern', channel: this.selected, pattern, immediate: this.mode === 'record' });
      this.save();
    } else if (id.startsWith('page:')) {
      this.page = id.slice(5) as PageId;
      this.touchedSlot = -1;
    } else if (id === 'mode:record' || id === 'mode:play') {
      this.mode = id === 'mode:record' ? 'record' : 'play';
    } else if (id === 'motion') {
      this.motion = !this.motion;
    } else if (id === 'dyn:accent' || id === 'dyn:ghost') {
      const d: Dynamic = id === 'dyn:accent' ? 'accent' : 'ghost';
      this.dynamic = this.dynamic === d ? 'normal' : d;
    } else if (id === 'len') {
      this.cycleLength();
    } else if (id === 'steppage') {
      this.viewPage[this.selected] = (this.visiblePage(this.selected) + 1) % this.pageCount();
    } else if (id === 'oct-' || id === 'oct+') {
      const o = this.octave[this.selected] + (id === 'oct+' ? 12 : -12);
      this.octave[this.selected] = Math.max(12, Math.min(96, o));
    } else if (id === 'cur-' || id === 'cur+') {
      this.moveCursor(id === 'cur+' ? 1 : -1);
    } else if (id === 'rest') {
      const step = this.pattern.steps[this.cursor[this.selected]];
      step.active = false;
      delete step.locks;
      this.sendStep(this.cursor[this.selected], step);
      this.moveCursor(1);
      this.save();
    } else if ((m = /^step(\d+)$/.exec(id))) {
      this.onStrip(Number(m[1]) - 1);
    }
    this.refreshPanel();
  }

  private onStrip(button: number): void {
    const ch = this.selected;
    const velocity = (d: Dynamic) => (d === 'accent' ? 1 : d === 'ghost' ? 0.45 : 0.8);

    if (this.keyboard) {
      const note = this.octave[ch] + button;
      const vel = velocity(this.dynamic);
      if (this.mode === 'record') {
        // Step entry: write at the cursor, hear it, advance.
        const index = this.cursor[ch];
        const step = this.pattern.steps[index];
        step.active = true;
        step.note = note;
        setStepDynamic(step, this.dynamic);
        this.sendStep(index, step);
        this.send({ type: 'trigger', channel: ch, note, velocity: vel });
        this.moveCursor(1);
        this.save();
      } else if (this.motion && this.playing) {
        this.send({ type: 'recordNote', channel: ch, note, velocity: vel, accent: this.dynamic === 'accent' });
      } else {
        this.send({ type: 'trigger', channel: ch, note, velocity: vel });
      }
      return;
    }

    // Drum lane: toggle, or re-paint an existing hit with the armed dynamic.
    const index = this.visiblePage(ch) * 16 + button;
    if (index >= this.pattern.length) return;
    const step = this.pattern.steps[index];
    if (!step.active) {
      step.active = true;
      setStepDynamic(step, this.dynamic);
      if (!this.playing) this.send({ type: 'trigger', channel: ch, note: step.note, velocity: step.velocity });
    } else if (this.dynamic !== 'normal' && stepDynamic(step) !== this.dynamic) {
      setStepDynamic(step, this.dynamic);
    } else {
      step.active = false;
      delete step.locks;
    }
    this.sendStep(index, step);
    this.save();
  }

  private cycleLength(): void {
    const len = this.pattern.length;
    const next = STEP_LENGTHS.find((l) => l > len) ?? STEP_LENGTHS[0];
    this.pattern.length = Math.min(next, MAX_STEPS);
    this.send({
      type: 'setPatternLength', channel: this.selected, pattern: this.channel.activePattern, length: this.pattern.length,
    });
    this.clampCursor();
    this.save();
  }

  private moveCursor(delta: number): void {
    const len = this.pattern.length;
    this.cursor[this.selected] = (this.cursor[this.selected] + delta + len) % len;
  }

  private clampCursor(): void {
    const len = this.pattern.length;
    if (this.cursor[this.selected] >= len) this.cursor[this.selected] = 0;
    if (this.viewPage[this.selected] >= this.pageCount()) this.viewPage[this.selected] = 0;
  }

  private pageSpecs(): readonly ParamSpec[] {
    if (this.page === 'mix') return MIX_PARAMS;
    if (this.page === 'global') return GLOBAL_PARAMS;
    return instrumentParams(this.channel.instrument);
  }

  private getValue(spec: ParamSpec): number {
    const c = this.channel;
    if (this.page === 'mix') return spec.id === 'pan' ? c.pan : c.volume;
    if (this.page === 'global') {
      const p = this.project;
      return spec.id === 'bpm' ? p.bpm : spec.id === 'swing' ? p.swing : p.master;
    }
    return c.sound[spec.id] ?? spec.defaultValue;
  }

  private onKnob(slot: number, norm: number): void {
    const spec = this.pageSpecs()[slot];
    if (!spec) return;
    let value = toValue(spec, norm);
    if (spec.decimals !== undefined) {
      const f = Math.pow(10, spec.decimals);
      value = Math.round(value * f) / f;
    }
    const ch = this.selected;
    const c = this.channel;
    if (this.page === 'sound') {
      if (this.motion && this.playing) {
        // Recorded as a lock on the step playing now; the channel's own value is untouched.
        this.send({ type: 'recordLock', channel: ch, id: spec.id, value });
      } else {
        c.sound[spec.id] = value;
        this.send({ type: 'setSound', channel: ch, id: spec.id, value });
      }
    } else if (this.page === 'mix') {
      if (spec.id === 'pan') c.pan = value;
      else c.volume = value;
      this.send({ type: 'setMix', channel: ch, id: spec.id as 'volume' | 'pan', value });
    } else {
      if (spec.id === 'bpm') this.project.bpm = value;
      else if (spec.id === 'swing') this.project.swing = value;
      else this.project.master = value;
      this.send({ type: 'setGlobal', id: spec.id as 'bpm' | 'swing' | 'master', value });
    }
    this.touchedSlot = slot;
    this.touchedAt = performance.now();
    this.save();
  }

  private save(): void {
    saveSession(this.project);
  }

  // ---------------------------------------------------------------- display

  /** Knob labels/positions and button states that change on input, not per frame. */
  refreshPanel(): void {
    const specs = this.pageSpecs();
    for (let i = 0; i < KNOB_COUNT; i++) {
      const spec = specs[i];
      this.panel.configureKnob(
        `k${i + 1}`,
        spec ? { label: spec.name, value: toNorm(spec, this.getValue(spec)), defaultValue: toNorm(spec, spec.defaultValue) } : null,
      );
    }
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const c = this.project.channels[ch];
      this.panel.setButtonLit(`ch${ch + 1}`, ch === this.selected);
      this.panel.setButtonLit(`mute${ch + 1}`, c.mute);
      if (ch < ACTIVE_CHANNELS) {
        this.panel.setButtonText(`ch${ch + 1}`, `${ch + 1}<small>${instrumentName(c.instrument)}</small>`);
      }
    }
    for (const p of PAGES) this.panel.setButtonLit(`page:${p.id}`, p.id === this.page);
    this.panel.setButtonLit('play', this.playing);
    this.panel.setButtonText('play', this.playing ? 'STOP' : 'PLAY');

    const rec = this.mode === 'record';
    const kb = this.keyboard;
    this.panel.setButtonLit('mode:record', rec);
    this.panel.setButtonLit('mode:play', !rec);
    this.panel.setButtonText('mode:record', 'RECORD<small>MODE</small>');
    this.panel.setButtonFlag('motion', 'armed', this.motion);
    this.panel.setButtonLit('dyn:accent', this.dynamic === 'accent');
    this.panel.setButtonLit('dyn:ghost', this.dynamic === 'ghost');
    this.panel.setButtonText('len', `${this.pattern.length}<small>STEPS</small>`);
    this.panel.setButtonEnabled('steppage', rec && !kb && this.pageCount() > 1);
    for (const id of ['oct-', 'oct+']) this.panel.setButtonEnabled(id, kb);
    for (const id of ['cur-', 'cur+', 'rest']) this.panel.setButtonEnabled(id, kb && rec);
    this.panel.root.classList.toggle('keyboard', kb);
  }

  /** Per-frame updates: strip lights/labels, playhead, pending pattern blink, view label. */
  updateFrame(now: number): void {
    const ch = this.selected;
    const c = this.channel;
    const pattern = this.pattern;
    const playingPattern = this.status?.patterns[ch] ?? c.activePattern;
    const heardHere = this.playing && playingPattern === c.activePattern;
    const head = heardHere ? (this.status?.steps[ch] ?? -1) : -1;
    const page = this.visiblePage(ch);

    if (this.keyboard) {
      // Note sounding at the playhead lights its key.
      const sounding = head >= 0 && pattern.steps[head].active ? pattern.steps[head].note : -1;
      const cursorStep = pattern.steps[this.cursor[ch]];
      const cursorNote = this.mode === 'record' && cursorStep.active ? cursorStep.note : -1;
      for (let i = 0; i < STEP_BUTTONS; i++) {
        const id = `step${i + 1}`;
        const note = this.octave[ch] + i;
        this.panel.setButtonText(id, noteName(note));
        this.panel.setButtonFlag(id, 'black', isBlackKey(note));
        this.panel.setButtonFlag(id, 'lit', note === sounding);
        this.panel.setButtonFlag(id, 'cursor', note === cursorNote);
        for (const f of ['accent', 'ghost', 'head', 'off']) this.panel.setButtonFlag(id, f, false);
      }
    } else {
      for (let i = 0; i < STEP_BUTTONS; i++) {
        const id = `step${i + 1}`;
        const index = page * 16 + i;
        const off = index >= pattern.length;
        const step = pattern.steps[index];
        const d = step.active && !off ? stepDynamic(step) : null;
        this.panel.setButtonText(id, String(index + 1));
        this.panel.setButtonFlag(id, 'off', off);
        this.panel.setButtonFlag(id, 'lit', d !== null);
        this.panel.setButtonFlag(id, 'accent', d === 'accent');
        this.panel.setButtonFlag(id, 'ghost', d === 'ghost');
        this.panel.setButtonFlag(id, 'head', head === index);
        for (const f of ['black', 'cursor']) this.panel.setButtonFlag(id, f, false);
      }
    }

    const start = page * 16 + 1;
    const end = Math.min(pattern.length, start + 15);
    this.panel.setButtonText('steppage', `${start}-${end}<small>${this.mode === 'play' ? 'FOLLOW' : 'VIEW'}</small>`);

    const blink = Math.floor(now / 250) % 2 === 0;
    PATTERN_NAMES.forEach((name, p) => {
      const pending = p === c.activePattern && playingPattern !== c.activePattern && this.playing;
      this.panel.setButtonFlag(`pat${name}`, 'lit', p === c.activePattern && (!pending || blink));
      this.panel.setButtonFlag(`pat${name}`, 'playing', p === playingPattern && p !== c.activePattern);
    });
    if (this.touchedSlot >= 0 && now - this.touchedAt > 4000) this.touchedSlot = -1;
  }

  screenView(now: number, audio: AudioInfo): ScreenView {
    const ch = this.selected;
    const c = this.channel;
    const playingPattern = this.status?.patterns[ch] ?? c.activePattern;
    const patternLabel = this.playing && playingPattern !== c.activePattern
      ? `PAT ${PATTERN_NAMES[playingPattern]}>${PATTERN_NAMES[c.activePattern]}`
      : `PAT ${PATTERN_NAMES[c.activePattern]}`;

    const lanes = [];
    for (let i = 0; i < ACTIVE_CHANNELS; i++) {
      const lc = this.project.channels[i];
      // The selected lane shows the pattern being edited; others show what is heard.
      const heard = this.status?.patterns[i] ?? lc.activePattern;
      const shown = i === ch ? lc.activePattern : heard;
      const pat = lc.patterns[shown];
      const page = i === ch ? this.visiblePage(i) : (this.playing && shown === heard ? Math.floor(Math.max(0, this.status?.steps[i] ?? 0) / 16) : 0);
      const head = this.playing && shown === heard ? (this.status?.steps[i] ?? -1) : -1;
      const pitched = !isDrum(lc.instrument);
      const cells: LaneCell[] = [];
      for (let k = 0; k < 16; k++) {
        const idx = page * 16 + k;
        const step = pat.steps[idx];
        cells.push({
          state: idx >= pat.length ? 'none' : step.active ? stepDynamic(step) : 'off',
          note: pitched && i === ch && step.active ? noteName(step.note).replace(/(\d)$/, '') : '',
          locked: !!step.locks && Object.keys(step.locks).length > 0,
        });
      }
      lanes.push({
        name: `${i + 1}${instrumentName(lc.instrument).slice(0, 4)}`,
        cells,
        playhead: head >= 0 && Math.floor(head / 16) === page ? head % 16 : -1,
        cursor: i === ch && pitched && this.mode === 'record' && Math.floor(this.cursor[i] / 16) === page ? this.cursor[i] % 16 : -1,
        muted: lc.mute,
        selected: i === ch,
      });
    }

    const specs = this.pageSpecs();
    const slots = [];
    for (let i = 0; i < KNOB_COUNT; i++) {
      const spec = specs[i];
      if (!spec) { slots.push(null); continue; }
      const value = this.getValue(spec);
      slots.push({ name: spec.name, valueText: formatValue(spec, value), norm: toNorm(spec, value) });
    }

    let footerRight = '';
    let footerAlert = false;
    if (audio.state === 'off') { footerRight = 'TOUCH FOR SOUND'; footerAlert = true; }
    else if (audio.state === 'starting') footerRight = 'STARTING AUDIO';
    else if (audio.state === 'error') { footerRight = 'AUDIO ERROR'; footerAlert = true; }
    else footerRight = Number.isFinite(audio.latencyMs) ? `OUT ${audio.latencyMs.toFixed(0)}MS` : 'AUDIO ON';

    const page = this.visiblePage(ch);
    const len = this.pattern.length;
    return {
      channelLabel: `CH${ch + 1} ${instrumentName(c.instrument)}`,
      patternLabel,
      stepsLabel: len > 16 ? `${page * 16 + 1}-${Math.min(len, page * 16 + 16)}/${len}` : `${len} STEPS`,
      bpmText: this.project.bpm.toFixed(1),
      playing: this.playing,
      motion: this.motion,
      lanes,
      modeLabel: this.mode === 'record' ? 'REC' : 'PLAY',
      pageName: PAGES.find((p) => p.id === this.page)?.label ?? '',
      keyboardLabel: this.keyboard ? `KEYS ${noteName(this.octave[ch])}` : '',
      dynamicLabel: this.dynamic === 'normal' ? '' : this.dynamic.toUpperCase(),
      slots,
      touchedSlot: this.touchedSlot,
      peak: audio.peak,
      footerRight,
      footerAlert,
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }
}
