/**
 * App controller: owns the project (source of truth on the UI side), turns ControlSurface
 * events into project edits + engine messages, saves the working copy and builds the
 * screen view-models. CLAUDE.md (Current state) describes every control in full.
 *
 * Modes (selected at the top of the panel):
 *  RECORD  building patterns. Stopped = step entry, playing = live recording. Drums: the
 *          strip toggles / paints steps. Pitched: step-entry keyboard (note at the cursor,
 *          then advance; ◀ ▶, REST).
 *  PLAY    performing. Nothing is recorded: the strip is a keyboard for every track
 *          (drums play chromatically), patterns switch at loop end, the view follows
 *          the playhead. Pages SOUND (live knobs) / MIX.
 *  DESIGN  pages SOUND (the selected track's sound), MIX and PROJECT (global).
 *          The strip is an audition keyboard.
 * In RECORD and PLAY the 16 knobs are the live knobs: one module per track, two each
 * (+ two with FUNC), assigned on the SOUND page's FUNC layer.
 * FX 1-3 and LFO (RECORD / PLAY): the knobs and the screen switch to that bus's controls
 * (FX 1 = the drum bus, FX 2 / 3 = sends, LFO = the shared LFO); the channel buttons then
 * add / remove tracks.
 * CLEAR (held): tap a step to clear it, or a channel button to clear that track's pattern.
 * A-D (under FX): the selected track's pattern (FUNC + A-D = every track; hold a channel +
 * A-D = that track, unselected). Each pattern has its own patch: RECORD / DESIGN edit the
 * chosen one; PLAY primes the switch for the loop end and the sound glides there.
 * SAVE: RECORD = the track's pattern notes, DESIGN = its patch, PLAY = both (FUNC = every
 * track). Edits since are marked * on the screen.
 * SONG  arranging: a tracker-style grid of rows (bars + a pattern A-D or OFF per track).
 *          Knobs: top = each track's pattern in the cursor row, bottom 1 = BARS. ◀ ▶ column,
 *          OCT -/+ row, INSERT / DELETE row, strip = jump to a row (while the song plays: at
 *          the next bar), A-D (hold track + A-D) = set a cell, FUNC + A-D = the row. PLAY here plays the
 *          song from the cursor row (it keeps playing in the other modes until STOP).
 * RESET: every patch returns to its saved version and the rest (mix, FX, LFO) to the saved
 * project, live knobs centred: while playing it glides back to land on the next bar line,
 * stopped it jumps. Tapped again: unsaved notes too (swapped in at the bar line). Tempo,
 * master volume, routing, mutes and the playing patterns are left alone.
 * SLIDE: placed with the SLIDE button (tap it, then tap notes). Bass / lead also slide when
 * played legato. In step entry a key pressed while another is held goes on the step after it.
 * ROLL (drum steps): consecutive ROLL steps roll as one run at the sound's ROLL RATE (hits per
 * step), velocity ramping from the first step's dynamic to the last's (GHOST ... ACCENT = a
 * crescendo). Drum lanes paint: slide along the strip (or press the next step while one is
 * held) and every step joins the stroke, which adds or erases as decided by the first step.
 * BAR (hold) + ◀ / ▶: the previous / next bar of a long pattern on the strip; a tap = next.
 * Live recording (RECORD while playing): live-knob moves on instrument parameters become
 * per-step locks on that track, and keyboard notes are written to the nearest step.
 */
import type { ControlEvent } from '../controls/ControlSurface';
import { choice, formatValue, toNorm, toValue, type ParamSpec } from '../engine/params';
import { GLOBAL_PARAMS, MIX_FIELD, MIX_PARAMS, type MixId } from '../engine/mixParams';
import { LFO_LAYOUT, LFO_PARAMS, type LfoId } from '../engine/lfo';
import { BUS_LAYOUT, NUM_BUSES, busParam } from '../fx/buses';
import { CHORD_NAMES, NOTES_NAMES } from '../engine/chords';
import {
  DYNAMIC_VELOCITY, emptyStep, MAX_STEPS, NUM_CHANNELS, NUM_PATTERNS, PATTERN_NAMES, PATTERN_SPEEDS, SONG_MAX_BARS, SONG_MAX_ROWS, STEP_LENGTHS, STEP_NOTES, stepPlays,
  cloneNotes, clonePatch, editPattern, initPatterns, lockPattern, lockProject, patchOf, setPatchOf,
  setStepDynamic, stepDynamic, type ChannelState, type Dynamic, type Project, type SoundKind, type Step,
} from '../engine/project';
import { applyPreset } from '../engine/defaultProject';
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';
import { INSTRUMENTS, LIVE_MACROS, isDrum, linkedParams, liveTargets, paramSpec, stepsOnStrip } from '../instruments/registry';
import { mirrorToCloud } from '../storage/cloud';
import { NAME_LENGTH, PROJECT_BANKS, SLOTS_PER_BANK, projectStore, saveWorkSoon } from '../storage/projects';
import { syncSlots } from '../storage/slotSync';
import { ROLL_DIVS } from '../instruments/Drum';
import { macroIds, timbreName } from '../instruments/macros';
import { applyTrim, hiddenSound, trimFor } from '../instruments/trims';
import { readUserPatch, userPatches } from '../storage/saved';
import { DESIGN_PAGE_BUTTONS, FX_SEND_BUTTONS, KNOB_COUNT, KNOBS_PER_ROW, MODES, STEP_BUTTONS, type Panel } from './Panel';
import type { DesignView, LaneCell, LiveView, ProjectView, SongView } from './views';

type Mode = 'record' | 'play' | 'design' | 'song';


/** SAVE / LOAD state. */
interface ProjectMenu {
  kind: 'save' | 'load';
  bank: number;
  name: string[];
  cursor: number;
  /** A slot waiting for its second tap (overwrite / delete), -1 = none. */
  confirm: number;
  /** Where knobs 1-4 sit (0 = the space) - back at 0 whenever the cursor moves. */
  knobs: number[];
}

/**
 * Name entry: what knobs 1-4 dial in at the cursor. Each starts on a space; the knobs sit
 * there until turned, so the character at the cursor only changes when one is.
 */
const NAME_SETS: readonly [string, string][] = [
  ['A-Z', ' ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  ['a-z', ' abcdefghijklmnopqrstuvwxyz'],
  ['0-9', ' 0123456789'],
  ['SYMBOL', " -_.!#&+=()?%:/'*"],
];

/** PLAY's pages: SOUND (live knobs) and MIX. */
const PLAY_PAGES = 2;
/** After the step count on the screen: double time X2, half time /2. */
const SPEED_MARK = { normal: '', double: ' X2', half: ' /2', triplet: ' T' } as const;

/** What a drum-lane paint stroke does to each step it reaches. */
type StrokeKind = 'add' | 'erase' | 'flags-on' | 'flags-off' | 'rest-on' | 'rest-off';
/** A relative live knob: -100..+100 % around the sound as set (centre). */
const OFFSET_SPEC: ParamSpec = { id: 'offset', name: 'OFFSET', min: -100, max: 100, defaultValue: 0, unit: '%', curve: 'linear', decimals: 0 };
/** FUNC released sooner than this, with no knob turned = a tap (latches FUNC on / off). */
const FUNC_TAP_MS = 350;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}
const isBlackKey = (n: number) => NOTE_NAMES[n % 12].length > 1;

type Status = Extract<WorkletToMain, { type: 'status' }>;

/**
 * The note whose length covers step `index` (itself, or an earlier one tied over it,
 * wrapping round the loop end), as [step, distance]; null if none.
 */
function coveringNote(steps: Step[], length: number, index: number): [number, number] | null {
  for (let k = 0; k < length; k++) {
    const j = (index - k + length) % length;
    if (steps[j].active) return Math.max(1, steps[j].gate) > k ? [j, k] : null;
  }
  return null;
}

/** Steps covered by an earlier note's gate (ties, also across the loop end), per step. */
function tiedSteps(steps: Step[], length: number): boolean[] {
  const tied = new Array<boolean>(steps.length).fill(false);
  for (let i = 0; i < length; i++) {
    if (!steps[i].active) tied[i] = coveringNote(steps, length, i) !== null;
  }
  return tied;
}

/** Note sounding at step `head`, including notes tied over from earlier steps; -1 if none. */
function soundingNote(steps: Step[], length: number, head: number): number {
  if (head < 0) return -1;
  const c = coveringNote(steps, length, head);
  return c ? steps[c[0]].note : -1;
}
type Recorded = Extract<WorkletToMain, { type: 'recordedNote' | 'recordedLock' | 'recordedChord' }>;

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
  /** Identity of the parameter (for RESET glides): "ch:id", "lfo:id", "bus:k:id" ... */
  key?: string;
}

/** One parameter gliding back to its saved value (RESET). */
interface Glide {
  spec: ParamSpec;
  from: number; // normalised
  to: number; // normalised
  target: number; // real value to land on
  set(value: number): void;
}

const MIX_PREFIX = 'mix:';
type GlobalId = 'bpm' | 'swing' | 'master';
/** The master knobs beside PLAY. */
const MASTER_GLOBAL: Readonly<Record<string, GlobalId>> = { mtempo: 'bpm', mmaster: 'master' };

