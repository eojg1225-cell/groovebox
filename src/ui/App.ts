/**
 * App controller: owns the project (source of truth on the UI side), turns ControlSurface
 * events into project edits + engine messages, persists the session and builds the
 * screen view-models.
 *
 * Modes (selected at the top of the panel):
 *  RECORD  building patterns. Patterns switch at once. Drums: strip toggles steps (with
 *          the armed accent/ghost), VIEW pages long patterns. Pitched: step-entry keyboard
 *          (note at the cursor, then advance; ◀ ▶ REST).
 *  PLAY    performing. Nothing is recorded: the strip is a keyboard for every track
 *          (drums play chromatically), patterns switch at loop end, the view follows
 *          the playhead.
 *  DESIGN  sound design for the selected track: its core parameters (SOUND), TRACK
 *          (type, preset, mix, sends, live-knob assignment, chord), FX and GLOBAL.
 *          The strip is an audition keyboard.
 * In RECORD and PLAY the 12 knobs are the live knobs: one module per track, two each,
 * assigned on the TRACK page. Only non-coarse parameters can be assigned.
 * FX 1-3 (RECORD / PLAY): the knobs and the screen switch to that bus's controls (FX 1 =
 * the drum bus, FX 2 / 3 = sends); the channel buttons then add / remove tracks.
 * CLEAR (held): tap a step to clear it, or a channel button to clear that track's pattern.
 * MOTION REC (RECORD mode, while playing): live-knob moves on instrument parameters
 * become per-step locks on that track, and keyboard notes are written to the nearest step.
 */
import type { ControlEvent } from '../controls/ControlSurface';
import { choice, formatValue, toNorm, toValue, type ParamSpec } from '../engine/params';
import { EFFECT_INTENSITY, EFFECT_WET, GLOBAL_PARAMS, MIX_PARAMS, type MixId } from '../engine/mixParams';
import { LFO_PARAMS, type LfoId } from '../engine/lfo';
import { DRUM_BUS_PARAMS, EFFECTS } from '../fx';
import { CHORD_NAMES } from '../engine/chords';
import {
  MAX_STEPS, NUM_CHANNELS, PATTERN_NAMES, STEP_LENGTHS,
  setStepDynamic, stepDynamic, type ChannelState, type Dynamic, type Project, type SoundKind, type Step,
} from '../engine/project';
import { applyPreset } from '../engine/defaultProject';
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';
import { INSTRUMENTS, SOUND_KINDS, isDrum, paramSpec, presetSound } from '../instruments/registry';
import { saveSession } from '../storage/session';
import { macroSound, timbreName } from '../instruments/macros';
import { savePatch, saveProject, userPatches } from '../storage/saved';
import { DESIGN_PAGE_BUTTONS, FX_SEND_BUTTONS, KNOB_COUNT, KNOBS_PER_ROW, MODES, STEP_BUTTONS, type Panel } from './Panel';
import type { DesignView, LaneCell, LiveView } from './views';

export type Mode = 'record' | 'play' | 'design';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}
const isBlackKey = (n: number) => NOTE_NAMES[n % 12].length > 1;

type Status = Extract<WorkletToMain, { type: 'status' }>;

/** Steps covered by an earlier note's gate (ties), as a boolean per step. */
function tiedSteps(steps: Step[], length: number): boolean[] {
  const tied = new Array<boolean>(steps.length).fill(false);
  let coverEnd = -1;
  for (let i = 0; i < length; i++) {
    if (steps[i].active) coverEnd = i + Math.max(1, steps[i].gate) - 1;
    else if (i <= coverEnd) tied[i] = true;
  }
  return tied;
}

/** Note sounding at step `head`, including notes tied over from earlier steps; -1 if none. */
function soundingNote(steps: Step[], head: number): number {
  for (let i = head; i >= 0; i--) {
    if (steps[i].active) return i + Math.max(1, steps[i].gate) > head ? steps[i].note : -1;
  }
  return -1;
}
type Recorded = Extract<WorkletToMain, { type: 'recordedNote' | 'recordedLock' }>;

export interface AudioInfo {
  state: 'off' | 'starting' | 'on' | 'error';
  latencyMs: number;
  peak: number;
}

/** What one knob controls right now. */
interface KnobTarget {
  label: string;
  spec: ParamSpec;
  channel: number;
  get(): number;
  set(value: number): void;
  highlight?: boolean;
}

const MIX_PREFIX = 'mix:';
type GlobalId = 'bpm' | 'swing' | 'master' | 'lofi';

