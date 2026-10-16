/**
 * App controller: owns the project (source of truth on the UI side), turns ControlSurface
 * events into project edits + engine messages, persists the session and builds the
 * screen view-model.
 */
import type { ControlEvent } from '../controls/ControlSurface';
import { formatValue, toNorm, toValue, type ParamSpec } from '../engine/params';
import { GLOBAL_PARAMS, MIX_PARAMS } from '../engine/mixParams';
import {
  ACTIVE_CHANNELS, NUM_CHANNELS, PATTERN_NAMES, type Project,
} from '../engine/project';
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';
import { instrumentName, instrumentParams } from '../instruments/registry';
import { saveSession } from '../storage/session';
import { KNOB_COUNT, STEP_BUTTONS, type Panel } from './Panel';
import type { ScreenView } from './views';

export type PageId = 'sound' | 'mix' | 'global';
export const PAGES: readonly { id: PageId; label: string }[] = [
  { id: 'sound', label: 'SOUND' },
  { id: 'mix', label: 'MIX' },
  { id: 'global', label: 'GLOBAL' },
];

type Status = Extract<WorkletToMain, { type: 'status' }>;

export interface AudioInfo {
  state: 'off' | 'starting' | 'on' | 'error';
  latencyMs: number;
  peak: number;
}

export class App {
  selected = 0;
  page: PageId = 'sound';
  playing = false;
  private touchedSlot = -1;
  private touchedAt = 0;
  private status: Status | null = null;

  constructor(
    readonly project: Project,
    private readonly panel: Panel,
    private send: (msg: MainToWorklet) => void,
  ) {
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
      this.project.channels[this.selected].activePattern = pattern;
      this.send({ type: 'selectPattern', channel: this.selected, pattern, immediate: false });
      this.save();
    } else if (id.startsWith('page:')) {
      this.page = id.slice(5) as PageId;
      this.touchedSlot = -1;
    } else if ((m = /^step(\d+)$/.exec(id))) {
      this.toggleStep(Number(m[1]) - 1);
    }
    this.refreshPanel();
  }

  private toggleStep(index: number): void {
    const ch = this.selected;
    const c = this.project.channels[ch];
    const pattern = c.activePattern;
    const step = c.patterns[pattern].steps[index];
    step.active = !step.active;
    this.send({ type: 'setStep', channel: ch, pattern, index, step });
    // Audition when stopped so programming makes a sound.
    if (step.active && !this.playing) {
      this.send({ type: 'trigger', channel: ch, note: step.note, velocity: step.velocity });
    }
    this.save();
  }

  private pageSpecs(): readonly ParamSpec[] {
    if (this.page === 'mix') return MIX_PARAMS;
    if (this.page === 'global') return GLOBAL_PARAMS;
    return instrumentParams(this.project.channels[this.selected].instrument);
  }

  private getValue(spec: ParamSpec): number {
    const c = this.project.channels[this.selected];
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
    const c = this.project.channels[ch];
    if (this.page === 'sound') {
      c.sound[spec.id] = value;
      this.send({ type: 'setSound', channel: ch, id: spec.id, value });
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

  /** Knob labels/positions and button lights that change on selection, not per frame. */
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
  }

  /** Per-frame updates: step lights, playhead, pending pattern blink. */
  updateFrame(now: number): void {
    const ch = this.selected;
    const c = this.project.channels[ch];
    const steps = c.patterns[c.activePattern].steps;
    const playingPattern = this.status?.patterns[ch] ?? c.activePattern;
    const head = this.playing && playingPattern === c.activePattern ? (this.status?.steps[ch] ?? -1) : -1;
    for (let i = 0; i < STEP_BUTTONS; i++) {
      this.panel.setButtonFlag(`step${i + 1}`, 'lit', steps[i].active);
      this.panel.setButtonFlag(`step${i + 1}`, 'head', head === i);
    }
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
    const c = this.project.channels[ch];
    const playingPattern = this.status?.patterns[ch] ?? c.activePattern;
    const patternLabel = this.playing && playingPattern !== c.activePattern
      ? `PAT ${PATTERN_NAMES[playingPattern]}>${PATTERN_NAMES[c.activePattern]}`
      : `PAT ${PATTERN_NAMES[c.activePattern]}`;

    const lanes = [];
    for (let i = 0; i < ACTIVE_CHANNELS; i++) {
      const lc = this.project.channels[i];
      // The selected lane shows the pattern being edited; others show what is heard.
      const shown = i === ch ? lc.activePattern : (this.status?.patterns[i] ?? lc.activePattern);
      const heard = this.status?.patterns[i] ?? lc.activePattern;
      lanes.push({
        name: `${i + 1}${instrumentName(lc.instrument).slice(0, 4)}`,
        steps: lc.patterns[shown].steps.slice(0, 16).map((s) => s.active),
        playhead: this.playing && shown === heard ? (this.status?.steps[i] ?? -1) : -1,
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

    return {
      channelLabel: `CH${ch + 1} ${instrumentName(c.instrument)}`,
      patternLabel,
      bpmText: this.project.bpm.toFixed(1),
      playing: this.playing,
      lanes,
      pageName: PAGES.find((p) => p.id === this.page)?.label ?? '',
      slots,
      touchedSlot: this.touchedSlot,
      peak: audio.peak,
      footerRight,
      footerAlert,
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }
}