export class App {
  selected = 0;
  mode: Mode = 'record';
  designPage = 0;
  /** PLAY's page: 0 = SOUND (the live knobs), 1 = MIX (as in DESIGN). PROJECT is DESIGN only. */
  playPage = 0;
  /**
   * RECORD: RING / SLIDE / ACCENT / GHOST tapped on = placing that flag: the strip shows the steps and a tap
   * puts it on / takes it off a note (drum lanes: new hits get it too); tapped again = back.
   */
  ring = false;
  slideArm = false;
  /** PLAY: RING / SLIDE per track = every note plays as a RING / SLIDE (ROLL) note. */
  private readonly forceRing: boolean[] = new Array(NUM_CHANNELS).fill(false);
  private readonly forceSlide: boolean[] = new Array(NUM_CHANNELS).fill(false);
  /** PLAY: ACCENT / GHOST per track = every note at that dynamic ('normal' = its own). */
  private readonly forceDyn: Dynamic[] = new Array(NUM_CHANNELS).fill('normal');
  /** REST armed (drum tracks): tapping a step places / removes a rest marker. */
  restArm = false;
  /**
   * FUNC: while held (or latched by a tap) every page shows its second layer: SOUND the
   * FUNC parameters, RECORD / PLAY the tracks' LIVE 3 / 4, TRACK where LIVE 3 / 4 point.
   */
  private funcHeld = false;
  private funcLatched = false;
  /** A knob was turned while FUNC was down (so its release is not a latching tap). */
  private funcUsed = false;
  private funcDownAt = 0;
  dynamic: Dynamic = 'normal';
  playing = false;
  private readonly viewPage: number[] = new Array(NUM_CHANNELS).fill(0);
  private readonly cursor: number[] = new Array(NUM_CHANNELS).fill(0);
  private readonly octave: number[];
  /** Strip button -> note being held (keyboard), so release ends the right note. */
  private readonly heldNotes = new Map<number, number>();
  /** BASS / LEAD played live: the note sounding now (slides move it), -1 = none. */
  private liveNote = -1;
  /** Send shown on the knobs in RECORD/PLAY (1-3), 0 = the tracks' live knobs. */
  private fxView = 0;
  /** CLEAR held, and whether anything was cleared while it was. */
  private clearHeld = false;
  private clearUsed = false;
  /** COPY held: + channel = copy the current pattern there, + A-D = to that pattern of this track. */
  private copyHeld = false;
  private copyUsed = false;
  /** Channel button held down (+ A-D = its pattern; selected on release if A-D was not used). */
  private heldTrack = -1;
  /** Every channel button down now (held + RESET = those tracks keep their state). */
  private readonly heldChannels = new Set<number>();
  /** SOLO per track (not saved): any on mutes every track that is not. */
  private readonly soloed: boolean[] = new Array(NUM_CHANNELS).fill(false);
  private heldUsed = false;
  /** ACCENT / GHOST / RING held down (timer to start painting), and those painting steps. */
  /** SONG cursor: row, and column (0 = BARS, 1-8 = tracks); which 16 rows the strip shows. */
  private songRow = 0;
  private songCol = 1;
  private songPage = 0;
  /** The transport is playing the song (not the patterns). */
  private songPlaying = false;
  /** Step entry in progress: the key held down and the step it wrote (for ties). */
  /** chord: PAD keys added to the step meanwhile (the cursor moves on when all are up). */
  private entry: { button: number; index: number; chord?: boolean } | null = null;
  /**
   * A paint stroke on a drum lane (RECORD): the first step pressed decides what every step
   * the finger slides onto gets (a hit with the armed flags, the flags set / cleared, a rest,
   * or erased). It lasts while any strip button is down.
   */
  private stroke: { kind: StrokeKind } | null = null;
  private readonly stripDown = new Set<number>();
  /** BAR held: ◀ / ▶ move the strip's bar; released unused = next bar. */
  private barHeld = false;
  private barUsed = false;
  /** STEPS held (+ ◀ / ▶ = pattern length; a tap on release = STEPS mode on / off). */
  private lenHeld = false;
  private lenUsed = false;
  /** STEPS mode (RECORD / PLAY): the strip shows which steps play; a tap switches one on / off. */
  private stepsMode = false;
  /** Note sounding from a ◀ / ▶ step preview, released after the step's length. */
  private preview: { channel: number; note: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Short confirmation shown on the screen header (e.g. after saving). */
  private message = '';
  private messageUntil = 0;
  private touchedKnob = -1;
  private touchedAt = 0;
  private status: Status | null = null;
  private statusAt = 0;
  /** State RESET returns to when nothing has been saved: the project as the session began. */
  private baseline: Project;
  /** SAVE / LOAD (stopped only): name entry and the 64 slots, 16 to a bank on the strip. */
  projMenu: ProjectMenu | null = null;
  private glides = new Map<string, Glide>();
  private glideStart = 0;
  private glideEnd = 0;
  /** RESET was just tapped: until then a second tap reverts unsaved notes too. */
  private resetAgainUntil = 0;
  /** RESET lit until (the patches' glide to the bar line). */
  private resetLitUntil = 0;
  private targets: (KnobTarget | null)[] = [];

  constructor(
    public project: Project,
    private readonly panel: Panel,
    private send: (msg: MainToWorklet) => void,
  ) {
    project.channels.forEach(initPatterns);
    this.baseline = JSON.parse(JSON.stringify(project)) as Project;
    this.octave = project.channels.map((c) => (c.instrument === 'none' ? 36 : INSTRUMENTS[c.instrument].baseNote));
    panel.subscribe((e) => this.onControl(e));
    this.refreshPanel();
  }

  setStatus(s: Status): void {
    this.status = s;
    this.statusAt = performance.now();
  }

  /** Messages that bring a freshly started engine in line with the UI. */
  syncMessages(): MainToWorklet[] {
    return [
      { type: 'loadProject', project: this.project },
      ...this.muteMessages(),
      { type: 'transport', playing: this.playing },
    ];
  }

  /**
   * Heard muted: MUTE on, or another track SOLOed and not this one. SOLO is a performance
   * switch (not saved); MUTE is the project's.
   */
  silenced(ch: number): boolean {
    return this.project.channels[ch].mute || (this.soloed.some((s) => s) && !this.soloed[ch]);
  }

  private muteMessages(): MainToWorklet[] {
    return this.project.channels.map((_, ch) => ({ type: 'setMix', channel: ch, id: 'mute', value: this.silenced(ch) ? 1 : 0 }));
  }

  private sendMutes(): void {
    for (const msg of this.muteMessages()) this.send(msg);
  }

  /** Motion-record results from the worklet: mirror them into the project. */
  onRecorded(m: Recorded): void {
    const step = this.project.channels[m.channel].patterns[m.pattern].steps[m.index];
    if (m.type === 'recordedChord') {
      step.extra = [...(step.extra ?? []), m.note];
    } else if (m.type === 'recordedNote') {
      if (m.start) delete step.extra; // a new note replaces the step, chord notes too
      step.active = true;
      step.note = m.note;
      step.velocity = m.velocity;
      step.accent = m.accent;
      step.gate = m.gate;
      step.slide = m.slide;
    } else {
      step.locks = { ...step.locks, [m.id]: m.value };
    }
    this.project.channels[m.channel].patterns[m.pattern].notesDirty = true;
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
    if (this.stepsMode) return false;
    if (this.placing && this.mode === 'record') return false;
    return !stepsOnStrip(this.channel.instrument) || this.mode !== 'record';
  }

  /** RECORD / PLAY with a bus open: knobs and screen show that bus. */
  get sendOpen(): boolean {
    return this.mode !== 'song' && this.fxView > 0;
  }

  /** Whether a track is on bus n (1 = the drum bus, 2-3 = its send, 4 = the LFO). */
  private onBus(c: ChannelState, n: number): boolean {
    return n === 1 ? c.fx1 : n === 4 ? c.lfoOn : c.fxSend === n;
  }

  private busName(n: number): string {
    return n === 4 ? 'LFO' : `FX ${n}`;
  }

  /** Put a track on / take it off bus n. */
  private toggleBus(ch: number, n: number): void {
    const c = this.project.channels[ch];
    if (n === 1) {
      c.fx1 = !c.fx1;
      this.send({ type: 'setDrumBus', channel: ch, on: c.fx1 });
    } else if (n === 4) {
      c.lfoOn = !c.lfoOn;
      this.send({ type: 'setLfoTrack', channel: ch, on: c.lfoOn });
    } else {
      c.fxSend = c.fxSend === n ? 0 : n;
      this.send({ type: 'setRouting', channel: ch, send: c.fxSend });
    }
    this.flash(`${this.kindName(c)} ${this.onBus(c, n) ? '->' : 'OFF'} ${this.busName(n)}`);
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
      const now = readUserPatch(kind, patch);
      c.sounds[kind] = now.sound;
      c.trims[kind] = now.trims;
      c.presets[kind] = index;
      c.live = now.live;
      if (now.liveFunc) c.liveFunc = now.liveFunc;
    }
    const sound = c.sounds[kind] ?? {};
    c.patterns[c.activePattern].patchDirty = true;
    for (const id in sound) this.send({ type: 'setSound', channel: ch, pattern: c.activePattern, id, value: sound[id] });
  }

  /** A short message on the screen (from outside the app, e.g. the audio host). */
  notify(text: string): void {
    this.flash(text);
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
    // (Placing a flag while recording keeps the bar chosen with FUNC + ◀ / ▶ instead.)
    const following = ch !== this.selected || ((this.mode === 'play' || (this.recording && !this.placing)) && !this.stepsMode);
    let page: number;
    if (following) page = this.playing && head >= 0 && heard === c.activePattern ? Math.floor(head / 16) : 0;
    else if (!stepsOnStrip(c.instrument) && this.mode === 'record' && !this.stepsMode) {
      // Step entry: the cursor's block, or while a note is being tied, the block its end is in
      // (a tie runs on past the bar line into the next block, and round past the loop end).
      const at = this.entry ? (this.entry.index + c.patterns[c.activePattern].steps[this.entry.index].gate - 1) % c.patterns[c.activePattern].length : this.cursor[ch];
      // Placing RING / SLIDE / ACCENT / GHOST: the bar chosen with FUNC + ◀ / ▶.
      page = this.placing ? this.viewPage[ch] : Math.floor(at / 16);
    }
    else page = this.viewPage[ch];
    return Math.min(page, this.pageCount(ch) - 1);
  }

  private sendStep(index: number, step: Step, ch = this.selected): void {
    const c = this.project.channels[ch];
    c.patterns[c.activePattern].notesDirty = true;
    this.send({ type: 'setStep', channel: ch, pattern: c.activePattern, index, step });
  }

  /** Pattern switching: immediate while building, at loop end while performing. */
  private get immediateSwitch(): boolean {
    return this.mode !== 'play';
  }

  // ---------------------------------------------------------------- knob targets

  /**
   * What a track's live knobs may control: its type's macros, the non-coarse sound
   * parameters on its sound page (both layers), the mixer (volume, pan, send level) and the LFO rate and depths.
   */
  private liveCandidates(c: ChannelState): { id: string; spec: ParamSpec }[] {
    const list: { id: string; spec: ParamSpec }[] = [];
    if (c.instrument !== 'none') {
      for (const m of LIVE_MACROS[c.instrument]) list.push({ id: m.id, spec: { ...OFFSET_SPEC, name: m.name } });
      if (!isDrum(c.instrument)) list.push({ id: 'track:notes', spec: choice('notes', 'NOTES', NOTES_NAMES) });
      const entry = INSTRUMENTS[c.instrument];
      for (const id of [...entry.layout, ...entry.funcLayout]) {
        const spec = id ? entry.params.find((p) => p.id === id) : undefined;
        if (spec && !spec.coarse && !list.some((x) => x.id === spec.id)) list.push({ id: spec.id, spec });
      }
    }
    for (const spec of MIX_PARAMS) list.push({ id: MIX_PREFIX + spec.id, spec });
    for (const id of ['rate', 'vol', 'pitch', 'filter', 'pan', 'send', 'fm', 'morph', 'phase', 'smooth'] as const) list.push({ id: `lfo:${id}`, spec: LFO_PARAMS[id] });
    return list;
  }

  /** A live knob's name (macro, sound param, mixer, LFO). */
  private liveName(c: ChannelState, id: string): string {
    if (id.startsWith('macro:')) return c.instrument === 'none' ? '-' : LIVE_MACROS[c.instrument].find((m) => m.id === id)?.name ?? '-';
    if (id.startsWith('lfo:')) return LFO_PARAMS[id.slice(4) as LfoId]?.name ?? '-';
    if (id.startsWith(MIX_PREFIX)) return MIX_PARAMS.find((p) => MIX_PREFIX + p.id === id)?.name ?? '-';
    if (id === 'track:notes') return 'NOTES';
    return paramSpec(c.instrument, id)?.name ?? '-';
  }

  /**
   * A live knob (RECORD / PLAY): relative for macros and sound parameters (centred = the
   * sound as set; -100..+100 % = half the parameters' range down / up), absolute for
   * CUTOFF, RESO, the mixer and the LFO.
   */
  private liveKnob(ch: number, id: string, highlight: boolean): KnobTarget | null {
    const c = this.project.channels[ch];
    if (c.instrument === 'none' || liveTargets(c.instrument, id).length === 0) return this.paramTarget(ch, id, undefined, highlight);
    return {
      label: this.liveName(c, id), spec: OFFSET_SPEC, channel: ch, highlight, key: `${ch}:off:${id}`,
      get: () => (c.liveOffset[id] ?? 0) * 100,
      set: (v) => this.setLiveOffset(ch, id, v / 100),
    };
  }

  private setLiveOffset(ch: number, id: string, value: number): void {
    const c = this.project.channels[ch];
    if (Math.abs(value) < 1e-6) delete c.liveOffset[id];
    else c.liveOffset[id] = value;
    this.send({ type: 'setOffset', channel: ch, id, value: c.liveOffset[id] ?? 0 });
  }