export class App {
  selected = 0;
  mode: Mode = 'record';
  designPage = 0;
  /** RING armed: new hits ring until the next hit or rest. */
  ring = false;
  /** REST armed (drum tracks): tapping a step places / removes a rest marker. */
  restArm = false;
  dynamic: Dynamic = 'normal';
  playing = false;
  private readonly viewPage: number[] = new Array(NUM_CHANNELS).fill(0);
  private readonly cursor: number[] = new Array(NUM_CHANNELS).fill(0);
  private readonly octave: number[];
  /** Strip button -> note being held (keyboard), so release ends the right note. */
  private readonly heldNotes = new Map<number, number>();
  /** Send shown on the knobs in RECORD/PLAY (1-3), 0 = the tracks' live knobs. */
  private fxView = 0;
  /** SOUND page: 0 = the shared sound page, 1 = the type's detail page. */
  private soundSub = 0;
  /** CLEAR held, and whether anything was cleared while it was. */
  private clearHeld = false;
  private clearUsed = false;
  /** Step entry in progress: the key held down and the step it wrote (for ties). */
  private entry: { button: number; index: number } | null = null;
  /** Short confirmation shown on the screen header (e.g. after saving). */
  private message = '';
  private messageUntil = 0;
  private touchedKnob = -1;
  private touchedAt = 0;
  private status: Status | null = null;
  private targets: (KnobTarget | null)[] = [];

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
      step.gate = m.gate;
    } else {
      step.locks = { ...step.locks, [m.id]: m.value };
    }
    this.save();
  }

  // ---------------------------------------------------------------- helpers

  private get channel(): ChannelState {
    return this.project.channels[this.selected];
  }

  private get pattern() {
    return this.channel.patterns[this.channel.activePattern];
  }

  /**
   * Pitched tracks always get a keyboard; drums only show steps while recording.
   * Holding CLEAR turns the strip into steps (to clear) in RECORD and PLAY.
   */
  private get keyboard(): boolean {
    if (this.clearHeld && this.mode !== 'design') return false;
    return !isDrum(this.channel.instrument) || this.mode !== 'record';
  }

  /** RECORD / PLAY with a bus open: knobs and screen show that bus. */
  get sendOpen(): boolean {
    return this.mode !== 'design' && this.fxView > 0;
  }

  /** Whether a track is on bus n (1 = the drum bus, 2-3 = its send). */
  private onBus(c: ChannelState, n: number): boolean {
    return n === 1 ? c.fx1 : c.fxSend === n;
  }

  /** Put a track on / take it off bus n. */
  private toggleBus(ch: number, n: number): void {
    const c = this.project.channels[ch];
    if (n === 1) {
      c.fx1 = !c.fx1;
      this.send({ type: 'setDrumBus', channel: ch, on: c.fx1 });
    } else {
      c.fxSend = c.fxSend === n ? 0 : n;
      this.send({ type: 'setRouting', channel: ch, send: c.fxSend });
    }
    this.flash(`${this.kindName(c)} ${this.onBus(c, n) ? '->' : 'OFF'} FX ${n}`);
    this.save();
  }

  /** Live recording: RECORD mode while the sequencer runs (stopped = step entry). */
  private get recording(): boolean {
    return this.mode === 'record' && this.playing;
  }

  private kindName(c: ChannelState): string {
    return c.instrument === 'none' ? '---' : INSTRUMENTS[c.instrument].name;
  }

  /** Factory presets followed by the user's saved patches for a track type. */
  private presetNames(kind: SoundKind): string[] {
    return [...INSTRUMENTS[kind].presets.map((p) => p.name), ...userPatches(kind).map((p) => p.name)];
  }

  private presetName(c: ChannelState): string {
    if (c.instrument === 'none') return '';
    return this.presetNames(c.instrument)[c.presets[c.instrument] ?? 0] ?? '';
  }

  /** Load factory preset or user patch `index` (in presetNames order) onto a track. */
  private loadPreset(ch: number, kind: SoundKind, index: number): void {
    const c = this.project.channels[ch];
    const factory = INSTRUMENTS[kind].presets.length;
    if (index < factory) {
      applyPreset(c, kind, index);
    } else {
      const patch = userPatches(kind)[index - factory];
      if (!patch) return;
      const defaults: Record<string, number> = {};
      for (const p of INSTRUMENTS[kind].params) defaults[p.id] = p.defaultValue;
      c.sounds[kind] = { ...defaults, ...patch.values };
      c.presets[kind] = index;
      c.live = [...patch.live];
    }
    const sound = c.sounds[kind] ?? {};
    for (const id in sound) this.send({ type: 'setSound', channel: ch, id, value: sound[id] });
  }

  private flash(text: string): void {
    this.message = text;
    this.messageUntil = performance.now() + 2500;
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
    // Other lanes, PLAY mode and live recording follow the playhead's 16-step block.
    const following = ch !== this.selected || this.mode === 'play' || this.recording;
    let page: number;
    if (following) page = this.playing && head >= 0 && heard === c.activePattern ? Math.floor(head / 16) : 0;
    else if (!isDrum(c.instrument) && this.mode === 'record') page = Math.floor(this.cursor[ch] / 16);
    else page = this.viewPage[ch];
    return Math.min(page, this.pageCount(ch) - 1);
  }

  private sendStep(index: number, step: Step, ch = this.selected): void {
    const c = this.project.channels[ch];
    this.send({ type: 'setStep', channel: ch, pattern: c.activePattern, index, step });
  }

  /** Pattern switching: immediate while building, at loop end while performing. */
  private get immediateSwitch(): boolean {
    return this.mode !== 'play';
  }

  // ---------------------------------------------------------------- knob targets

  /**
   * What a track's live knobs may control: the non-coarse sound parameters on its sound
   * page, the mixer (volume, pan, cutoff, send level) and the LFO rate and depths.
   */
  private liveCandidates(c: ChannelState): { id: string; spec: ParamSpec }[] {
    const list: { id: string; spec: ParamSpec }[] = [];
    if (c.instrument !== 'none') {
      const entry = INSTRUMENTS[c.instrument];
      for (const id of new Set([...entry.layout, ...entry.detail])) {
        const spec = id ? entry.params.find((p) => p.id === id) : undefined;
        if (spec && !spec.coarse) list.push({ id: spec.id, spec });
      }
    }
    for (const spec of MIX_PARAMS) list.push({ id: MIX_PREFIX + spec.id, spec });
    for (const id of ['rate', 'vol', 'pitch'] as const) list.push({ id: `lfo:${id}`, spec: LFO_PARAMS[id] });
    return list;
  }

  private paramTarget(ch: number, id: string, label?: string, highlight?: boolean): KnobTarget | null {
    const c = this.project.channels[ch];
    if (id.startsWith('lfo:')) {
      const lfoId = id.slice(4) as LfoId;
      const spec = LFO_PARAMS[lfoId];
      return {
        label: label ?? spec.name, spec, channel: ch, highlight,
        get: () => c.lfo[lfoId],
        set: (v) => { c.lfo[lfoId] = v; this.send({ type: 'setLfo', channel: ch, id: lfoId, value: v }); },
      };
    }
    if (id === 'track:chord') {
      return {
        label: label ?? 'CHORD', spec: choice('chord', 'CHORD', CHORD_NAMES), channel: ch, highlight,
        get: () => c.chord,
        set: (v) => { c.chord = v; this.send({ type: 'setChord', channel: ch, chord: v }); },
      };
    }
    if (id.startsWith(MIX_PREFIX)) {
      const mixId = id.slice(MIX_PREFIX.length) as MixId;
      const spec = MIX_PARAMS.find((p) => p.id === mixId);
      if (!spec) return null;
      const field = mixId === 'send' ? 'sendLevel' : mixId;
      return {
        label: label ?? spec.name, spec, channel: ch, highlight,
        get: () => c[field],
        set: (v) => {
          c[field] = v;
          this.send({ type: 'setMix', channel: ch, id: mixId, value: v });
        },
      };
    }
    if (c.instrument === 'none') return null;
    const kind = c.instrument;
    const spec = paramSpec(kind, id);
    if (!spec) return null;
    return {
      label: label ?? spec.name, spec, channel: ch, highlight,
      get: () => c.sounds[kind]?.[id] ?? spec.defaultValue,
      set: (v) => {
        const sound = (c.sounds[kind] ??= {});
        sound[id] = v;
        this.send({ type: 'setSound', channel: ch, id, value: v });
        if (id === 'timbre' || id === 'intensity') {
          // Macro: TIMBRE / INTENSITY set the underlying sound parameters.
          const macro = macroSound(kind, sound.timbre ?? 0.33, sound.intensity ?? 0.5, INSTRUMENTS[kind].params);
          for (const pid in macro) {
            sound[pid] = macro[pid];
            this.send({ type: 'setSound', channel: ch, id: pid, value: macro[pid] });
          }
        }
      },
    };
  }

  /** Sound design pages for the selected track: instrument pages, then TRACK, GLOBAL. */
  private designPages(): { name: string; targets: () => (KnobTarget | null)[] }[] {
    const ch = this.selected;
    const c = this.channel;
    const pages: { name: string; targets: () => (KnobTarget | null)[] }[] = [];
    if (c.instrument !== 'none') {
      // SOUND again flips between the shared sound page and the type's detail page.
      const entry = INSTRUMENTS[c.instrument];
      const layout = this.soundSub ? entry.detail : entry.layout;
      pages.push({ name: this.soundSub ? 'DETAIL' : 'SOUND', targets: () => layout.map((id) => (id ? this.paramTarget(ch, id) : null)) });
    }
    pages.push({ name: 'TRACK', targets: () => this.trackTargets() });
    pages.push({
      name: 'GLOBAL',
      targets: () => GLOBAL_PARAMS.map((spec) => ({
        label: spec.name, spec, channel: ch,
        get: () => this.getGlobal(spec.id as GlobalId),
        set: (v: number) => this.setGlobal(spec.id as GlobalId, v),
      })),
    });
    return pages;
  }

  private getGlobal(id: GlobalId): number {
    return this.project[id];
  }

  private setGlobal(id: GlobalId, v: number): void {
    this.project[id] = v;
    this.send({ type: 'setGlobal', id, value: v });
  }

  /**
   * A bus's knobs (FX 1-3 in RECORD/PLAY). FX 1, the drum bus: two modules each for
   * STUTTER, DISTORT and LOW-PASS. FX 2 / 3: six modules = six effects, WET (return volume,
   * labelled with the effect) on top, INTENSITY (how hard it works) below.
   */
  private sendTargets(k: number): (KnobTarget | null)[] {
    if (k === 0) {
      const fx1 = this.project.fx1;
      return DRUM_BUS_PARAMS.map((spec): KnobTarget => ({
        label: spec.name, spec, channel: this.selected,
        get: () => fx1[spec.id] ?? spec.defaultValue,
        set: (v: number) => { fx1[spec.id] = v; this.send({ type: 'setDrumBusParam', id: spec.id, value: v }); },
      }));
    }
    const control = (control: 'wet' | 'int') => EFFECTS.map((fx, e): KnobTarget => {
      const grid = control === 'wet' ? this.project.sendWet : this.project.sendInt;
      return {
        label: control === 'wet' ? fx.name : 'INTENSITY',
        spec: control === 'wet' ? EFFECT_WET : EFFECT_INTENSITY,
        channel: this.selected,
        get: () => grid[k][e],
        set: (v: number) => { grid[k][e] = v; this.send({ type: 'setSendFx', send: k, effect: e, control, value: v }); },
      };
    });
    return [...control('wet'), ...control('int')];
  }

  /**
   * TRACK page. Row 1: type, preset, volume, pan, LIVE 1 and LIVE 2 (which parameters
   * the track's two live knobs control). Row 2: cutoff, send level, chord (pitched).
   * The send itself is chosen with FX 1/2/3.
   */
  private trackTargets(): (KnobTarget | null)[] {
    const ch = this.selected;
    const c = this.channel;
    const targets: (KnobTarget | null)[] = [];
    const typeSpec = choice('type', 'TYPE', SOUND_KINDS.map((k) => INSTRUMENTS[k].name));
    targets.push({
      label: 'TYPE', spec: typeSpec, channel: ch,
      get: () => Math.max(0, SOUND_KINDS.indexOf(c.instrument as SoundKind)),
      set: (v) => this.setType(SOUND_KINDS[v]),
    });
    if (c.instrument !== 'none') {
      const kind = c.instrument;
      targets.push({
        label: 'PRESET', spec: choice('preset', 'PRESET', this.presetNames(kind)), channel: ch,
        get: () => c.presets[kind] ?? 0,
        set: (v) => this.loadPreset(ch, kind, v),
      });
    } else {
      targets.push(null);
    }
    targets.push(this.paramTarget(ch, 'mix:volume'), this.paramTarget(ch, 'mix:pan'));
    const candidates = this.liveCandidates(c);
    const liveTargets: KnobTarget[] = [];
    for (let r = 0; r < 2; r++) {
      const spec = choice(`live${r}`, `LIVE ${r + 1}`, candidates.map((x) => x.spec.name));
      liveTargets.push({
        label: `LIVE ${r + 1}`, spec, channel: ch,
        get: () => Math.max(0, candidates.findIndex((x) => x.id === c.live[r])),
        set: (v) => { c.live[r] = candidates[v].id; },
      });
    }
    targets.push(...liveTargets);
    targets.push(this.paramTarget(ch, 'mix:cutoff'), this.paramTarget(ch, 'mix:send'));
    if (!isDrum(c.instrument)) {
      targets.push({
        label: 'CHORD', spec: choice('chord', 'CHORD', CHORD_NAMES), channel: ch,
        get: () => c.chord,
        set: (v) => { c.chord = v; this.send({ type: 'setChord', channel: ch, chord: v }); },
      });
    }
    return targets;
  }

  private setType(kind: SoundKind): void {
    const c = this.channel;
    if (c.instrument === kind) return;
    if (c.sounds[kind]) c.instrument = kind;
    else applyPreset(c, kind, 0);
    // Live knobs that pointed at the old instrument's parameters fall back to the defaults.
    const valid = new Set([...INSTRUMENTS[kind].params.map((p) => p.id), ...MIX_PARAMS.map((p) => MIX_PREFIX + p.id)]);
    c.live = c.live.map((id, r) => (valid.has(id) ? id : r === 0 ? 'mix:volume' : 'mix:cutoff')) as [string, string];
    // Locks belong to the old instrument's parameters.
    for (const p of c.patterns) for (const s of p.steps) delete s.locks;
    this.send({ type: 'setInstrument', channel: this.selected, kind, sound: c.sounds[kind] ?? {} });
    this.octave[this.selected] = INSTRUMENTS[kind].baseNote;
    if (isDrum(kind)) {
      c.chord = 0;
      this.send({ type: 'setChord', channel: this.selected, chord: 0 });
    }
  }

  /** The 12 knob targets for the current mode. */
  private computeTargets(): (KnobTarget | null)[] {
    if (this.mode === 'design') {
      const pages = this.designPages();
      this.designPage = Math.min(this.designPage, pages.length - 1);
      const t = pages[this.designPage].targets();
      return Array.from({ length: KNOB_COUNT }, (_, i) => t[i] ?? null);
    }
    if (this.fxView > 0) return this.sendTargets(this.fxView - 1);
    // Live knobs: column = track, rows = live knob 1 / 2.
    const out: (KnobTarget | null)[] = [];
    for (let row = 0; row < 2; row++) {
      for (let ch = 0; ch < KNOBS_PER_ROW; ch++) {
        const c = this.project.channels[ch];
        out.push(this.paramTarget(ch, c.live[row], undefined, ch === this.selected));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- controls

  private onControl(e: ControlEvent): void {
    if (e.type === 'encoder') return this.onEncoder(e.id, e.delta);
    if (e.type === 'knob' && e.id.startsWith('m')) return this.onMasterKnob(e.id, e.value);
    if (e.type === 'knob') return this.onKnob(Number(e.id.slice(1)) - 1, e.value);
    if (e.type !== 'button') return;
    const id = e.id;
    let m: RegExpExecArray | null;
    if (!e.pressed) {
      if ((m = /^step(\d+)$/.exec(id))) this.releaseKey(Number(m[1]) - 1);
      if (id === 'clear') {
        this.clearHeld = false;
        if (!this.clearUsed) this.flash('HOLD CLEAR + STEP / TRACK');
        this.refreshPanel();
      }
      return;
    }
    if (id === 'clear') {
      this.clearHeld = true;
      this.clearUsed = false;
      this.refreshPanel();
      return;
    }
    if (this.clearHeld && (m = /^ch(\d)$/.exec(id))) {
      this.clearTrack(Number(m[1]) - 1);
      this.refreshPanel();
      return;
    }
    if (id === 'play') {
      this.playing = !this.playing;
      this.send({ type: 'transport', playing: this.playing });
    } else if (id.startsWith('mode:')) {
      this.mode = id.slice(5) as Mode;
      this.touchedKnob = -1;
    } else if ((m = /^ch(\d)$/.exec(id)) && this.sendOpen) {
      // A bus is open: the channel buttons add / remove tracks from it.
      this.toggleBus(Number(m[1]) - 1, this.fxView);
    } else if ((m = /^ch(\d)$/.exec(id))) {
      this.selected = Number(m[1]) - 1;
      this.designPage = 0;
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
      this.send({ type: 'selectPattern', channel: this.selected, pattern, immediate: this.immediateSwitch });
      this.save();
    } else if ((m = /^dpage(\d)$/.exec(id))) {
      const page = Number(m[1]);
      const hasSound = this.channel.instrument !== 'none';
      if (page === 0 && hasSound && this.designPage === 0) this.soundSub = 1 - this.soundSub;
      else if (page === 0) this.soundSub = 0;
      this.designPage = page;
      this.touchedKnob = -1;
    } else if ((m = /^fx([1-3])$/.exec(id))) {
      const n = Number(m[1]);
      if (this.mode === 'design') {
        // Sound design: put the selected track on / off this bus.
        this.toggleBus(this.selected, n);
      } else {
        // RECORD / PLAY: show this send's controls on the knobs (again = back to tracks).
        this.fxView = this.fxView === n ? 0 : n;
        this.touchedKnob = -1;
      }
    } else if (id === 'savepatch') {
      const c = this.channel;
      if (c.instrument === 'none') {
        this.flash('NOTHING TO SAVE');
      } else {
        const kind = c.instrument;
        const name = savePatch(kind, c.sounds[kind] ?? presetSound(kind, 0), c.live);
        if (name) {
          c.presets[kind] = this.presetNames(kind).lastIndexOf(name);
          this.save();
          this.flash(`SAVED ${INSTRUMENTS[kind].name} ${name}`);
        } else {
          this.flash('SAVE FAILED');
        }
      }
    } else if (id === 'saveproject') {
      this.flash(saveProject(this.project) ? 'PROJECT SAVED' : 'SAVE FAILED');
    } else if (id === 'ring') {
      this.ring = !this.ring;
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
    } else if ((id === 'cur-' || id === 'cur+') && this.entry) {
      // Holding a key: ▶ ties the note over one more step, ◀ shortens it.
      this.tie(id === 'cur+' ? 1 : -1);
    } else if (id === 'cur-' || id === 'cur+') {
      this.moveCursor(id === 'cur+' ? 1 : -1);
    } else if (id === 'rest' && !this.keyboard) {
      // Drum steps: arm REST, then tap steps to place / remove rest markers.
      this.restArm = !this.restArm;
    } else if (id === 'rest') {
      // Step entry: a rest marker at the cursor (ends a ringing note), then advance.
      const step = this.pattern.steps[this.cursor[this.selected]];
      step.active = false;
      step.ring = false;
      step.rest = true;
      delete step.locks;
      this.sendStep(this.cursor[this.selected], step);
      this.moveCursor(1);
      this.save();
    } else if ((m = /^step(\d+)$/.exec(id))) {
      this.onStrip(Number(m[1]) - 1);
    }
    this.refreshPanel();
  }

  private velocity(): number {
    return this.dynamic === 'accent' ? 1 : this.dynamic === 'ghost' ? 0.45 : 0.8;
  }

  private onStrip(button: number): void {
    const ch = this.selected;
    if (this.clearHeld && this.mode !== 'design') {
      const index = this.visiblePage(ch) * 16 + button;
      if (index < this.pattern.length) this.clearStep(index);
      return;
    }
    if (this.keyboard) {
      const note = this.octave[ch] + button;
      const vel = this.velocity();
      this.heldNotes.set(button, note);
      if (this.mode === 'record' && this.recording) {
        // Live recording: the worklet writes the note to the nearest step.
        this.send({ type: 'recordNote', channel: ch, note, velocity: vel, accent: this.dynamic === 'accent' });
      } else if (this.mode === 'record') {
        // Step entry: write a one-step note at the cursor and hear it. The cursor moves
        // on when the key is released (past any steps tied with ▶ meanwhile).
        const index = this.cursor[ch];
        const step = this.pattern.steps[index];
        step.active = true;
        step.note = note;
        step.gate = 1;
        step.ring = this.ring;
        step.rest = false;
        setStepDynamic(step, this.dynamic);
        this.sendStep(index, step);
        this.send({ type: 'trigger', channel: ch, note, velocity: vel });
        this.entry = { button, index };
        this.save();
      } else {
        // PLAY and SOUND DESIGN: play only, never recorded.
        this.send({ type: 'trigger', channel: ch, note, velocity: vel });
      }
      return;
    }

    // Drum lane. REST armed: toggle a rest marker. Otherwise: place a hit with the armed
    // dynamic / RING, re-paint a hit that differs from what's armed, or remove it.
    const index = this.visiblePage(ch) * 16 + button;
    if (index >= this.pattern.length) return;
    const step = this.pattern.steps[index];
    const armed = this.dynamic !== 'normal' || this.ring;
    if (this.restArm) {
      step.rest = !step.rest;
      step.active = false;
      step.ring = false;
      delete step.locks;
    } else if (!step.active) {
      step.active = true;
      step.rest = false;
      step.ring = this.ring;
      setStepDynamic(step, this.dynamic);
      if (!this.playing) this.send({ type: 'trigger', channel: ch, note: step.note, velocity: step.velocity });
    } else if (armed && (stepDynamic(step) !== this.dynamic || !!step.ring !== this.ring)) {
      setStepDynamic(step, this.dynamic);
      step.ring = this.ring;
    } else {
      step.active = false;
      step.ring = false;
      delete step.locks;
    }
    this.sendStep(index, step);
    this.save();
  }

  /** CLEAR + step: empty it; a note tied over it now ends just before it. */
  private clearStep(index: number): void {
    const steps = this.pattern.steps;
    for (let j = index - 1; j >= 0; j--) {
      if (!steps[j].active) continue;
      if (j + steps[j].gate > index) {
        steps[j].gate = index - j;
        this.sendStep(j, steps[j]);
      }
      break;
    }
    const step = steps[index];
    step.active = false;
    step.ring = false;
    step.rest = false;
    step.gate = 1;
    delete step.locks;
    this.sendStep(index, step);
    this.clearUsed = true;
    this.save();
  }

  /** CLEAR + channel: empty that track's current pattern (its sound stays). */
  private clearTrack(ch: number): void {
    const c = this.project.channels[ch];
    c.patterns[c.activePattern].steps.forEach((step, i) => {
      if (!step.active && !step.rest && !step.locks) return;
      step.active = false;
      step.ring = false;
      step.rest = false;
      step.gate = 1;
      delete step.locks;
      this.sendStep(i, step, ch);
    });
    this.clearUsed = true;
    this.flash(`CLEARED ${ch + 1} ${this.kindName(c)} ${PATTERN_NAMES[c.activePattern]}`);
    this.save();
  }

  private releaseKey(button: number): void {
    const note = this.heldNotes.get(button);
    if (note === undefined) return;
    this.heldNotes.delete(button);
    this.send({ type: 'release', channel: this.selected, note });
    if (this.entry?.button === button) {
      const len = this.pattern.length;
      this.cursor[this.selected] = (this.entry.index + this.pattern.steps[this.entry.index].gate) % len;
      this.entry = null;
      this.refreshPanel();
    }
  }

  /** Lengthen (+1) or shorten (-1) the note being entered; tied-over steps are cleared. */
  private tie(delta: number): void {
    if (!this.entry) return;
    const { index } = this.entry;
    const step = this.pattern.steps[index];
    const gate = Math.max(1, Math.min(this.pattern.length - index, step.gate + delta));
    if (gate === step.gate) return;
    step.gate = gate;
    if (delta > 0) {
      const covered = this.pattern.steps[index + gate - 1];
      if (covered.active || covered.locks) {
        covered.active = false;
        delete covered.locks;
        this.sendStep(index + gate - 1, covered);
      }
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
    if (this.cursor[this.selected] >= this.pattern.length) this.cursor[this.selected] = 0;
    if (this.viewPage[this.selected] >= this.pageCount()) this.viewPage[this.selected] = 0;
  }

  /** TEMPO and LO-FI master knobs. */
  private onMasterKnob(id: string, norm: number): void {
    const gid: GlobalId = id === 'mtempo' ? 'bpm' : 'lofi';
    const spec = GLOBAL_PARAMS.find((p) => p.id === gid) as ParamSpec;
    let value = toValue(spec, norm);
    if (spec.decimals !== undefined) value = Math.round(value * 10 ** spec.decimals) / 10 ** spec.decimals;
    this.setGlobal(gid, value);
    this.flash(`${spec.name} ${formatValue(spec, value)}`);
    this.save();
  }

  /**
   * Relative encoder turn (hardware encoders; the mouse wheel on screen): one detent =
   * one 0-127 step, one option for discrete choices, 0.1 BPM for TEMPO.
   */
  private onEncoder(id: string, delta: number): void {
    if (id === 'mtempo' || id === 'mlofi') {
      const gid: GlobalId = id === 'mtempo' ? 'bpm' : 'lofi';
      const spec = GLOBAL_PARAMS.find((p) => p.id === gid) as ParamSpec;
      const step = gid === 'bpm' ? 0.1 : 1 / 127;
      const value = Math.min(spec.max, Math.max(spec.min, Math.round((this.project[gid] + delta * step) * 1000) / 1000));
      this.setGlobal(gid, value);
      this.flash(`${spec.name} ${formatValue(spec, value)}`);
      this.save();
      this.refreshPanel();
      return;
    }
    const slot = Number(id.slice(1)) - 1;
    const t = this.targets[slot];
    if (!t) return;
    const value = t.spec.options
      ? Math.min(t.spec.options.length - 1, Math.max(0, t.get() + delta))
      : toValue(t.spec, Math.min(1, Math.max(0, Math.round(toNorm(t.spec, t.get()) * 127 + delta) / 127)));
    this.applyKnob(slot, t, value);
    this.refreshPanel();
  }

  private onKnob(slot: number, norm: number): void {
    const t = this.targets[slot];
    if (!t) return;
    this.applyKnob(slot, t, toValue(t.spec, norm));
  }

  private applyKnob(slot: number, t: KnobTarget, raw: number): void {
    let value = raw;
    if (t.spec.decimals !== undefined && !t.spec.options) {
      const f = Math.pow(10, t.spec.decimals);
      value = Math.round(value * f) / f;
    }
    if (t.spec.options && value === t.get()) return; // detent: nothing changed
    t.set(value);
    this.touchedKnob = slot;
    this.touchedAt = performance.now();
    this.save();
    // Discrete choices can change what other knobs mean (type, preset, live assignment).
    if (t.spec.options) this.refreshPanel();
  }

  private save(): void {
    saveSession(this.project);
  }

  // ---------------------------------------------------------------- display

  /** Knob labels/positions and button states that change on input, not per frame. */
  refreshPanel(): void {
    this.targets = this.computeTargets();
    this.targets.forEach((t, i) => {
      this.panel.configureKnob(
        i,
        t ? { label: t.label, value: toNorm(t.spec, t.get()), defaultValue: toNorm(t.spec, t.spec.defaultValue), highlight: t.highlight } : null,
      );
    });

    for (const m of MODES) this.panel.setButtonLit(`mode:${m.id}`, m.id === this.mode);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const c = this.project.channels[ch];
      // While a bus is open (RECORD/PLAY), channel buttons show which tracks are on it.
      const sendView = this.sendOpen;
      this.panel.setButtonLit(`ch${ch + 1}`, sendView ? this.onBus(c, this.fxView) : ch === this.selected);
      this.panel.setButtonFlag(`ch${ch + 1}`, 'send', sendView);
      this.panel.setButtonLit(`mute${ch + 1}`, c.mute);
      this.panel.setButtonText(`ch${ch + 1}`, `${ch + 1}<small>${this.kindName(c)}</small>`);
      this.panel.setBadge(ch, this.mode === 'design' || sendView ? 'dim' : ch === this.selected ? 'lit' : '');
    }
    for (const [id, gid] of [['mtempo', 'bpm'], ['mlofi', 'lofi']] as const) {
      const spec = GLOBAL_PARAMS.find((p) => p.id === gid) as ParamSpec;
      this.panel.configureMaster(id, toNorm(spec, this.project[gid]), toNorm(spec, spec.defaultValue));
    }
    for (let n = 1; n <= FX_SEND_BUTTONS; n++) {
      this.panel.setButtonLit(`fx${n}`, this.mode === 'design' ? this.onBus(this.channel, n) : this.fxView === n);
    }
    const pages = this.mode === 'design' ? this.designPages() : [];
    for (let i = 0; i < DESIGN_PAGE_BUTTONS; i++) {
      const page = pages[i];
      this.panel.setButtonText(`dpage${i}`, !page ? '' : i === 0 && this.channel.instrument !== 'none' ? `${page.name}<small>${this.soundSub + 1}/2</small>` : page.name);
      this.panel.setButtonEnabled(`dpage${i}`, !!page);
      this.panel.setButtonLit(`dpage${i}`, !!page && i === this.designPage);
    }
    this.panel.setButtonLit('clear', this.clearHeld);
    this.panel.setButtonEnabled('clear', this.mode !== 'design');
    this.panel.setButtonLit('play', this.playing);
    this.panel.setButtonText('play', this.playing ? 'STOP' : 'PLAY');

    const rec = this.mode === 'record';
    const kb = this.keyboard;
    this.panel.setButtonLit('ring', this.ring);
    this.panel.setButtonEnabled('ring', rec);
    this.panel.setButtonLit('dyn:accent', this.dynamic === 'accent');
    this.panel.setButtonLit('dyn:ghost', this.dynamic === 'ghost');
    this.panel.setButtonText('len', `${this.pattern.length}<small>STEPS</small>`);
    this.panel.setButtonEnabled('steppage', this.mode !== 'play' && !(kb && rec) && this.pageCount() > 1);
    for (const id of ['oct-', 'oct+']) this.panel.setButtonEnabled(id, kb);
    for (const id of ['cur-', 'cur+']) this.panel.setButtonEnabled(id, kb && rec);
    this.panel.setButtonEnabled('rest', rec);
    if (kb || !rec) this.restArm = false;
    this.panel.setButtonLit('rest', this.restArm);
    this.panel.root.classList.toggle('keyboard', kb);
  }

  /** Per-frame updates: strip lights/labels, LEDs, pending pattern blink. */
  updateFrame(now: number): void {
    const ch = this.selected;
    const c = this.channel;
    const pattern = this.pattern;
    const playingPattern = this.status?.patterns[ch] ?? c.activePattern;
    const heardHere = this.playing && playingPattern === c.activePattern;
    const head = heardHere ? (this.status?.steps[ch] ?? -1) : -1;
    const page = this.visiblePage(ch);
    const pitchedRecord = this.keyboard && this.mode === 'record' && !this.recording;
    const cursor = this.cursor[ch];

    // LEDs: the step being played (red while recording), the step-entry cursor, and while
    // a key is held in step entry, every step the note covers.
    const entryEnd = this.entry ? this.entry.index + pattern.steps[this.entry.index].gate - 1 : -1;
    for (let i = 0; i < STEP_BUTTONS; i++) {
      const index = page * 16 + i;
      let state: '' | 'on' | 'rec' | 'cursor' = '';
      if (pitchedRecord && (this.entry ? index >= this.entry.index && index <= entryEnd : index === cursor)) state = 'cursor';
      if (head === index) state = this.recording ? 'rec' : 'on';
      this.panel.setLed(i, state);
    }

    if (this.keyboard) {
      const sounding = soundingNote(pattern.steps, head);
      const cursorStep = pattern.steps[cursor];
      const cursorNote = pitchedRecord && cursorStep.active ? cursorStep.note : -1;
      for (let i = 0; i < STEP_BUTTONS; i++) {
        const id = `step${i + 1}`;
        const note = this.octave[ch] + i;
        this.panel.setButtonText(id, noteName(note));
        this.panel.setButtonFlag(id, 'black', isBlackKey(note));
        this.panel.setButtonFlag(id, 'lit', note === sounding);
        this.panel.setButtonFlag(id, 'cursor', note === cursorNote);
        for (const f of ['accent', 'ghost', 'head', 'off', 'ring', 'rest']) this.panel.setButtonFlag(id, f, false);
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
        this.panel.setButtonFlag(id, 'ring', d !== null && !!step.ring);
        this.panel.setButtonFlag(id, 'rest', !off && !step.active && !!step.rest);
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
    if (this.touchedKnob >= 0 && now - this.touchedAt > 4000) this.touchedKnob = -1;
  }

  private footer(audio: AudioInfo): { text: string; alert: boolean } {
    if (audio.state === 'off') return { text: 'TOUCH FOR SOUND', alert: true };
    if (audio.state === 'starting') return { text: 'STARTING AUDIO', alert: false };
    if (audio.state === 'error') return { text: 'AUDIO ERROR', alert: true };
    return { text: Number.isFinite(audio.latencyMs) ? `OUT ${audio.latencyMs.toFixed(0)}MS` : 'AUDIO ON', alert: false };
  }

  /** Knob value for the screen; TIMBRE shows the nearest named sound (e.g. CRASH). */
  private valueText(t: KnobTarget): string {
    const kind = this.project.channels[t.channel]?.instrument;
    if (t.spec.id === 'timbre' && kind && kind !== 'none') return timbreName(kind, t.get());
    return formatValue(t.spec, t.get());
  }

  private slots() {
    return this.targets.map((t) => (t ? {
      name: t.label,
      valueText: this.valueText(t),
      norm: toNorm(t.spec, t.get()),
      highlight: !!t.highlight,
    } : null));
  }

  private header() {
    const ch = this.selected;
    const c = this.channel;
    const playingPattern = this.status?.patterns[ch] ?? c.activePattern;
    return {
      channelLabel: `CH${ch + 1} ${this.kindName(c)}`,
      patternLabel: this.playing && playingPattern !== c.activePattern
        ? `PAT ${PATTERN_NAMES[playingPattern]}>${PATTERN_NAMES[c.activePattern]}`
        : `PAT ${PATTERN_NAMES[c.activePattern]}`,
      bpmText: this.project.bpm.toFixed(1),
      playing: this.playing,
      message: performance.now() < this.messageUntil ? this.message : '',
    };
  }

  liveView(now: number, audio: AudioInfo): LiveView {
    const ch = this.selected;
    const lanes = this.project.channels.map((lc, i) => {
      const heard = this.status?.patterns[i] ?? lc.activePattern;
      const shown = i === ch ? lc.activePattern : heard;
      const pat = lc.patterns[shown];
      const page = this.visiblePage(i);
      const head = this.playing && shown === heard ? (this.status?.steps[i] ?? -1) : -1;
      const pitched = !isDrum(lc.instrument);
      const tied = pitched ? tiedSteps(pat.steps, pat.length) : null;
      const cells: LaneCell[] = [];
      for (let k = 0; k < 16; k++) {
        const idx = page * 16 + k;
        const step = pat.steps[idx];
        cells.push({
          state: idx >= pat.length ? 'none' : step.active ? stepDynamic(step) : 'off',
          tie: !!tied?.[idx],
          note: pitched && i === ch && step.active ? NOTE_NAMES[step.note % 12] : '',
          locked: !!step.locks && Object.keys(step.locks).length > 0,
          ring: step.active && !!step.ring,
          rest: !step.active && !!step.rest,
        });
      }
      return {
        name: `${i + 1}${this.kindName(lc).slice(0, 4)}`,
        cells,
        playhead: head >= 0 && Math.floor(head / 16) === page ? head % 16 : -1,
        cursor: i === ch && pitched && this.mode === 'record' && Math.floor(this.cursor[i] / 16) === page ? this.cursor[i] % 16 : -1,
        muted: lc.mute,
        selected: i === ch,
      };
    });
    const page = this.visiblePage(ch);
    const len = this.pattern.length;
    const f = this.footer(audio);
    return {
      ...this.header(),
      stepsLabel: this.clearHeld ? 'CLEAR: STEP / TRACK' : len > 16 ? `${page * 16 + 1}-${Math.min(len, page * 16 + 16)}/${len}` : `${len} STEPS`,
      motion: this.recording && this.keyboard,
      lanes,
      modeLabel: this.mode === 'record' ? 'RECORD' : 'PLAY',
      keyboardLabel: this.keyboard ? `KEYS ${noteName(this.octave[ch])}` : '',
      dynamicLabel: this.dynamic === 'normal' ? '' : this.dynamic.toUpperCase(),
      slots: this.slots(),
      touchedSlot: this.touchedKnob,
      peak: audio.peak,
      footerRight: f.text,
      footerAlert: f.alert,
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }

  /** RECORD / PLAY with a bus open: the bus's knobs on screen, like a design page. */
  sendView(now: number, audio: AudioInfo): DesignView {
    const n = this.fxView;
    const f = this.footer(audio);
    const members = this.project.channels.flatMap((c, i) => (this.onBus(c, n) ? [String(i + 1)] : []));
    return {
      ...this.header(),
      channelLabel: n === 1 ? 'FX 1 DRUM BUS' : `FX ${n} SEND`,
      patternLabel: '',
      kindLabel: this.mode === 'record' ? 'RECORD' : 'PLAY',
      pages: ['FX 1', 'FX 2', 'FX 3'],
      page: n - 1,
      slots: this.slots(),
      touchedSlot: this.touchedKnob,
      liveLabel: members.length ? `TRACKS ${members.join(' ')}` : 'NO TRACKS',
      chordLabel: 'TAP 1-6',
      peak: audio.peak,
      footerRight: f.text,
      footerAlert: f.alert,
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }

  designView(now: number, audio: AudioInfo): DesignView {
    const c = this.channel;
    const pages = this.designPages();
    const f = this.footer(audio);
    const liveName = (id: string) => (id.startsWith(MIX_PREFIX)
      ? MIX_PARAMS.find((p) => MIX_PREFIX + p.id === id)?.name
      : paramSpec(c.instrument, id)?.name) ?? '-';
    return {
      ...this.header(),
      kindLabel: c.instrument !== 'none' && c.sounds[c.instrument]?.timbre !== undefined
        ? timbreName(c.instrument, c.sounds[c.instrument]!.timbre)
        : this.presetName(c),
      pages: pages.map((p) => p.name),
      page: this.designPage,
      slots: this.slots(),
      touchedSlot: this.touchedKnob,
      liveLabel: `LIVE ${liveName(c.live[0])} + ${liveName(c.live[1])}`,
      chordLabel: [c.fx1 ? 'FX1' : '', c.fxSend ? `FX${c.fxSend}` : '', !isDrum(c.instrument) && c.chord > 0 ? CHORD_NAMES[c.chord] : ''].filter(Boolean).join(' '),
      peak: audio.peak,
      footerRight: f.text,
      footerAlert: f.alert,
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }
}