  private paramTarget(ch: number, id: string, label?: string, highlight?: boolean): KnobTarget | null {
    const c = this.project.channels[ch];
    if (id.startsWith('lfo:')) {
      const lfoId = id.slice(4) as LfoId;
      const spec = LFO_PARAMS[lfoId];
      return {
        label: label ?? spec.name, spec, channel: ch, highlight, key: id,
        get: () => this.project.lfo[lfoId],
        set: (v) => { this.project.lfo[lfoId] = v; this.send({ type: 'setLfo', id: lfoId, value: v }); },
      };
    }
    if (id === 'track:notes') {
      return {
        label: label ?? 'NOTES', spec: choice('notes', 'NOTES', NOTES_NAMES), channel: ch, highlight, key: `${ch}:${id}`,
        get: () => c.notes - 1,
        set: (v) => { c.notes = v + 1; this.send({ type: 'setNotes', channel: ch, notes: c.notes }); },
      };
    }
    if (id === 'track:preset' && c.instrument !== 'none') {
      const kind = c.instrument;
      return {
        label: label ?? 'PRESET', spec: choice('preset', 'PRESET', this.presetNames(kind)), channel: ch, highlight,
        get: () => c.presets[kind] ?? 0,
        set: (v) => this.loadPreset(ch, kind, v),
      };
    }
    const liveSlot = /^track:live([1-4])$/.exec(id);
    if (liveSlot && c.instrument !== 'none') {
      // What LIVE n controls: 1 / 2 the live knobs, 3 / 4 the same knobs with FUNC held.
      const n = Number(liveSlot[1]);
      const live = n <= 2 ? c.live : c.liveFunc;
      const r = (n - 1) % 2;
      const candidates = this.liveCandidates(c);
      return {
        label: label ?? `LIVE ${n}`, spec: choice(`live${n}`, `LIVE ${n}`, candidates.map((x) => x.spec.name)), channel: ch, highlight,
        get: () => Math.max(0, candidates.findIndex((x) => x.id === live[r])),
        set: (v) => {
          const old = live[r];
          live[r] = candidates[v].id;
          // A knob given another job comes back centred.
          if (![...c.live, ...c.liveFunc].includes(old) && c.liveOffset[old] !== undefined) this.setLiveOffset(ch, old, 0);
        },
      };
    }
    if (id === 'track:chord') {
      return {
        label: label ?? 'CHORD', spec: choice('chord', 'CHORD', CHORD_NAMES), channel: ch, highlight, key: `${ch}:${id}`,
        get: () => c.chord,
        set: (v) => { c.chord = v; this.send({ type: 'setChord', channel: ch, chord: v }); },
      };
    }
    if (id.startsWith(MIX_PREFIX)) {
      const mixId = id.slice(MIX_PREFIX.length) as MixId;
      const spec = MIX_PARAMS.find((p) => p.id === mixId);
      if (!spec) return null;
      const field = MIX_FIELD[mixId];
      return {
        label: label ?? spec.name, spec, channel: ch, highlight, key: `${ch}:${id}`,
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
      label: label ?? spec.name, spec, channel: ch, highlight, key: `${ch}:${id}`,
      get: () => c.sounds[kind]?.[id] ?? spec.defaultValue,
      set: (v) => {
        this.setSoundParam(ch, kind, id, v);
        // PAD / LEAD: ATTACK, DECAY, SUSTAIN, RELEASE move both oscillators.
        for (const other of linkedParams(kind, id)) this.setSoundParam(ch, kind, other, v);
      },
    };
  }

  /**
   * The design layer. TIMBRE / INTENSITY recompute the hidden layer and put each trimmed
   * parameter back on top of it; any other SOUND page knob sets its value, and when the
   * macros also set that parameter its trim (distance from the macro value) is kept, so
   * moving TIMBRE / INTENSITY later keeps the adjustment.
   */
  private setSoundParam(ch: number, kind: SoundKind, id: string, v: number, recompute = true): void {
    const c = this.project.channels[ch];
    const sound = (c.sounds[kind] ??= {});
    const trims = (c.trims[kind] ??= {});
    const specs = INSTRUMENTS[kind].params;
    const pattern = c.activePattern;
    sound[id] = v;
    c.patterns[pattern].patchDirty = true;
    this.send({ type: 'setSound', channel: ch, pattern, id, value: v });
    if (id === 'timbre' || id === 'intensity') {
      if (!recompute) return;
      const hidden = hiddenSound(kind, sound, specs);
      for (const pid in hidden) {
        const spec = specs.find((p) => p.id === pid);
        if (!spec) continue;
        const value = applyTrim(spec, hidden[pid], trims[pid]);
        sound[pid] = value;
        this.send({ type: 'setSound', channel: ch, pattern, id: pid, value });
      }
    } else if (this.macroParams(kind).has(id)) {
      const spec = specs.find((p) => p.id === id);
      const hidden = hiddenSound(kind, sound, specs)[id];
      if (!spec || hidden === undefined) return;
      const t = trimFor(spec, v, hidden);
      if (t) trims[id] = t;
      else delete trims[id];
    }
  }

  /**
   * DESIGN: OCT - / + step the selected synth's OCTAVE parameter (part of its patch, like
   * the knob) instead of the keyboard's octave. False when the track has no OCTAVE (drums).
   */
  private stepOctave(d: number): boolean {
    const c = this.channel;
    if (c.instrument === 'none') return false;
    const kind = c.instrument;
    const spec = INSTRUMENTS[kind].params.find((p) => p.id === 'octave');
    if (!spec?.options) return false;
    const now = Math.round(c.sounds[kind]?.octave ?? spec.defaultValue);
    const next = Math.max(0, Math.min(spec.options.length - 1, now + d));
    if (next !== now) this.setSoundParam(this.selected, kind, 'octave', next);
    this.flash(`OCTAVE ${spec.options[next]}`);
    return true;
  }

  private readonly macroIdCache = new Map<SoundKind, Set<string>>();

  /** The parameters TIMBRE / INTENSITY set for a type (cached). */
  private macroParams(kind: SoundKind): Set<string> {
    let ids = this.macroIdCache.get(kind);
    if (!ids) {
      ids = macroIds(kind, INSTRUMENTS[kind].params);
      this.macroIdCache.set(kind, ids);
    }
    return ids;
  }

  /**
   * DESIGN pages: SOUND (the selected track's sound; FUNC: also its PRESET, LIVE knobs and
   * MID FREQ), MIX (every track's VOLUME / PAN; FUNC SEND LVL / MID CUT), PROJECT (TEMPO,
   * SWING, MASTER; every track's ACC/GHOST, FUNC TRIM). MIX and PROJECT are global.
   */
  private designPages(): { name: string; targets: () => (KnobTarget | null)[] }[] {
    const ch = this.selected;
    const c = this.channel;
    const entry = c.instrument === 'none' ? null : INSTRUMENTS[c.instrument];
    const layout = entry ? (this.func ? entry.funcLayout : entry.layout) : [];
    return [
      { name: 'SOUND', targets: () => layout.map((id) => (id ? this.paramTarget(ch, id) : null)) },
      { name: 'MIX', targets: () => this.mixTargets() },
      { name: 'PROJECT', targets: () => this.projectTargets() },
    ];
  }

  private getGlobal(id: GlobalId): number {
    return this.project[id];
  }

  private setGlobal(id: GlobalId, v: number): void {
    this.project[id] = v;
    this.send({ type: 'setGlobal', id, value: v });
  }

  /**
   * A bus's knobs (k = 0-2: FX 1-3; 3: the LFO): four units of two modules each (buses.ts),
   * the same in RECORD, PLAY and DESIGN. No FUNC layer.
   */
  private sendTargets(k: number): (KnobTarget | null)[] {
    if (k === 3) return LFO_LAYOUT.map((id) => (id ? this.paramTarget(this.selected, `lfo:${id}`) : null));
    const values = this.project.buses[k];
    return BUS_LAYOUT[k].map((id): KnobTarget => {
      const spec = busParam(k, id)!;
      return {
        label: spec.name, spec, channel: this.selected, key: `bus:${k}:${id}`,
        get: () => values[id] ?? spec.defaultValue,
        set: (v: number) => { values[id] = v; this.send({ type: 'setBus', bus: k, id, value: v }); },
      };
    });
  }

  /** One knob per track (knob = track number); `only` leaves the others blank. */
  private trackRow(id: string, name: string, only: (c: ChannelState) => boolean = () => true): (KnobTarget | null)[] {
    return this.project.channels.map((c, ch) => (only(c) ? this.paramTarget(ch, id, `${name} ${ch + 1}`, ch === this.selected) : null));
  }

  /**
   * DESIGN > MIX: one module per track. VOLUME on top, PAN below; with FUNC: SEND level on
   * top, MID CUT below (the centre is each sound's MID FREQ, SOUND page FUNC).
   */
  private mixTargets(): (KnobTarget | null)[] {
    if (this.func) return [...this.trackRow('mix:send', 'SEND'), ...this.trackRow('mix:cut', 'CUT')];
    return [...this.trackRow('mix:volume', 'VOL'), ...this.trackRow('mix:pan', 'PAN')];
  }

  /**
   * DESIGN > PROJECT (global): TEMPO, SWING, MASTER on top; every track's ACC/GHOST
   * below. With FUNC: every synth track's TRIM below (drums play out their own decay).
   */
  private projectTargets(): (KnobTarget | null)[] {
    const top: (KnobTarget | null)[] = GLOBAL_PARAMS.map((spec) => ({
      label: spec.name, spec, channel: this.selected, key: `global:${spec.id}`,
      get: () => this.getGlobal(spec.id as GlobalId),
      set: (v: number) => this.setGlobal(spec.id as GlobalId, v),
    }));
    while (top.length < KNOBS_PER_ROW) top.push(null);
    if (this.func) return [...new Array<KnobTarget | null>(KNOBS_PER_ROW).fill(null), ...this.trackRow('mix:gate', 'TRIM', (c) => !isDrum(c.instrument))];
    return [...top, ...this.trackRow('mix:dyn', 'ACC')];
  }

  /** The 16 knob targets for the current mode. */
  private computeTargets(): (KnobTarget | null)[] {
    if (this.projMenu) return this.nameTargets();
    // FUNC layers exist for the DESIGN pages and the live knobs; elsewhere FUNC
    // leaves the knobs empty.
    if (this.mode === 'song') return this.func ? new Array(KNOB_COUNT).fill(null) : this.songTargets();
    if (this.fxView > 0) return this.func ? new Array(KNOB_COUNT).fill(null) : this.sendTargets(this.fxView - 1);
    if (this.mode === 'design') {
      const pages = this.designPages();
      this.designPage = Math.min(this.designPage, pages.length - 1);
      const t = pages[this.designPage].targets();
      return Array.from({ length: KNOB_COUNT }, (_, i) => t[i] ?? null);
    }
    if (this.playMix) return this.mixTargets();
    // Live knobs: column = track, rows = live knob 1 / 2 (FUNC: 3 / 4).
    const out: (KnobTarget | null)[] = [];
    for (let row = 0; row < 2; row++) {
      for (let ch = 0; ch < KNOBS_PER_ROW; ch++) {
        const c = this.project.channels[ch];
        out.push(this.liveKnob(ch, (this.func ? c.liveFunc : c.live)[row], ch === this.selected));
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
    if ((m = /^ch(\d)$/.exec(id))) {
      if (e.pressed) this.heldChannels.add(Number(m[1]) - 1);
      else this.heldChannels.delete(Number(m[1]) - 1);
    }
    if (id === 'func') return this.onFunc(e.pressed);
    if (this.projMenu && this.onProjectMenu(id, e.pressed)) {
      this.refreshPanel();
      return;
    }
    if (!e.pressed) {
      if ((m = /^step(\d+)$/.exec(id))) this.releaseKey(Number(m[1]) - 1);
      if ((m = /^ch(\d)$/.exec(id)) && this.heldTrack === Number(m[1]) - 1) {
        // A bus is open, a plain tap (no pattern picked meanwhile): with FUNC held it adds /
        // removes the track; otherwise it goes back to the tracks, on that one.
        if (this.sendOpen && !this.heldUsed && !this.clearHeld) {
          if (this.func) {
            this.toggleBus(this.heldTrack, this.fxView);
            if (this.funcHeld) this.funcUsed = true; // not a latching tap
          } else {
            this.selected = this.heldTrack;
            this.fxView = 0;
            this.touchedKnob = -1;
            if (this.mode === 'design') this.designPage = 0;
          }
        } else if (!this.sendOpen && !this.heldUsed) {
          // A plain tap (no A-D meanwhile) selects the track; in DESIGN it opens its SOUND
          // page (MIX and PROJECT are global).
          this.selected = this.heldTrack;
          if (this.mode === 'design') {
            this.designPage = 0;
            this.touchedKnob = -1;
          }
        }
        this.heldTrack = -1;
        this.refreshPanel();
      }
      if (id === 'clear') {
        this.clearHeld = false;
        if (!this.clearUsed) this.flash('HOLD CLEAR + STEP / TRACK');
        this.refreshPanel();
      }
      if (id === 'steppage' && this.barHeld) {
        // BAR tapped (no ◀ / ▶ meanwhile): the next bar.
        this.barHeld = false;
        if (!this.barUsed) this.changeBar(1);
        this.refreshPanel();
      }
      if (id === 'len' && this.lenHeld) {
        // STEPS tapped (no ◀ / ▶ meanwhile): STEPS mode on / off.
        this.lenHeld = false;
        if (!this.lenUsed) {
          this.stepsMode = !this.stepsMode;
          this.flash(this.stepsMode ? 'STEPS: TAP A STEP ON / OFF' : 'STEPS OFF');
        }
        this.refreshPanel();
      }
      if (id === 'copy') {
        this.copyHeld = false;
        if (!this.copyUsed) this.flash('HOLD COPY + TRACK / A-D');
        this.refreshPanel();
      }
      return;
    }
    if (id === 'copy') {
      this.copyHeld = true;
      this.copyUsed = false;
      this.refreshPanel();
      return;
    }
    if (this.copyHeld && ((m = /^ch(\d)$/.exec(id)) || (m = /^pat([A-D])$/.exec(id)))) {
      // COPY + channel: the same pattern slot on that track; COPY + A-D: that pattern of
      // this track.
      const c = this.channel;
      if (id.startsWith('ch')) this.copyPattern(this.selected, c.activePattern, Number(m[1]) - 1, c.activePattern);
      else this.copyPattern(this.selected, c.activePattern, this.selected, PATTERN_NAMES.indexOf(m[1] as (typeof PATTERN_NAMES)[number]));
      this.refreshPanel();
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
    if ((m = /^ch(\d)$/.exec(id))) {
      this.heldTrack = Number(m[1]) - 1;
      this.heldUsed = false;
    }
    if ((m = /^pat([A-D])$/.exec(id))) {
      // A-D: the selected track's pattern; holding a channel: that track's; FUNC: every track.
      const pat = PATTERN_NAMES.indexOf(m[1] as (typeof PATTERN_NAMES)[number]);
      if (this.heldTrack >= 0) {
        this.selectPattern(this.heldTrack, pat);
        this.heldUsed = true;
      } else if (this.func) {
        for (let ch = 0; ch < NUM_CHANNELS; ch++) this.selectPattern(ch, pat, false);
        this.flash(this.mode === 'song' ? `ROW: ALL ${m[1]}` : `ALL TRACKS PAT ${m[1]}`);
        if (this.funcHeld) this.funcUsed = true; // not a latching tap
      } else {
        this.selectPattern(this.selected, pat);
      }
      this.refreshPanel();
      return;
    }
    if (this.mode === 'song' && this.onSongButton(id)) {
      this.refreshPanel();
      return;
    }
    if (id === 'play') {
      this.playing = !this.playing;
      // PLAY in SONG mode plays the song from the cursor row; elsewhere the patterns.
      this.songPlaying = this.playing && this.mode === 'song' && this.project.song.rows.length > 0;
      this.send({ type: 'transport', playing: this.playing, song: this.songPlaying, fromRow: this.songRow });
    } else if (id.startsWith('mode:')) {
      this.mode = id.slice(5) as Mode;
      this.playPage = 0; // PLAY always opens on SOUND (the live knobs)
      if (this.mode !== 'record' && this.mode !== 'play') this.stepsMode = false;
      // RING / SLIDE belong to their mode: placing in RECORD, the all-notes effect in PLAY.
      if (this.mode !== 'record') { this.ring = false; this.slideArm = false; this.dynamic = 'normal'; }
      if (this.mode !== 'play') {
        for (let ch = 0; ch < NUM_CHANNELS; ch++) {
          if (this.forceRing[ch] || this.forceSlide[ch] || this.forceDyn[ch] !== 'normal') this.setForce(ch, false, false, 'normal');
        }
      }
      this.touchedKnob = -1;
      if (this.mode === 'song' && this.project.song.rows.length === 0) {
        // A first row from what the tracks play now.
        this.project.song.rows.push({ bars: 4, patterns: this.project.channels.map((c) => c.activePattern) });
        this.sendSong();
      }
    } else if ((m = /^ch(\d)$/.exec(id))) {
      // Channel buttons act on release: a tap selects (or, a bus open, FUNC + tap = on /
      // off the bus, a tap = back to that track); held + A-D = its pattern.
    } else if ((m = /^mute(\d)$/.exec(id))) {
      const ch = Number(m[1]) - 1;
      const c = this.project.channels[ch];
      c.mute = !c.mute;
      this.sendMutes();
      this.save();
    } else if ((m = /^solo(\d)$/.exec(id))) {
      const ch = Number(m[1]) - 1;
      this.soloed[ch] = !this.soloed[ch];
      this.sendMutes();
    } else if ((m = /^dpage(\d)$/.exec(id))) {
      const page = Number(m[1]);
      if (this.mode === 'play') this.playPage = page;
      else this.designPage = page;
      this.fxView = 0; // back from a bus to the DESIGN pages
      this.touchedKnob = -1;
    } else if ((m = /^fx([1-4])$/.exec(id))) {
      const n = Number(m[1]);
      if (this.func) {
        // FUNC + FX 1-3 / LFO: put the selected track on / off this bus.
        this.toggleBus(this.selected, n);
        if (this.funcHeld) this.funcUsed = true; // not a latching tap
      } else {
        // Show this bus's controls on the knobs (again = back to the tracks / DESIGN pages).
        this.fxView = this.fxView === n ? 0 : n;
        this.touchedKnob = -1;
      }
    } else if (id === 'save') {
      this.saveCurrent();
    } else if (id === 'reset') {
      this.startReset();
    } else if (id === 'saveproject') {
      // SAVE PROJECT = name + slot; FUNC + SAVE PROJECT = load another (stopped only).
      if (this.funcHeld) this.funcUsed = true;
      this.openProjectMenu(this.func ? 'load' : 'save');
    } else if ((id === 'ring' || id === 'slide' || id === 'dyn:accent' || id === 'dyn:ghost') && this.mode === 'play') {
      // PLAY: a live effect on the selected track's notes, tap on / tap off.
      const ch = this.selected;
      const ring = id === 'ring' ? !this.forceRing[ch] : this.forceRing[ch];
      const slide = id === 'slide' ? !this.forceSlide[ch] : this.forceSlide[ch];
      let dyn = this.forceDyn[ch];
      if (id === 'dyn:accent' || id === 'dyn:ghost') {
        const d: Dynamic = id === 'dyn:accent' ? 'accent' : 'ghost';
        dyn = dyn === d ? 'normal' : d; // ACCENT and GHOST exclude each other
      }
      this.setForce(ch, ring, slide, dyn);
      const on = id === 'ring' ? ring : id === 'slide' ? slide : dyn !== 'normal';
      const name = id === 'ring' ? 'RING' : id === 'slide' ? this.slideName : id.slice(4).toUpperCase();
      this.flash(`${name} ALL NOTES ${on ? 'ON' : 'OFF'}`);
    } else if ((id === 'ring' || id === 'slide' || id === 'dyn:accent' || id === 'dyn:ghost') && this.mode === 'record') {
      // RECORD: tap = place this flag on the strip (one at a time), tap again = back.
      const d: Dynamic = id === 'dyn:accent' ? 'accent' : id === 'dyn:ghost' ? 'ghost' : 'normal';
      const on = id === 'ring' ? !this.ring : id === 'slide' ? !this.slideArm : this.dynamic !== d;
      // Placing opens on the bar step entry is in (the cursor's).
      if (on && !this.placing && this.flagPaintable && !this.recording) this.viewPage[this.selected] = Math.floor(this.cursor[this.selected] / 16);
      this.ring = id === 'ring' && on;
      this.slideArm = id === 'slide' && on;
      this.dynamic = on ? d : 'normal';
      const name = id === 'ring' ? 'RING' : id === 'slide' ? this.slideName : id.slice(4).toUpperCase();
      if (on && this.flagPaintable) this.flash(`TAP NOTES: ${name}`);
    } else if (id === 'dyn:accent' || id === 'dyn:ghost') {
      const d: Dynamic = id === 'dyn:accent' ? 'accent' : 'ghost';
      this.dynamic = this.dynamic === d ? 'normal' : d;
    } else if (id === 'len') {
      // STEPS: held for ◀ / ▶ (length), a tap (on release) = STEPS mode.
      this.lenHeld = true;
      this.lenUsed = false;
    } else if (id === 'steppage' && this.func) {
      // FUNC + BAR: the selected track's pattern in normal -> double -> half time.
      this.cycleSpeed();
      if (this.funcHeld) this.funcUsed = true; // not a latching tap
    } else if (id === 'steppage') {
      // BAR: held for ◀ / ▶, a tap (on release) = the next bar.
      this.barHeld = true;
      this.barUsed = false;
    } else if ((id === 'oct-' || id === 'oct+') && this.mode === 'design' && this.stepOctave(id === 'oct+' ? 1 : -1)) {
      // DESIGN on a synth: OCT - / + move the sound's OCTAVE (stepOctave).
    } else if (id === 'oct-' || id === 'oct+') {
      const o = this.octave[this.selected] + (id === 'oct+' ? 12 : -12);
      this.octave[this.selected] = Math.max(12, Math.min(96, o));
    } else if ((id === 'cur-' || id === 'cur+') && this.lenHeld) {
      // STEPS + ◀ / ▶: the pattern one bar shorter / longer.
      this.changeLength(id === 'cur+' ? 1 : -1);
      this.lenUsed = true;
    } else if ((id === 'cur-' || id === 'cur+') && this.barHeld) {
      // BAR + ◀ / ▶: the previous / next bar (16-step block) on the strip.
      this.changeBar(id === 'cur+' ? 1 : -1);
      this.barUsed = true;
    } else if ((id === 'cur-' || id === 'cur+') && this.entry) {
      // Holding a key: ▶ ties the note over one more step, ◀ shortens it.
      this.tie(id === 'cur+' ? 1 : -1);
    } else if (id === 'cur-' || id === 'cur+') {
      this.moveCursor(id === 'cur+' ? 1 : -1);
      this.previewCursor();
    } else if (id === 'rest' && !this.keyboard) {
      // Drum steps: arm REST, then tap steps to place / remove rest markers.
      this.restArm = !this.restArm;
    } else if (id === 'rest') {
      // Step entry: a rest marker at the cursor (ends a ringing note), then advance.
      const step = this.pattern.steps[this.cursor[this.selected]];
      step.active = false;
      step.ring = false;
      step.slide = false;
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

  /**
   * RESET: every patch that was edited since its SAVE goes back to it, and every other
   * parameter that differs from the saved project (mix, FX, LFO) too, with the live knobs
   * centred: gliding (each on its own curve) to land on the next bar line; stopped, at
   * once. Tapped again soon after: unsaved notes too.
   */
  private startReset(): void {
    const now = performance.now();
    // Tracks held down sit it out (and their buttons no longer select on release).
    const keep = new Set(this.heldChannels);
    if (keep.size > 0) this.heldUsed = true;
    const kept = keep.size > 0 ? ` (KEPT ${[...keep].sort().map((ch) => ch + 1).join(' ')})` : '';
    if (now < this.resetAgainUntil) {
      this.resetAgainUntil = 0;
      this.resetNotes(keep, kept);
      return;
    }
    const openId = projectStore.openId();
    const saved = (openId ? projectStore.load(openId) : null) ?? this.baseline;
    const glides = new Map<string, Glide>();
    const add = (key: string, spec: ParamSpec, current: number, target: number, set: (v: number) => void) => {
      if (Math.abs(current - target) < 1e-9) return;
      glides.set(key, { spec, from: toNorm(spec, current), to: toNorm(spec, target), target, set });
    };
    const fromTarget = (t: KnobTarget | null, target: number) => {
      if (t?.key) add(t.key, t.spec, t.get(), target, (v) => t.set(v));
    };
    this.project.channels.forEach((c, ch) => {
      const s = saved.channels[ch];
      if (!s || keep.has(ch)) return;
      for (const spec of MIX_PARAMS) {
        fromTarget(this.paramTarget(ch, MIX_PREFIX + spec.id), s[MIX_FIELD[spec.id as MixId]] ?? spec.defaultValue);
      }
      if (!isDrum(c.instrument)) {
        fromTarget(this.paramTarget(ch, 'track:chord'), s.chord);
        fromTarget(this.paramTarget(ch, 'track:notes'), s.notes - 1);
      }
      // Relative live knobs glide back to the centre (the sound as set).
      for (const id of Object.keys(c.liveOffset)) fromTarget(this.liveKnob(ch, id, false), 0);
    });
    // Patches: each edited one back to its saved version (the engine glides the one playing).
    let patches = 0;
    this.project.channels.forEach((c, ch) => {
      if (c.instrument === 'none' || keep.has(ch)) return;
      for (let p = 0; p < NUM_PATTERNS; p++) {
        const pat = c.patterns[p];
        if (!pat.patchDirty || !pat.savedPatch) continue;
        setPatchOf(c, p, pat.savedPatch);
        pat.patchDirty = false;
        patches++;
        this.send({ type: 'setPatch', channel: ch, pattern: p, sound: { ...patchOf(c, p).sound }, glide: true });
      }
    });
    const notesToo = this.project.channels.some((c, ch) => !keep.has(ch) && c.patterns.some((pat) => pat.notesDirty));
    for (const id of Object.keys(LFO_PARAMS) as LfoId[]) fromTarget(this.paramTarget(this.selected, `lfo:${id}`), saved.lfo[id]);
    for (let k = 0; k < NUM_BUSES; k++) {
      for (const t of this.sendTargets(k)) if (t?.key) fromTarget(t, saved.buses[k]?.[t.key.split(':')[2]] ?? t.spec.defaultValue);
    }
    for (const gid of ['swing'] as const) {
      const spec = GLOBAL_PARAMS.find((p) => p.id === gid) as ParamSpec;
      add(`global:${gid}`, spec, this.project[gid], saved[gid], (v) => this.setGlobal(gid, v));
    }
    if (notesToo) this.resetAgainUntil = now + 3000;
    if (glides.size === 0 && patches === 0) {
      this.flash(notesToo ? 'TAP AGAIN: NOTES TOO' : 'NOTHING TO RESET');
      return;
    }
    this.glides = glides;
    this.glideStart = now;
    if (this.playing && this.status?.playing) {
      // Land on the next bar line (if it is under a step away, the one after).
      // The time signature's bar, whatever each track's STEPS: every track lands together.
      const steps = this.status.barSteps ?? 16;
      const bar = (60000 / this.project.bpm / 4) * steps;
      const phase = this.status.barPhase + (now - this.statusAt) / bar;
      let left = (1 - (phase - Math.floor(phase))) * bar;
      if (left < bar / steps) left += bar;
      this.glideEnd = now + left;
      this.flash(`RESET AT NEXT BAR${kept}`);
    } else {
      this.glideEnd = now;
      this.flash(`RESET${kept}`);
    }
    if (notesToo) this.flash('TAP AGAIN: NOTES TOO');
    this.resetLitUntil = this.glideEnd;
    this.save();
    this.stepGlides(now);
  }

  /**
   * FUNC + BAR: the selected track's pattern steps through normal, double and half time
   * (its steps last a 16th, a 32nd or an 8th). An unsaved edit of its notes, like LENGTH.
   */
  private cycleSpeed(): void {
    const pat = this.pattern;
    const next = PATTERN_SPEEDS[(PATTERN_SPEEDS.indexOf(pat.speed ?? 'normal') + 1) % PATTERN_SPEEDS.length];
    if (next === 'normal') delete pat.speed;
    else pat.speed = next;
    pat.notesDirty = true;
    this.send({ type: 'setPatternSpeed', channel: this.selected, pattern: this.channel.activePattern, speed: next });
    this.flash(`${this.kindName(this.channel)} PAT ${PATTERN_NAMES[this.channel.activePattern]} ${next.toUpperCase()} TIME`);
    this.save();
  }

  /** RESET tapped again: every pattern's unsaved notes go back to its saved ones (at the bar line). */
  private resetNotes(keep: ReadonlySet<number>, kept: string): void {
    let n = 0;
    this.project.channels.forEach((c, ch) => c.patterns.forEach((pat, p) => {
      if (!pat.notesDirty || !pat.savedNotes || keep.has(ch)) return;
      const saved = cloneNotes(pat.savedNotes);
      pat.length = saved.length;
      pat.steps = saved.steps;
      if (saved.speed) pat.speed = saved.speed;
      else delete pat.speed;
      pat.notesDirty = false;
      n++;
      this.send({ type: 'swapNotes', channel: ch, pattern: p, length: saved.length, steps: saved.steps, speed: saved.speed });
    }));
    this.entry = null;
    this.clampCursor();
    this.save();
    this.flash(n === 0 ? 'NOTES ALREADY SAVED' : (this.playing ? 'NOTES RESET AT NEXT BAR' : 'NOTES RESET') + kept);
  }

  /** Move the RESET glides on (called every frame). */
  private stepGlides(now: number): void {
    if (this.glides.size === 0) return;
    const span = this.glideEnd - this.glideStart;
    const t = span <= 0 ? 1 : Math.min(1, (now - this.glideStart) / span);
    for (const g of this.glides.values()) {
      if (t >= 1) g.set(g.target);
      else if (!g.spec.options) g.set(toValue(g.spec, g.from + (g.to - g.from) * t));
    }
    if (t >= 1) {
      this.glides.clear();
      this.save();
    }
    this.refreshPanel();
  }

  // ---------------------------------------------------------------- song

  private sendSong(): void {
    this.send({ type: 'setSong', song: this.project.song });
    this.save();
  }

  private get songRows() {
    return this.project.song.rows;
  }

  /** SONG mode buttons; true when handled. */
  private onSongButton(id: string): boolean {
    const rows = this.songRows;
    let m: RegExpExecArray | null;
    const moveRow = (row: number) => {
      this.songRow = Math.max(0, Math.min(rows.length - 1, row));
      this.songPage = Math.floor(this.songRow / 16);
    };
    if (id === 'cur-' || id === 'cur+') {
      this.songCol = Math.max(0, Math.min(NUM_CHANNELS, this.songCol + (id === 'cur+' ? 1 : -1)));
      if (this.songCol > 0) this.selected = this.songCol - 1;
    } else if (id === 'oct-' || id === 'oct+') {
      moveRow(this.songRow + (id === 'oct+' ? 1 : -1));
    } else if (id === 'ring') {
      // INSERT: a copy of the cursor row, after it.
      if (rows.length >= SONG_MAX_ROWS) { this.flash('SONG FULL'); return true; }
      const src = rows[this.songRow] ?? { bars: 4, patterns: this.project.channels.map((c) => c.activePattern) };
      rows.splice(this.songRow + 1, 0, { bars: src.bars, patterns: [...src.patterns] });
      moveRow(this.songRow + 1);
      this.sendSong();
      this.flash(`ROW ${this.songRow + 1} INSERTED`);
    } else if (id === 'dyn:accent') {
      if (rows.length <= 1) { this.flash('LAST ROW STAYS'); return true; }
      rows.splice(this.songRow, 1);
      moveRow(this.songRow);
      this.sendSong();
      this.flash('ROW DELETED');
    } else if (id === 'steppage') {
      const pages = Math.max(1, Math.ceil(rows.length / 16));
      this.songPage = (this.songPage + 1) % pages;
    } else if ((m = /^step(\d+)$/.exec(id))) {
      const row = this.songPage * 16 + Number(m[1]) - 1;
      if (row >= rows.length) return true;
      moveRow(row);
      if (this.songPlaying) {
        this.send({ type: 'songJump', row });
        this.flash(`ROW ${row + 1} AT NEXT BAR`);
      }
    } else if ((m = /^ch(\d)$/.exec(id))) {
      this.songCol = Number(m[1]);
      return false; // and select the track as usual
    } else {
      return false;
    }
    return true;
  }

  /** Set track ch's pattern in the cursor row (-1 = off). */
  private setSongCell(ch: number, pattern: number): void {
    const row = this.songRows[this.songRow];
    if (!row) return;
    row.patterns[ch] = pattern;
    this.sendSong();
  }

  /** SONG knobs: top = each track's pattern in the cursor row, bottom 1 = BARS, 2 = ROW. */
  private songTargets(): (KnobTarget | null)[] {
    const out: (KnobTarget | null)[] = new Array(KNOB_COUNT).fill(null);
    const row = this.songRows[this.songRow];
    if (!row) return out;
    const cell = choice('cell', 'PAT', ['OFF', ...PATTERN_NAMES]);
    this.project.channels.forEach((c, ch) => {
      out[ch] = {
        label: `${ch + 1} ${this.kindName(c)}`, spec: cell, channel: ch, highlight: this.songCol === ch + 1,
        get: () => row.patterns[ch] + 1,
        set: (v) => { this.setSongCell(ch, v - 1); },
      };
    });
    out[KNOBS_PER_ROW] = {
      label: 'BARS', spec: { id: 'bars', name: 'BARS', min: 1, max: SONG_MAX_BARS, defaultValue: 4, unit: '', curve: 'linear', decimals: 0 },
      channel: this.selected, highlight: this.songCol === 0,
      get: () => row.bars,
      set: (v) => { row.bars = Math.max(1, Math.round(v)); this.sendSong(); },
    };
    const rows = this.songRows.length;
    out[KNOBS_PER_ROW + 1] = {
      label: 'ROW', spec: { id: 'row', name: 'ROW', min: 1, max: Math.max(2, rows), defaultValue: 1, unit: '', curve: 'linear', decimals: 0 },
      channel: this.selected,
      get: () => this.songRow + 1,
      set: (v) => { this.songRow = Math.max(0, Math.min(rows - 1, Math.round(v) - 1)); this.songPage = Math.floor(this.songRow / 16); },
    };
    return out;
  }

  /**
   * Switch a track's pattern, with its patch (at once while building, at its loop end while
   * performing, the sound gliding there). The chosen pattern is the one edited.
   */
  private selectPattern(ch: number, pattern: number, flash = true): void {
    if (this.mode === 'song') {
      // SONG: the track's cell in the cursor row.
      this.setSongCell(ch, pattern);
      return;
    }
    const c = this.project.channels[ch];
    editPattern(c, pattern);
    if (ch === this.selected) {
      this.clampCursor();
      this.entry = null;
    }
    this.send({ type: 'selectPattern', channel: ch, pattern, immediate: this.immediateSwitch });
    if (flash) this.flash(`${ch + 1} ${this.kindName(c)} PAT ${PATTERN_NAMES[pattern]}`);
    this.save();
  }

  /**
   * SAVE: the selected track's pattern as it is now becomes its saved version - RECORD its
   * notes, DESIGN its patch, PLAY (and SONG) both. FUNC + SAVE: every track's.
   */
  private saveCurrent(): void {
    const notes = this.mode !== 'design';
    const patch = this.mode !== 'record';
    if (this.funcHeld) this.funcUsed = true;
    const tracks = this.func ? this.project.channels.map((_, ch) => ch) : [this.selected];
    for (const ch of tracks) {
      const c = this.project.channels[ch];
      lockPattern(c, c.activePattern, notes, patch);
    }
    this.save();
    const what = notes && patch ? 'PATTERN + PATCH' : notes ? 'PATTERN' : 'PATCH';
    const c = this.channel;
    this.flash(`SAVED ${what} ${this.func ? 'ALL TRACKS' : `${this.selected + 1} ${PATTERN_NAMES[c.activePattern]}`}`);
  }

  /** Unsaved edits on a pattern (notes or patch): marked * on the screen. */
  private dirty(c: ChannelState, p = c.activePattern): boolean {
    const pat = c.patterns[p];
    return !!pat.notesDirty || !!pat.patchDirty;
  }

  private velocity(): number {
    const d = this.mode === 'play' ? this.forceDyn[this.selected] : this.dynamic;
    return DYNAMIC_VELOCITY[d];
  }

  private onStrip(button: number): void {
    const ch = this.selected;
    this.stripDown.add(button);
    if (this.clearHeld && this.mode !== 'design') {
      const index = this.visiblePage(ch) * 16 + button;
      if (index < this.pattern.length) this.clearStep(index);
      return;
    }
    if (this.stepsMode) {
      // STEPS: switch the step on / off (its note stays, unheard while it is off).
      const index = this.visiblePage(ch) * 16 + button;
      if (index >= this.pattern.length) return;
      const step = this.pattern.steps[index];
      if (step.flip) delete step.flip;
      else step.flip = true;
      this.sendStep(index, step);
      this.flash(`STEP ${index + 1} ${this.plays(index) ? 'ON' : 'OFF'}`);
      this.save();
      return;
    }
    // Keyboard track placing RING / SLIDE / ACCENT / GHOST: a tap puts the flag on / off
    // that step's note (another dynamic -> the placed one, the same one -> back to normal).
    if (this.placing && this.mode === 'record' && this.flagPaintable) {
      const index = this.visiblePage(ch) * 16 + button;
      const id = this.ring ? 'ring' : this.slideArm ? 'slide' : `dyn:${this.dynamic}`;
      if (index < this.pattern.length) this.paintStep(index, [id]);
      return;
    }
    if (this.keyboard) {
      this.stopPreview(); // a played key never gets cut off by a preview's release
      const note = this.octave[ch] + button;
      const vel = this.velocity();
      // Bass / lead played legato (a key still held) slide into the new note.
      let heldNote = -1;
      for (const n of this.heldNotes.values()) heldNote = n;
      const legato = heldNote >= 0 && this.isMono(this.channel);
      // PAD: keys played together make one step's chord (live recording, step entry).
      const chord = heldNote >= 0 && this.channel.instrument === 'pad';
      this.heldNotes.set(button, note);
      if (this.mode !== 'record' || this.recording) this.liveNote = note;
      if (this.mode === 'record' && this.recording) {
        // Live recording: the worklet writes the note to the nearest step.
        this.send({ type: 'recordNote', channel: ch, note, velocity: vel, accent: this.dynamic === 'accent', slide: legato, chord });
      } else if (this.mode === 'record') {
        // Step entry: write a one-step note at the cursor and hear it. The cursor moves
        // on when the key is released (past any steps tied with ▶ meanwhile).
        // A key pressed while another is still held goes right after the held note.
        if (chord && this.entry && this.entry.button !== button) {
          // PAD: the key joins the step being entered (up to STEP_NOTES notes).
          const step = this.pattern.steps[this.entry.index];
          const notes = [step.note, ...(step.extra ?? [])];
          if (!notes.includes(note) && notes.length < STEP_NOTES) {
            step.extra = [...(step.extra ?? []), note];
            this.sendStep(this.entry.index, step);
            this.save();
          }
          this.entry.chord = true;
          this.send({ type: 'trigger', channel: ch, note, velocity: vel });
          return;
        }
        let index = this.cursor[ch];
        if (this.entry && this.entry.button !== button) {
          const prev = this.pattern.steps[this.entry.index];
          index = (this.entry.index + prev.gate) % this.pattern.length; // wraps past the end
        }
        const step = this.pattern.steps[index];
        step.active = true;
        step.note = note;
        step.gate = 1;
        step.ring = this.ring;
        step.rest = false;
        step.slide = this.slideArm; // ROLL on PERC
        delete step.extra;
        setStepDynamic(step, this.dynamic);
        this.sendStep(index, step);
        this.send({ type: 'trigger', channel: ch, note, velocity: vel });
        this.entry = { button, index };
        this.save();
      } else {
        // PLAY and DESIGN: play only, never recorded.
        this.send({ type: 'trigger', channel: ch, note, velocity: vel, slideFrom: legato ? heldNote : -1 });
      }
      return;
    }

    // Drum lane: a paint stroke. The first step pressed decides it - REST armed: rests on /
    // off; an empty step: hits (with the armed flags); a hit with flags armed: those flags on
    // / off (ACCENT / GHOST: the armed one, or back to normal); a hit, nothing armed: erase.
    // Every step the stroke reaches (sliding along, or the next press while one is held)
    // gets the same.
    const index = this.visiblePage(ch) * 16 + button;
    if (index >= this.pattern.length) return;
    const step = this.pattern.steps[index];
    const armed = this.dynamic !== 'normal' || this.ring || this.slideArm;
    if (!this.stroke) {
      const kind: StrokeKind = this.restArm ? (step.rest ? 'rest-off' : 'rest-on')
        : !step.active ? 'add'
        : !armed ? 'erase'
        : this.flagsOn(step) ? 'flags-off' : 'flags-on';
      this.stroke = { kind };
    }
    if (this.paintDrumStep(step, this.stroke.kind) && !this.playing) {
      this.send({ type: 'trigger', channel: ch, note: step.note, velocity: step.velocity });
    }
    this.sendStep(index, step);
    this.save();
  }

  /** The armed flags are all already on this hit (so a stroke from it takes them off). */
  private flagsOn(step: Step): boolean {
    if (this.dynamic !== 'normal' && stepDynamic(step) !== this.dynamic) return false;
    if (this.ring && !step.ring) return false;
    if (this.slideArm && !step.slide) return false;
    return true;
  }

  /** One step of a drum-lane paint stroke. True when a hit was added (to audition it). */
  private paintDrumStep(step: Step, kind: StrokeKind): boolean {
    switch (kind) {
      case 'rest-on':
      case 'rest-off':
      case 'erase':
        step.rest = kind === 'rest-on';
        step.active = false;
        step.ring = false;
        step.slide = false;
        delete step.locks;
        return false;
      case 'add': {
        const added = !step.active;
        step.active = true;
        step.rest = false;
        if (added) {
          step.ring = this.ring;
          step.slide = this.slideArm;
          setStepDynamic(step, this.dynamic);
        } else {
          // Already a hit: the stroke adds the armed flags to it.
          if (this.ring) step.ring = true;
          if (this.slideArm) step.slide = true;
          if (this.dynamic !== 'normal') setStepDynamic(step, this.dynamic);
        }
        return added;
      }
      default: {
        // Flags on / off a hit (empty steps are passed over).
        if (!step.active) return false;
        const on = kind === 'flags-on';
        if (this.ring) step.ring = on;
        if (this.slideArm) step.slide = on;
        if (this.dynamic !== 'normal') setStepDynamic(step, on ? this.dynamic : 'normal');
        return false;
      }
    }
  }

  /** RECORD: a flag (RING / SLIDE / ACCENT / GHOST) is being placed on the strip. */
  private get placing(): boolean {
    return this.ring || this.slideArm || this.dynamic !== 'normal';
  }

  /** RECORD on a keyboard track: placing a flag shows the steps instead of the keys. */
  private get flagPaintable(): boolean {
    return this.mode === 'record' && !stepsOnStrip(this.channel.instrument);
  }

  /** Paint flags onto the note on a step. */
  private paintStep(index: number, ids: Iterable<string>): void {
    // A step a note is tied over: the flag goes on that note.
    if (!this.pattern.steps[index].active) index = coveringNote(this.pattern.steps, this.pattern.length, index)?.[0] ?? index;
    const step = this.pattern.steps[index];
    if (!step.active) {
      this.flash('NO NOTE ON THIS STEP');
      return;
    }
    for (const id of ids) {
      if (id === 'ring') step.ring = !step.ring;
      else if (id === 'slide') {
        step.slide = !step.slide;
      } else {
        const d: Dynamic = id === 'dyn:accent' ? 'accent' : 'ghost';
        setStepDynamic(step, stepDynamic(step) === d ? 'normal' : d);
      }
    }
    this.sendStep(index, step);
    this.save();
  }

  /** PLAY: every note on a track as RING / SLIDE (ROLL) / ACCENT / GHOST notes, or back. */
  private setForce(ch: number, ring: boolean, slide: boolean, dyn: Dynamic): void {
    this.forceRing[ch] = ring;
    this.forceSlide[ch] = slide;
    this.forceDyn[ch] = dyn;
    this.send({ type: 'setForce', channel: ch, ring, slide, velocity: dyn === 'normal' ? 0 : DYNAMIC_VELOCITY[dyn] });
  }

  /** Hits per step of a ROLL-flagged drum step on this channel (its sound's ROLL DIV). */
  private rollHits(c: ChannelState): number {
    const v = c.instrument === 'none' ? 0 : c.sounds[c.instrument]?.rolldiv ?? 0;
    return ROLL_DIVS[Math.round(v)]?.hits ?? 2;
  }

  /** The SLIDE button's job on this track: ROLL on drums. */
  private get slideName(): string {
    return isDrum(this.channel.instrument) ? 'ROLL' : 'SLIDE';
  }

  private isMono(c: ChannelState): boolean {
    return c.instrument === 'bass' || c.instrument === 'lead';
  }

  /** CLEAR + step: empty it; a note tied over it now ends just before it. */
  private clearStep(index: number): void {
    const steps = this.pattern.steps;
    const over = coveringNote(steps, this.pattern.length, index);
    if (over && over[1] > 0) {
      steps[over[0]].gate = over[1];
      this.sendStep(over[0], steps[over[0]]);
    }
    const step = steps[index];
    step.active = false;
    step.ring = false;
    step.rest = false;
    step.slide = false;
    step.gate = 1;
    delete step.locks;
    delete step.extra;
    this.sendStep(index, step);
    this.clearUsed = true;
    this.save();
  }

  /**
   * COPY: a pattern (length, steps, flags, and onto the same type its patch) onto another
   * track's / pattern slot. Onto KICK, SNARE and HAT the notes do not carry over (their
   * hits play as designed); PERC and the synths keep them. Locks only go to a track of the
   * same type. The copy is an unsaved edit there.
   */
  private copyPattern(fromCh: number, fromPat: number, toCh: number, toPat: number): void {
    if (fromCh === toCh && fromPat === toPat) {
      this.flash('PICK ANOTHER TRACK / PATTERN');
      return;
    }
    const from = this.project.channels[fromCh];
    const to = this.project.channels[toCh];
    const src = from.patterns[fromPat];
    const dst = to.patterns[toPat];
    const plainDrum = to.instrument !== 'none' && stepsOnStrip(to.instrument);
    dst.length = src.length;
    this.send({ type: 'setPatternLength', channel: toCh, pattern: toPat, length: dst.length });
    if (src.speed && src.speed !== 'normal') dst.speed = src.speed;
    else delete dst.speed;
    this.send({ type: 'setPatternSpeed', channel: toCh, pattern: toPat, speed: dst.speed ?? 'normal' });
    src.steps.forEach((s, i) => {
      const step: Step = JSON.parse(JSON.stringify(s));
      if (plainDrum) step.note = emptyStep().note; // a drum's own pitch (as designed)
      if (from.instrument !== to.instrument) delete step.locks;
      if (to.instrument !== 'pad') delete step.extra; // chords on the PAD only
      dst.steps[i] = step;
      this.send({ type: 'setStep', channel: toCh, pattern: toPat, index: i, step });
    });
    dst.notesDirty = true;
    // The patch goes along onto a track of the same type.
    const withPatch = from.instrument === to.instrument && from.instrument !== 'none';
    if (withPatch) {
      setPatchOf(to, toPat, clonePatch(patchOf(from, fromPat)));
      dst.patchDirty = true;
      this.send({ type: 'setPatch', channel: toCh, pattern: toPat, sound: { ...patchOf(to, toPat).sound }, glide: false });
    }
    this.copyUsed = true;
    this.flash(`COPIED ${fromCh + 1} ${PATTERN_NAMES[fromPat]} > ${toCh + 1} ${PATTERN_NAMES[toPat]}${withPatch ? ' +PATCH' : ''}`);
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
      step.slide = false;
      step.gate = 1;
      delete step.locks;
      this.sendStep(i, step, ch);
    });
    this.clearUsed = true;
    this.flash(`CLEARED ${ch + 1} ${this.kindName(c)} ${PATTERN_NAMES[c.activePattern]}`);
    this.save();
  }

  private releaseKey(button: number): void {
    this.stripDown.delete(button);
    if (this.stripDown.size === 0) this.stroke = null;
    const note = this.heldNotes.get(button);
    if (note === undefined) return;
    this.heldNotes.delete(button);
    const ch = this.selected;
    const live = this.mode !== 'record' || this.recording;
    if (live && note === this.liveNote && this.heldNotes.size > 0 && this.isMono(this.channel)) {
      // BASS / LEAD: letting go of the sounding note while others are held slides back to the
      // latest one still held (trills); recording, that slide is written as one too.
      let back = -1;
      for (const n of this.heldNotes.values()) back = n;
      this.liveNote = back;
      if (this.recording) this.send({ type: 'recordNote', channel: ch, note: back, velocity: this.velocity(), accent: this.dynamic === 'accent', slide: true });
      else this.send({ type: 'trigger', channel: ch, note: back, velocity: this.velocity(), slideFrom: note });
      return;
    }
    if (note === this.liveNote) this.liveNote = -1;
    this.send({ type: 'release', channel: ch, note });
    // The cursor moves on when the entered key is up (a PAD chord: when all its keys are).
    if (this.entry && (this.entry.chord ? this.heldNotes.size === 0 : this.entry.button === button)) {
      const len = this.pattern.length;
      this.cursor[this.selected] = (this.entry.index + this.pattern.steps[this.entry.index].gate) % len;
      if (!this.plays(this.cursor[this.selected])) this.moveCursor(1); // past dark steps
      this.entry = null;
      this.refreshPanel();
    }
  }

  /** Lengthen (+1) or shorten (-1) the note being entered; tied-over steps are cleared. */
  private tie(delta: number): void {
    if (!this.entry) return;
    const { index } = this.entry;
    const len = this.pattern.length;
    const step = this.pattern.steps[index];
    // Up to the whole loop: a tie can run past the end and on from the start.
    const gate = Math.max(1, Math.min(len, step.gate + delta));
    if (gate === step.gate) return;
    step.gate = gate;
    if (delta > 0) {
      const at = (index + gate - 1) % len;
      const covered = this.pattern.steps[at];
      if (covered.active || covered.locks) {
        covered.active = false;
        delete covered.locks;
        this.sendStep(at, covered);
      }
    }
    this.sendStep(index, step);
    this.save();
  }

  /** STEPS + ◀ / ▶: the pattern's length one bar (16 steps) down / up. */
  private changeLength(delta: number): void {
    const len = this.pattern.length;
    const next = delta > 0 ? STEP_LENGTHS.find((l) => l > len) : [...STEP_LENGTHS].reverse().find((l) => l < len);
    if (next === undefined) {
      this.flash(`${len} STEPS`);
      return;
    }
    this.pattern.length = Math.min(next, MAX_STEPS);
    this.flash(`${this.pattern.length} STEPS`);
    this.pattern.notesDirty = true;
    this.send({
      type: 'setPatternLength', channel: this.selected, pattern: this.channel.activePattern, length: this.pattern.length,
    });
    this.clampCursor();
    this.save();
  }

  /**
   * Step entry: landing on a step with a note plays it (its velocity, for its length),
   * cutting off the previous preview.
   */
  private previewCursor(): void {
    const ch = this.selected;
    this.stopPreview();
    const step = this.pattern.steps[this.cursor[ch]];
    if (!step.active || this.playing) return;
    this.send({ type: 'trigger', channel: ch, note: step.note, velocity: step.velocity });
    const ms = (60000 / this.project.bpm / 4) * Math.max(1, step.gate);
    const note = step.note;
    const timer = setTimeout(() => {
      if (this.preview?.timer !== timer) return;
      this.send({ type: 'release', channel: ch, note });
      this.preview = null;
    }, ms);
    this.preview = { channel: ch, note, timer };
  }

  private stopPreview(): void {
    if (!this.preview) return;
    clearTimeout(this.preview.timer);
    this.send({ type: 'release', channel: this.preview.channel, note: this.preview.note });
    this.preview = null;
  }

  /**
   * FUNC + ◀ / ▶: show another bar of the selected track's pattern. In step entry the cursor
   * moves with it (same place in the next bar), so the keyboard writes into the bar shown.
   */
  private changeBar(delta: number): void {
    const ch = this.selected;
    const pages = this.pageCount();
    if (pages <= 1) {
      this.flash('ONE BAR PATTERN');
      return;
    }
    if ((this.mode === 'play' || (this.recording && !this.placing)) && !this.stepsMode) {
      this.flash('THE STRIP FOLLOWS THE PLAYHEAD');
      return;
    }
    const page = (this.visiblePage(ch) + delta + pages) % pages;
    this.viewPage[ch] = page;
    if (!stepsOnStrip(this.channel.instrument) && this.mode === 'record' && !this.entry) {
      this.cursor[ch] = page * 16 + (this.cursor[ch] % 16);
    }
    this.flash(`BAR ${page + 1}/${pages}`);
  }

  /** Step entry: the cursor moves to the next / previous step that plays (dark ones skipped). */
  private moveCursor(delta: number): void {
    const len = this.pattern.length;
    let at = this.cursor[this.selected];
    for (let t = 0; t < len; t++) {
      at = (at + delta + len) % len;
      if (this.plays(at)) break;
    }
    this.cursor[this.selected] = at;
  }

  /** Whether step `index` of the selected track's pattern plays (time signature, triplets, STEPS). */
  private plays(index: number, ch = this.selected): boolean {
    const c = this.project.channels[ch];
    const pat = c.patterns[c.activePattern];
    return stepPlays(this.project.meter, pat.speed, index, pat.steps[index]?.flip);
  }

  private clampCursor(): void {
    if (this.cursor[this.selected] >= this.pattern.length) this.cursor[this.selected] = 0;
    if (this.viewPage[this.selected] >= this.pageCount()) this.viewPage[this.selected] = 0;
  }

  /** TEMPO and MASTER master knobs. */
  private onMasterKnob(id: string, norm: number): void {
    const gid = MASTER_GLOBAL[id];
    const spec = GLOBAL_PARAMS.find((p) => p.id === gid) as ParamSpec;
    let value = toValue(spec, norm);
    if (spec.decimals !== undefined) value = Math.round(value * 10 ** spec.decimals) / 10 ** spec.decimals;
    this.glides.delete(`global:${gid}`);
    this.setGlobal(gid, value);
    this.flash(`${spec.name} ${formatValue(spec, value)}`);
    this.save();
  }

  /**
   * Relative encoder turn (hardware encoders; the mouse wheel on screen): one detent =
   * one 0-127 step, one option for discrete choices, 0.1 BPM for TEMPO.
   */
  private onEncoder(id: string, delta: number): void {
    const gid = MASTER_GLOBAL[id];
    if (gid) {
      const spec = GLOBAL_PARAMS.find((p) => p.id === gid) as ParamSpec;
      const step = gid === 'bpm' ? 0.1 : 1 / 127;
      const value = Math.min(spec.max, Math.max(spec.min, Math.round((this.project[gid] + delta * step) * 1000) / 1000));
      this.glides.delete(`global:${gid}`);
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

  /** FUNC layer showing (held or latched). */
  private get func(): boolean {
    return this.funcHeld || this.funcLatched;
  }

  /** FUNC: hold = second layer while held; a quick tap with no knob turned = latch / unlatch. */
  private onFunc(pressed: boolean): void {
    if (pressed) {
      this.funcHeld = true;
      this.funcUsed = false;
      this.funcDownAt = performance.now();
    } else {
      this.funcHeld = false;
      if (!this.funcUsed && performance.now() - this.funcDownAt < FUNC_TAP_MS) this.funcLatched = !this.funcLatched;
    }
    this.refreshPanel();
  }

  private applyKnob(slot: number, t: KnobTarget, raw: number): void {
    if (this.funcHeld) this.funcUsed = true;
    let value = raw;
    if (t.spec.decimals !== undefined && !t.spec.options) {
      const f = Math.pow(10, t.spec.decimals);
      value = Math.round(value * f) / f;
    }
    if (t.spec.options && value === t.get()) return; // detent: nothing changed
    if (t.key) this.glides.delete(t.key); // a hand on the knob wins over RESET
    t.set(value);
    this.touchedKnob = slot;
    this.touchedAt = performance.now();
    this.save();
    // Discrete choices can change what other knobs mean (type, preset, live assignment).
    if (t.spec.options) this.refreshPanel();
  }

  private save(): void {
    mirrorToCloud(this.project);
    saveWorkSoon(this.project);
  }

  // ---------------------------------------------------------------- projects

  private openProjectMenu(kind: 'save' | 'load'): void {
    if (this.playing) {
      this.flash(kind === 'save' ? 'STOP TO SAVE' : 'STOP TO LOAD');
      return;
    }
    void syncSlots(); // the slots as saved on other devices too (claude.ai)
    this.funcLatched = false;
    const slots = projectStore.slots();
    const openId = projectStore.openId();
    const at = slots.findIndex((e) => !!e && e.id === openId);
    const name = (at >= 0 ? slots[at]!.name : 'PROJECT').slice(0, NAME_LENGTH);
    this.projMenu = { kind, bank: at >= 0 ? Math.floor(at / SLOTS_PER_BANK) : 0, name: [...name], cursor: Math.min(name.length, NAME_LENGTH - 1), confirm: -1, knobs: [0, 0, 0, 0] };
    this.touchedKnob = -1;
  }

  private closeProjectMenu(): void {
    this.projMenu = null;
    this.barHeld = false;
  }

  /** A button while SAVE / LOAD is open. True = handled here (others are ignored, a few pass). */
  private onProjectMenu(id: string, pressed: boolean): boolean {
    const menu = this.projMenu!;
    let m: RegExpExecArray | null;
    if (!pressed) {
      if (id === 'steppage') { this.barHeld = false; return true; }
      return !(id === 'clear' || id === 'copy' || id.startsWith('mode:'));
    }
    if (id.startsWith('mode:') || id === 'play') {
      this.closeProjectMenu();
      return false;
    }
    if (id === 'clear') return false; // CLEAR held + slot = delete (LOAD)
    if (id === 'saveproject') {
      if (this.funcHeld) this.funcUsed = true;
      if (menu.kind === 'save' && this.func) this.openProjectMenu('load');
      else this.closeProjectMenu();
      return true;
    }
    if (id === 'steppage') {
      this.barHeld = true;
      this.barUsed = true;
      return true;
    }
    if (id === 'cur-' || id === 'cur+') {
      const d = id === 'cur+' ? 1 : -1;
      if (menu.kind === 'load' || this.barHeld) {
        menu.bank = (menu.bank + d + PROJECT_BANKS) % PROJECT_BANKS;
        menu.confirm = -1;
      } else {
        menu.cursor = Math.max(0, Math.min(Math.min(menu.name.length, NAME_LENGTH - 1), menu.cursor + d));
        menu.knobs.fill(0); // the knobs start from the space again at the new position
      }
      return true;
    }
    if ((m = /^step(\d+)$/.exec(id))) {
      const slot = menu.bank * SLOTS_PER_BANK + Number(m[1]) - 1;
      if (menu.kind === 'save') this.saveToSlot(slot);
      else if (this.clearHeld) this.deleteSlot(slot);
      else this.loadFromSlot(slot);
      return true;
    }
    return true;
  }

  private saveToSlot(slot: number): void {
    const menu = this.projMenu!;
    const name = menu.name.join('').trim() || 'PROJECT';
    const entry = projectStore.slots()[slot];
    const openId = projectStore.openId();
    const own = !!entry && entry.id === openId;
    if (entry && !own && menu.confirm !== slot) {
      menu.confirm = slot;
      this.flash(`TAP ${slot + 1} AGAIN TO OVERWRITE`);
      return;
    }
    // Into its own slot: the same project, saved over. Anywhere else: a new one (save as).
    // Every pattern and patch is saved with it.
    lockProject(this.project);
    const saved = projectStore.save(slot, name, this.project, own ? entry.id : undefined);
    if (!saved) {
      this.flash('STORAGE FULL - NOT SAVED');
      return;
    }
    projectStore.setOpen(saved.id);
    this.baseline = JSON.parse(JSON.stringify(this.project)) as Project;
    this.closeProjectMenu();
    this.flash(`SAVED ${name} IN ${slot + 1}`);
  }

  private loadFromSlot(slot: number): void {
    const entry = projectStore.slots()[slot];
    if (!entry) {
      this.flash('EMPTY SLOT');
      return;
    }
    const openId = projectStore.openId();
    if (entry.id !== openId) {
      // Keep this project's unsaved edits with it, then open the other one where it was left.
      if (openId) projectStore.saveWork(openId, this.project);
      const project = projectStore.loadWork(entry.id) ?? projectStore.load(entry.id);
      if (!project) {
        this.flash('COULD NOT LOAD');
        return;
      }
      projectStore.setOpen(entry.id);
      this.replaceProject(project);
    }
    this.closeProjectMenu();
    this.flash(projectStore.isOld(entry.id) ? `${entry.name}: OLD SAVE, SOUNDS MAY DIFFER` : `LOADED ${entry.name}`);
  }

  private deleteSlot(slot: number): void {
    const menu = this.projMenu!;
    const entry = projectStore.slots()[slot];
    if (!entry) return;
    if (menu.confirm !== slot) {
      menu.confirm = slot;
      this.flash(`TAP ${slot + 1} AGAIN TO DELETE`);
      return;
    }
    projectStore.remove(slot);
    menu.confirm = -1;
    this.clearUsed = true;
    this.flash(`DELETED ${entry.name}`);
  }

  /** Open another project: it replaces this one in the UI and the engine (stopped). */
  private replaceProject(project: Project): void {
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      if (this.forceRing[ch] || this.forceSlide[ch] || this.forceDyn[ch] !== 'normal') this.setForce(ch, false, false, 'normal');
    }
    project.channels.forEach(initPatterns);
    this.project = project;
    this.baseline = JSON.parse(JSON.stringify(project)) as Project;
    this.resetAgainUntil = 0;
    this.entry = null;
    project.channels.forEach((c, i) => { this.octave[i] = c.instrument === 'none' ? 36 : INSTRUMENTS[c.instrument].baseNote; });
    this.selected = 0;
    this.viewPage.fill(0);
    this.cursor.fill(0);
    this.soloed.fill(false);
    this.glides.clear();
    this.fxView = 0;
    for (const msg of this.syncMessages()) this.send(msg);
    this.save();
  }

  /** The SAVE / LOAD screen. */
  projectView(): ProjectView {
    const menu = this.projMenu!;
    const slots = projectStore.slots();
    const openId = projectStore.openId();
    const first = menu.bank * SLOTS_PER_BANK;
    const now = performance.now();
    return {
      kind: menu.kind,
      bank: menu.bank,
      banks: PROJECT_BANKS,
      name: menu.name.join(''),
      cursor: menu.cursor,
      slots: Array.from({ length: SLOTS_PER_BANK }, (_, i) => {
        const e = slots[first + i];
        return { number: first + i + 1, name: e?.name ?? '', used: !!e, open: !!e && e.id === openId, confirm: first + i === menu.confirm };
      }),
      message: now < this.messageUntil ? this.message : '',
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }

  /** The strip while SAVE / LOAD is open: the bank's slots (lit = used, cursor = open). */
  private updateProjectStrip(): void {
    const menu = this.projMenu!;
    const slots = projectStore.slots();
    const openId = projectStore.openId();
    for (let i = 0; i < STEP_BUTTONS; i++) {
      const id = `step${i + 1}`;
      const slot = menu.bank * SLOTS_PER_BANK + i;
      const e = slots[slot];
      this.panel.setButtonText(id, String(slot + 1));
      this.panel.setButtonFlag(id, 'off', false);
      this.panel.setButtonFlag(id, 'lit', !!e);
      this.panel.setButtonFlag(id, 'cursor', !!e && e.id === openId);
      for (const f of ['black', 'accent', 'ghost', 'ring', 'rest', 'head']) this.panel.setButtonFlag(id, f, false);
      this.panel.setLed(i, slot === menu.confirm ? 'rec' : '');
    }
    this.panel.setButtonText('steppage', `BANK<small>${menu.bank + 1}/${PROJECT_BANKS}</small>`);
  }

  /** SAVE name entry: knobs 1-4 = capitals, lower case, digits, symbols at the cursor. */
  private nameTargets(): (KnobTarget | null)[] {
    const menu = this.projMenu!;
    const out: (KnobTarget | null)[] = new Array(KNOB_COUNT).fill(null);
    if (menu.kind !== 'save') return out;
    NAME_SETS.forEach(([label, chars], k) => {
      const spec = choice(`name${k}`, label, [...chars]);
      out[k] = {
        label, spec, channel: this.selected,
        get: () => menu.knobs[k],
        set: (v) => {
          menu.knobs[k] = Math.round(v);
          const c = chars[menu.knobs[k]] ?? chars[0];
          while (menu.name.length < menu.cursor) menu.name.push(' ');
          menu.name[menu.cursor] = c;
        },
      };
    });
    return out;
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
      this.panel.setButtonLit(`solo${ch + 1}`, this.soloed[ch]);
      this.panel.setButtonText(`ch${ch + 1}`, `${ch + 1}<small>${this.kindName(c)}</small>`);
      this.panel.setBadge(ch, this.mode === 'design' || sendView ? 'dim' : ch === this.selected ? 'lit' : '');
    }
    for (const [id, gid] of Object.entries(MASTER_GLOBAL)) {
      const spec = GLOBAL_PARAMS.find((p) => p.id === gid) as ParamSpec;
      this.panel.configureMaster(id, toNorm(spec, this.project[gid]), toNorm(spec, spec.defaultValue));
    }
    for (let n = 1; n <= FX_SEND_BUTTONS; n++) {
      this.panel.setButtonLit(`fx${n}`, this.fxView === n);
    }
    // DESIGN: SOUND / MIX / PROJECT. PLAY: SOUND (live knobs) / MIX; PROJECT shown but off.
    const names = this.pageNames();
    const current = this.mode === 'play' ? this.playPage : this.designPage;
    for (let i = 0; i < DESIGN_PAGE_BUTTONS; i++) {
      const name = names[i];
      const usable = !!name && (this.mode === 'design' || i < PLAY_PAGES);
      this.panel.setButtonText(`dpage${i}`, name ?? '');
      this.panel.setButtonEnabled(`dpage${i}`, usable);
      this.panel.setButtonLit(`dpage${i}`, usable && i === current && this.fxView === 0);
    }
    this.panel.setButtonLit('clear', this.clearHeld);
    this.panel.setButtonLit('reset', this.glides.size > 0 || performance.now() < this.resetLitUntil);
    // SAVE: what this mode edits (RECORD the notes, DESIGN the patch, PLAY both).
    this.panel.setButtonText('save', `SAVE<small>${this.mode === 'record' ? 'PATTERN' : this.mode === 'design' ? 'PATCH' : 'PAT+PATCH'}</small>`);
    // SAVE PROJECT doubles as LOAD (FUNC): the label says which one a tap opens.
    this.panel.setButtonText('saveproject', this.func ? 'LOAD<small>PROJECT</small>' : 'SAVE/LOAD<small>PROJECT</small>');
    this.panel.setButtonEnabled('clear', this.mode !== 'design');
    this.panel.setButtonLit('copy', this.copyHeld);
    this.panel.setButtonEnabled('copy', this.mode !== 'design');
    this.panel.setButtonLit('play', this.playing);
    this.panel.setButtonText('play', this.playing ? 'STOP' : 'PLAY');

    const rec = this.mode === 'record';
    const kb = this.keyboard;
    this.panel.setButtonLit('func', this.func);
    const play = this.mode === 'play';
    this.panel.setButtonLit('ring', play ? this.forceRing[this.selected] : this.ring);
    this.panel.setButtonLit('slide', play ? this.forceSlide[this.selected] : this.slideArm);
    // Synths: SLIDE; drums: ROLL (same button, same step flag).
    this.panel.setButtonText('slide', this.slideName);
    this.panel.setButtonEnabled('slide', rec || play);
    const dyn = play ? this.forceDyn[this.selected] : this.dynamic;
    this.panel.setButtonLit('dyn:accent', dyn === 'accent');
    this.panel.setButtonLit('dyn:ghost', dyn === 'ghost');
    this.panel.setButtonEnabled('ring', rec || play);
    this.panel.setButtonText('len', `${this.pattern.length}<small>STEPS</small>`);
    if (this.mode !== 'record' && this.mode !== 'play') this.stepsMode = false;
    this.panel.setButtonLit('len', this.stepsMode);
    // BAR: not where the strip follows the playhead (PLAY, live recording unless placing).
    // FUNC + BAR (half / double time) works in every mode but SONG.
    this.panel.setButtonEnabled('steppage', !!this.projMenu || this.func || ((this.stepsMode || (this.mode !== 'play' && !(this.recording && !this.placing))) && this.pageCount() > 1));
    for (const id of ['oct-', 'oct+']) this.panel.setButtonEnabled(id, kb);
    // Drum lanes in RECORD paint by sliding; with CLEAR held any strip clears by sliding.
    this.panel.setStripSlide(!this.stepsMode && ((this.mode === 'record' && stepsOnStrip(this.channel.instrument)) || (this.clearHeld && this.mode !== 'design')));
    for (const id of ['cur-', 'cur+']) this.panel.setButtonEnabled(id, (kb && rec) || this.barHeld || this.lenHeld || !!this.projMenu);
    this.panel.setButtonEnabled('rest', rec);
    if (kb || !rec) this.restArm = false;
    this.panel.setButtonLit('rest', this.restArm);
    this.panel.root.classList.toggle('keyboard', kb);
    // SONG: the function row edits the grid.
    const song = this.mode === 'song';
    this.panel.setButtonText('ring', song ? 'INSERT<small>ROW</small>' : 'RING');
    this.panel.setButtonText('dyn:accent', song ? 'DELETE<small>ROW</small>' : 'ACCENT');
    this.panel.setButtonText('oct-', song ? 'ROW ▲' : 'OCT −');
    this.panel.setButtonText('oct+', song ? 'ROW ▼' : 'OCT +');
    if (song) {
      this.panel.setButtonLit('ring', false);
      this.panel.setButtonLit('dyn:accent', false);
      this.panel.setButtonLit('dyn:ghost', false);
      this.panel.setButtonEnabled('ring', true);
      this.panel.setButtonEnabled('dyn:accent', true);
      this.panel.setButtonEnabled('dyn:ghost', false);
      this.panel.setButtonEnabled('len', false);
      this.panel.setButtonEnabled('rest', false);
      this.panel.setButtonEnabled('steppage', this.songRows.length > 16 || !!this.projMenu);
      for (const id of ['oct-', 'oct+', 'cur-', 'cur+']) this.panel.setButtonEnabled(id, true);
      this.panel.root.classList.toggle('keyboard', false);
    } else {
      this.panel.setButtonEnabled('dyn:accent', true);
      this.panel.setButtonEnabled('dyn:ghost', true);
      this.panel.setButtonEnabled('len', true);
    }
  }

  /** SONG: the strip = 16 rows (lit = row exists, head = playing row, cursor row marked). */
  private updateSongFrame(): void {
    const rows = this.songRows.length;
    const playingRow = this.songPlaying ? (this.status?.songRow ?? -1) : -1;
    for (let i = 0; i < STEP_BUTTONS; i++) {
      const id = `step${i + 1}`;
      const row = this.songPage * 16 + i;
      const exists = row < rows;
      this.panel.setButtonText(id, String(row + 1));
      this.panel.setButtonFlag(id, 'off', !exists);
      this.panel.setButtonFlag(id, 'lit', exists);
      this.panel.setButtonFlag(id, 'head', row === playingRow);
      this.panel.setButtonFlag(id, 'cursor', row === this.songRow);
      for (const f of ['black', 'accent', 'ghost', 'ring', 'rest']) this.panel.setButtonFlag(id, f, false);
      this.panel.setLed(i, row === playingRow ? 'on' : row === this.songRow ? 'cursor' : '');
    }
    const start = this.songPage * 16 + 1;
    this.panel.setButtonText('steppage', `${start}-${start + 15}<small>ROWS</small>`);
    // A-D show the cursor cell's pattern.
    const cell = this.songCol > 0 ? (this.songRows[this.songRow]?.patterns[this.songCol - 1] ?? -1) : -1;
    PATTERN_NAMES.forEach((name, p) => {
      this.panel.setButtonFlag(`pat${name}`, 'lit', p === cell);
      this.panel.setButtonFlag(`pat${name}`, 'playing', false);
      this.panel.setButtonFlag(`pat${name}`, 'dirty', false);
    });
  }

  /** Per-frame updates: strip lights/labels, LEDs, pending pattern blink. */
  updateFrame(now: number): void {
    this.stepGlides(now);
    if (this.projMenu) {
      this.updateProjectStrip();
      return;
    }
    if (this.mode === 'song') {
      this.updateSongFrame();
      return;
    }
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
    const entryGate = this.entry ? pattern.steps[this.entry.index].gate : 0;
    const inEntry = (index: number) =>
      !!this.entry && (index - this.entry.index + pattern.length) % pattern.length < entryGate;
    for (let i = 0; i < STEP_BUTTONS; i++) {
      const index = page * 16 + i;
      let state: '' | 'on' | 'rec' | 'cursor' = '';
      if (pitchedRecord && (this.entry ? inEntry(index) : index === cursor)) state = 'cursor';
      if (head === index) state = this.recording ? 'rec' : 'on';
      this.panel.setLed(i, state);
    }

    if (this.keyboard) {
      const sounding = soundingNote(pattern.steps, pattern.length, head);
      const cursorStep = pattern.steps[cursor];
      const cursorNotes = pitchedRecord && cursorStep.active ? [cursorStep.note, ...(cursorStep.extra ?? [])] : [];
      for (let i = 0; i < STEP_BUTTONS; i++) {
        const id = `step${i + 1}`;
        const note = this.octave[ch] + i;
        this.panel.setButtonText(id, noteName(note));
        this.panel.setButtonFlag(id, 'black', isBlackKey(note));
        this.panel.setButtonFlag(id, 'lit', note === sounding);
        this.panel.setButtonFlag(id, 'cursor', cursorNotes.includes(note));
        for (const f of ['accent', 'ghost', 'head', 'off', 'ring', 'rest', 'tie', 'skip']) this.panel.setButtonFlag(id, f, false);
      }
    } else {
      // RING or SLIDE / ROLL armed (or painting): every hit is dim (like a ghost note) and
      // the ones with that flag light up fully; the other flags are not shown.
      const view = this.ring ? 'ring' : this.slideArm ? 'slide' : null;
      // Pitched tracks: steps a note is tied over show as a line through the strip, with
      // that note's flags.
      const pitched = !stepsOnStrip(c.instrument);
      for (let i = 0; i < STEP_BUTTONS; i++) {
        const id = `step${i + 1}`;
        const index = page * 16 + i;
        const off = index >= pattern.length;
        const own = pattern.steps[index];
        // Dark: a step that does not play (time signature, triplet time, STEPS).
        const dark = !off && !this.plays(index);
        this.panel.setButtonFlag(id, 'skip', dark);
        const cover = pitched && !off && !own.active ? coveringNote(pattern.steps, pattern.length, index) : null;
        const tie = !!cover && cover[1] > 0;
        const step = tie ? pattern.steps[cover![0]] : own;
        this.panel.setButtonFlag(id, 'tie', tie);
        const d = step.active && !off && !dark && !this.stepsMode ? stepDynamic(step) : null;
        const flagged = d !== null && (view === 'ring' ? !!step.ring : view === 'slide' ? !!step.slide : true);
        const roll = d !== null && step.slide && isDrum(c.instrument) ? this.rollHits(c) : 0;
        this.panel.setButtonText(id, roll ? `${index + 1}<small>×${roll}</small>` : String(index + 1));
        this.panel.setButtonFlag(id, 'off', off);
        // STEPS mode: lit = the step plays.
        this.panel.setButtonFlag(id, 'lit', this.stepsMode ? !off && !dark : d !== null);
        this.panel.setButtonFlag(id, 'accent', !view && d === 'accent');
        this.panel.setButtonFlag(id, 'ghost', view ? d !== null && !flagged : d === 'ghost');
        this.panel.setButtonFlag(id, 'head', head === index);
        this.panel.setButtonFlag(id, 'ring', !view && d !== null && !!step.ring);
        this.panel.setButtonFlag(id, 'rest', !off && !step.active && !!step.rest);
        for (const f of ['black', 'cursor']) this.panel.setButtonFlag(id, f, false);
        if (tie) this.panel.setButtonText(id, String(index + 1));
      }
    }

    // With FUNC: the pattern's speed (FUNC + BAR changes it).
    const speed = this.pattern.speed ?? 'normal';
    this.panel.setButtonText('steppage', this.func ? `TIME<small>${speed.toUpperCase()}</small>` : `BAR<small>${page + 1}/${this.pageCount()}</small>`);

    this.updatePatternButtons(now);
    if (this.touchedKnob >= 0 && now - this.touchedAt > 4000) this.touchedKnob = -1;
  }

  /**
   * A-D: the selected track's patterns (a channel held: that track's). Lit = chosen, blinking
   * = waiting for its loop end, outlined = playing; * = unsaved edits.
   */
  private updatePatternButtons(now: number): void {
    const ch = this.heldTrack >= 0 ? this.heldTrack : this.selected;
    const c = this.project.channels[ch];
    const playingPattern = this.status?.patterns[ch] ?? c.activePattern;
    const blink = Math.floor(now / 250) % 2 === 0;
    PATTERN_NAMES.forEach((name, p) => {
      const pending = p === c.activePattern && playingPattern !== c.activePattern && this.playing;
      this.panel.setButtonFlag(`pat${name}`, 'lit', p === c.activePattern && (!pending || blink));
      this.panel.setButtonFlag(`pat${name}`, 'playing', this.playing && p === playingPattern && p !== c.activePattern);
      this.panel.setButtonFlag(`pat${name}`, 'dirty', this.dirty(c, p));
    });
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
    if (t.spec === OFFSET_SPEC) {
      const v = Math.round(t.get());
      return v === 0 ? 'SET' : `${v > 0 ? '+' : ''}${v}%`;
    }
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
      patternLabel: (this.playing && playingPattern !== c.activePattern
        ? `PAT ${PATTERN_NAMES[playingPattern]}>${PATTERN_NAMES[c.activePattern]}`
        : `PAT ${PATTERN_NAMES[c.activePattern]}`) + (this.dirty(c) ? '*' : ''),
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
      const pitched = !stepsOnStrip(lc.instrument);
      const tied = pitched ? tiedSteps(pat.steps, pat.length) : null;
      const cells: LaneCell[] = [];
      for (let k = 0; k < 16; k++) {
        const idx = page * 16 + k;
        const step = pat.steps[idx];
        const skip = idx < pat.length && !stepPlays(this.project.meter, pat.speed, idx, step.flip);
        cells.push({
          state: idx >= pat.length ? 'none' : step.active ? stepDynamic(step) : 'off',
          skip,
          tie: !!tied?.[idx],
          note: pitched && i === ch && step.active ? NOTE_NAMES[step.note % 12] : '',
          locked: !!step.locks && Object.keys(step.locks).length > 0,
          ring: step.active && !!step.ring,
          rest: !step.active && !!step.rest,
          slide: step.active && step.slide && !isDrum(lc.instrument),
          roll: !step.active ? 0 : step.slide && isDrum(lc.instrument) ? this.rollHits(lc) : 1,
        });
      }
      return {
        name: `${i + 1}${this.kindName(lc).slice(0, 4)}`,
        cells,
        playhead: head >= 0 && Math.floor(head / 16) === page ? head % 16 : -1,
        cursor: i === ch && pitched && this.mode === 'record' && Math.floor(this.cursor[i] / 16) === page ? this.cursor[i] % 16 : -1,
        muted: this.silenced(i),
        selected: i === ch,
      };
    });
    const page = this.visiblePage(ch);
    const len = this.pattern.length;
    const f = this.footer(audio);
    return {
      ...this.header(),
      stepsLabel: this.stepsMode ? 'STEPS: TAP = ON / OFF' : this.clearHeld ? 'CLEAR: STEP / TRACK' : this.copyHeld ? 'COPY: TRACK / A-D' : this.func && this.fxView === 0 ? 'FUNC: LIVE 3 / 4' : (len > 16 ? `${page * 16 + 1}-${Math.min(len, page * 16 + 16)}/${len}` : `${len} STEPS`) + SPEED_MARK[this.pattern.speed ?? 'normal'],
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

  /** SONG: the grid around the cursor row. */
  songView(now: number, audio: AudioInfo): SongView {
    const rows = this.songRows;
    const f = this.footer(audio);
    const playingRow = this.songPlaying ? (this.status?.songRow ?? -1) : -1;
    const visible = 11;
    const first = Math.max(0, Math.min(rows.length - visible, this.songRow - Math.floor(visible / 2)));
    const totalBars = rows.reduce((n, r) => n + r.bars, 0);
    const bar = this.status?.songBar ?? 0;
    return {
      ...this.header(),
      channelLabel: 'SONG',
      patternLabel: `${rows.length} ROWS ${totalBars} BARS`,
      tracks: this.project.channels.map((c, i) => `${i + 1}${this.kindName(c).slice(0, 3)}`),
      rows: rows.slice(first, first + visible).map((r, k) => ({
        index: first + k,
        bars: r.bars,
        cells: r.patterns.map((p) => (p < 0 ? '-' : PATTERN_NAMES[p])),
      })),
      cursorRow: this.songRow,
      cursorCol: this.songCol,
      playingRow,
      playingBar: bar,
      footerLeft: playingRow >= 0 ? `ROW ${playingRow + 1} BAR ${bar + 1}/${rows[playingRow]?.bars ?? 0}` : this.playing ? 'PLAYING PATTERNS' : 'PLAY = SONG FROM ROW',
      peak: audio.peak,
      footerRight: f.text,
      footerAlert: f.alert,
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }

  /** A bus open (RECORD / PLAY / DESIGN): the bus's knobs on screen, like a design page. */
  sendView(now: number, audio: AudioInfo): DesignView {
    const n = this.fxView;
    const f = this.footer(audio);
    const members = this.project.channels.flatMap((c, i) => (this.onBus(c, n) ? [String(i + 1)] : []));
    return {
      ...this.header(),
      channelLabel: n === 1 ? 'FX 1 DRUMS' : n === 2 ? 'FX 2 PAD' : n === 3 ? 'FX 3 LEAD' : 'LFO',
      patternLabel: '',
      kindLabel: this.mode.toUpperCase(),
      pages: ['FX 1', 'FX 2', 'FX 3', 'LFO'],
      page: n - 1,
      slots: this.slots(),
      touchedSlot: this.touchedKnob,
      liveLabel: members.length ? `TRACKS ${members.join(' ')}` : 'NO TRACKS',
      chordLabel: 'FN+TRACK = ON/OFF',
      peak: audio.peak,
      footerRight: f.text,
      footerAlert: f.alert,
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }

  /** The page buttons' names in this mode (none in RECORD / SONG). */
  private pageNames(): string[] {
    return this.mode === 'design' || this.mode === 'play' ? this.designPages().map((p) => p.name) : [];
  }

  /** PLAY with its MIX page open (and no bus open): the knobs and screen are the MIX page. */
  get playMix(): boolean {
    return this.mode === 'play' && this.playPage === 1 && this.fxView === 0;
  }

  designView(now: number, audio: AudioInfo): DesignView {
    const c = this.channel;
    const pages = this.designPages().slice(0, this.mode === 'play' ? PLAY_PAGES : undefined);
    const current = this.mode === 'play' ? this.playPage : this.designPage;
    const f = this.footer(audio);
    const liveName = (id: string) => this.liveName(c, id);
    return {
      ...this.header(),
      kindLabel: c.instrument !== 'none' && c.sounds[c.instrument]?.timbre !== undefined
        ? timbreName(c.instrument, c.sounds[c.instrument]!.timbre)
        : this.presetName(c),
      pages: pages.map((p, i) => (this.func && i === current ? `${p.name} FN` : p.name)),
      page: current,
      slots: this.slots(),
      touchedSlot: this.touchedKnob,
      liveLabel: this.func
        ? `FN LIVE ${liveName(c.liveFunc[0])} + ${liveName(c.liveFunc[1])}`
        : `LIVE ${liveName(c.live[0])} + ${liveName(c.live[1])}`,
      chordLabel: [c.fx1 ? 'FX1' : '', c.fxSend ? `FX${c.fxSend}` : '', c.lfoOn ? 'LFO' : '', !isDrum(c.instrument) && c.chord > 0 ? CHORD_NAMES[c.chord] : ''].filter(Boolean).join(' '),
      peak: audio.peak,
      footerRight: f.text,
      footerAlert: f.alert,
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }
}
