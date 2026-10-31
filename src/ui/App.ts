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
 * A-D (under FX): every track's pattern (hold channels + A-D = only those, unselected);
 * playing, each switches at its loop end. Each pattern has its own patch: RECORD / DESIGN edit the
 * chosen one; PLAY primes the switch for the loop end and the sound glides there.
 * SAVE PROJECT saves every pattern and patch; edits since are marked * on the screen.
 * MENU: MODE (JAM / SONG), PROJECT SETTINGS, GLOBAL SETTINGS. CANCEL / UNDO: see cancel().
 * SONG  (MENU > MODE; RECORD = the grid, PLAY / DESIGN play the song) arranging: a tracker-style grid of rows (bars + a pattern A-D or OFF per track).
 *          Knobs: top = each track's pattern in the cursor row, bottom 1 = BARS. ◀ ▶ column,
 *          ROW ▼ / ▲ (the OCT keys) row, INSERT / DELETE row, strip = jump to a row (while the song plays: at
 *          the next bar), channel taps select tracks, A-D = the row: that pattern on the selected tracks
 *          (none selected: all), the rest OFF; ROW ▼ past the end adds a row. PLAY here plays the
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
import { BUS_LAYOUT, FX_LIVE, NUM_BUSES, busParam } from '../fx/buses';
import { CHORD_KNOB, CHORD_NAMES, NOTES_NAMES } from '../engine/chords';
import {
  DYNAMIC_VELOCITY, emptyStep, MAX_STEPS, meterPlays, NUM_CHANNELS, NUM_PATTERNS, PATTERN_NAMES, PATTERN_SPEEDS, STEP_NOTES, setStepNotes, stepNotes, stepPlays,
  cloneNotes, clonePatch, editPattern, initPatterns, lockProject, patchOf, setPatchOf, speedSteps,
  setStepDynamic, stepDynamic, type ChannelState, type Dynamic, type InstrumentKind, type Project, type SettingKey, type SoundKind, type Step,
} from '../engine/project';
import { applyPreset, createDefaultProject, trackDefaults } from '../engine/defaultProject';
import { toStored } from '../engine/projectFile';
import type { MainToWorklet, WorkletToMain } from '../engine/protocol';
import { INSTRUMENTS, LIVE_MACROS, SOUND_KINDS, isDrum, linkedParams, liveTargets, paramSpec, playsChords, stepsOnStrip } from '../instruments/registry';
import { mirrorToCloud } from '../storage/cloud';
import { NAME_LENGTH, PROJECT_BANKS, SLOTS_PER_BANK, projectStore, saveWorkSoon } from '../storage/projects';
import { syncSlots } from '../storage/slotSync';
import { CLICK_LEVELS, COUNT_INS, HOLD_PATTERNS, HOLD_RESETS, HOLD_TIMES, KNOB_SPEEDS, METRONOMES, TOUCH_DELAYS, deviceSettings, saveDeviceSettings } from '../storage/settings';
import { DEFAULT_ROLL_RATE, ROLL_DIVS } from '../instruments/Drum';
import { macroIds, timbreName } from '../instruments/macros';
import { applyTrim, hiddenSound, trimFor } from '../instruments/trims';
import { readUserPatch, userPatches } from '../storage/saved';
import { DESIGN_PAGE_BUTTONS, FX_SEND_BUTTONS, KNOB_COUNT, KNOBS_PER_ROW, MODES, STEP_BUTTONS, type Panel } from './Panel';
import type { DesignView, LaneCell, LiveView, MenuView, ProjectView, SongStripView } from './views';
import { STRIP_MAX_BARS, clipAt, clipRows, patternBars, placeClip, rowOfBar, songBars, songClips, type Clip } from './songClips';
import { CELLS_PER_BAR, parseAutoKey, valueAt } from '../engine/automation';
import { UNDO_DEPTH, changes, restore, snapshot, type HistoryEntry } from './history';
import { ARP_MODES, ARP_PARAMS, defaultArp, type ArpId } from '../engine/arp';

type Mode = 'record' | 'play' | 'design';


/** MENU's pages (top = the list MENU opens on). */
type MenuPage = 'top' | 'project' | 'tracks' | 'global' | 'touch';
const MENU_TITLES: Record<MenuPage, string> = {
  top: 'MENU', project: 'PROJECT SETTINGS', tracks: 'TRACKS', global: 'GLOBAL SETTINGS', touch: 'TOUCH SETTINGS',
};

/**
 * MENU open: the pages gone into (the last one shown), each with the line its cursor is on
 * and its settings changed but not yet saved (line index -> option index; PLAY saves them).
 */
interface MainMenu {
  stack: { page: MenuPage; item: number; pending: Map<number, number> }[];
}

/**
 * One MENU line: a setting (◀ ▶ / knob 1 step through `options`; `get` = as saved, `set`
 * saves) or a way into a page (`open`, ▶ / its strip key).
 */
interface MenuLine {
  label: string;
  options?: readonly string[];
  get?(): number;
  set?(index: number): void;
  open?(): void;
}

/** TRACKS: the types a track can take, in this order (OFF = no instrument). */
const TRACK_KINDS: readonly InstrumentKind[] = ['none', ...SOUND_KINDS];

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
/** CHORD's knob: the chords in CHORD_KNOB's order (the value is a place on the knob, not the stored index). */
const CHORD_SPEC = choice('chord', 'CHORD', CHORD_KNOB.map((i) => CHORD_NAMES[i]));

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}
const isBlackKey = (n: number) => NOTE_NAMES[n % 12].length > 1;
/** SCALE: the natural minor's steps from the root (the strip's keys when not CHROMATIC). */
const MINOR = [0, 2, 3, 5, 7, 8, 10];

type Status = Extract<WorkletToMain, { type: 'status' }>;

/**
 * The note whose length covers step `index` (itself, or an earlier one tied over it,
 * wrapping round the loop end), as [step, distance]; null if none.
 */
function coveringNote(steps: Step[], length: number, index: number): [number, number] | null {
  for (let k = 0; k < length; k++) {
    const j = (index - k + length) % length;
    if (steps[j].active) return longest(steps[j]) > k ? [j, k] : null;
  }
  return null;
}

/** A step's longest note (PAD / PLUCK notes each have their own length), in steps. */
function longest(step: Step): number {
  return Math.max(1, step.gate, ...(step.extraGate ?? []));
}

/**
 * Steps covered by an earlier note (ties, also across the loop end), per step. One note at
 * a time (`poly` false): a later note ends the one before. PAD / PLUCK (`poly`): notes overlap, so
 * any earlier note's own length counts.
 */
function tiedSteps(steps: Step[], length: number, poly: boolean): boolean[] {
  const tied = new Array<boolean>(steps.length).fill(false);
  if (!poly) {
    for (let i = 0; i < length; i++) if (!steps[i].active) tied[i] = coveringNote(steps, length, i) !== null;
    return tied;
  }
  for (let j = 0; j < length; j++) {
    if (!steps[j].active) continue;
    const g = Math.min(length, longest(steps[j]));
    for (let k = 1; k < g; k++) {
      const i = (j + k) % length;
      if (!steps[i].active) tied[i] = true;
    }
  }
  return tied;
}

/**
 * PAD / PLUCK: every note sounding at step `at` (each by its own length, also across the loop
 * end), with the step it started on and how many steps back that is.
 */
function soundingAt(steps: Step[], length: number, at: number): { index: number; note: number; back: number }[] {
  const out: { index: number; note: number; back: number }[] = [];
  for (let j = 0; j < length; j++) {
    for (const n of stepNotes(steps[j])) {
      const back = (at - j + length) % length;
      if (back < n.gate) out.push({ index: j, note: n.note, back });
    }
  }
  return out;
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
  /** The panel's drawing: ms per frame (smoothed) and frames drawn per second. */
  uiMs: number;
  fps: number;
  /** The audio thread's load (process() time / audio time, smoothed; 1 = out of time). */
  dspLoad: number;
}

/** What one knob controls right now. */
interface KnobTarget {
  label: string;
  spec: ParamSpec;
  channel: number;
  get(): number;
  set(value: number): void;
  highlight?: boolean;
  /**
   * The value as last saved (real units; absent = spec.defaultValue): the project's saved
   * copy, a SOUND knob's from its pattern's saved patch. Away from it the knob shows yellow;
   * a double tap goes back to it.
   */
  base?(): number;
  /**
   * SONG automation: the knob's lane key (engine/automation.ts) and how its value maps to
   * the stored / engine value (x scale; the relative live knobs: % -> -1..1).
   */
  auto?: { key: string; scale?: number };
  /** SONG RECORD: touched while a step is primed (locked there on the second tap). */
  staged?: boolean;
  /** A primed step's stand-in for this knob: the knob it stands for. */
  inner?: KnobTarget;
  /** Identity of the parameter (for RESET glides): "ch:id", "lfo:id", "bus:k:id" ... */
  key?: string;
  /** Part of the edited pattern's patch (a SOUND param, PRESET): SONG only auditions it. */
  patch?: boolean;
  /** Playing: shows what its locks give at the playhead (`heardTarget`), updated every frame. */
  heard?: boolean;
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
/** SONG never changes a pattern (its notes, steps, length, speed, sound). */
const SONG_KEEPS = 'SONG: EDIT PATTERNS IN JAM';
/** DSP load from which the footer shows it in alert (the audio is about to break up). */
const DSP_ALERT = 0.8;
type GlobalId = 'bpm' | 'swing' | 'master';
/** The master knobs beside PLAY. */
const MASTER_GLOBAL: Readonly<Record<string, GlobalId>> = { mtempo: 'bpm', mmaster: 'master' };

/** A step's locks on its track's sound (its own params, live knobs) go; mixer / FX / LFO / ARP ones stay. */
function dropSoundLocks(step: Step, ch: number): void {
  if (!step.locks) return;
  for (const k of Object.keys(step.locks)) {
    if (!k.includes(':') || k.startsWith(`s:${ch}:`) || k.startsWith(`o:${ch}:`)) delete step.locks[k];
  }
  if (Object.keys(step.locks).length === 0) delete step.locks;
}

/** One note at a time: a chord keeps its lowest note (as a CHORD plays it). */
function lowestNoteOnly(step: Step): void {
  if (!step.extra?.length) return;
  step.note = Math.min(step.note, ...step.extra);
  delete step.extra;
  delete step.extraGate;
}

export class App {
  selected = 0;
  mode: Mode = 'play';
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
  /** Counts PLAY / STOP presses: the engine drops transport messages a STOP has overtaken. */
  private transportGen = 0;
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
  /** STRIP: the track's strip the other way round from its type's (drums: keys; the others: steps). Not saved. */
  private readonly stripFlip: boolean[] = new Array(NUM_CHANNELS).fill(false);
  private readonly octave: number[];
  /** Strip button -> note being held (keyboard), so release ends the right note. */
  private readonly heldNotes = new Map<number, number>();
  /** BASS / LEAD played live: the note sounding now (slides move it), -1 = none. */
  private liveNote = -1;
  /** Send shown on the knobs in RECORD/PLAY (1-3), 0 = the tracks' live knobs. */
  private fxView = 0;
  /** FUNC + ARP: the selected track's ARP knobs on screen. */
  private arpView = false;
  /**
   * STEP EDIT (RECORD, stopped): the strip shows the selected track's steps for locking knob
   * values on them; a step is always primed (yellow), ◀ ▶ / taps move it while nothing waits.
   */
  stepEdit = false;
  /** ROLL held down (PLAY / DESIGN, drum track): when it went down, and on which track. */
  private rollHeldAt = -1;
  private rollHeldCh = -1;
  /** CLEAR held, and whether anything was cleared while it was. */
  private clearHeld = false;
  private clearUsed = false;
  /**
   * COPY BAR (COPY held + BAR): the bar being copied and the target bar ◀ ▶ pick on the
   * selected track's pattern (COPY again = paste). `length` = the pattern's length before,
   * `saved` = the steps an added bar covered (put back if the bar is left again).
   */
  private copyBar: { from: number; to: number; length: number; saved: Map<number, Step> } | null = null;
  /**
   * SONG never changes a pattern: its sound knobs are heard through a copy of the patch per
   * track (the project keeps the pattern's own), dropped at STOP, a mode change etc. (endAudition).
   */
  private readonly audition = new Map<number, { kind: SoundKind; pattern: number; sound: Record<string, number>; trims: Record<string, number> }>();
  /** UNDO / REDO (history.ts): the steps back and forward, the project as of the last gesture. */
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private snap = '';
  /** save() since the snapshot. */
  private edited = false;
  /** The gesture running (key: the control that began it); skip = not undoable (SAVE / LOAD, MENU settings). */
  private gesture: { key: string; label: string; skip: boolean } | null = null;
  /** Buttons held down (FUNC aside): a press while one is held belongs to its gesture. */
  private down = new Set<string>();
  /** COPY held: + channel = copy the current pattern there, + A-D = to that pattern of this track. */
  private copyHeld = false;
  private copyUsed = false;
  /** Channel button held down (+ A-D = its pattern; selected on release if A-D was not used). */
  private heldTrack = -1;
  /** Every channel button down now (held + RESET = those tracks keep their state). */
  private readonly heldChannels = new Set<number>();
  /** FX 1-3 / LFO buttons down now (1-4; held + RESET = that bus / the LFO keeps its state). */
  private readonly heldBuses = new Set<number>();
  /** The bus view before the FX buttons now held opened / closed it (put back if they were held for RESET). */
  private fxViewBefore = 0;
  /** SOLO per track (not saved): any on mutes every track that is not. */
  private readonly soloed: boolean[] = new Array(NUM_CHANNELS).fill(false);
  private heldUsed = false;
  /** ACCENT / GHOST / RING held down (timer to start painting), and those painting steps. */
  /** SONG: the row and its bar PLAY starts from (`songStartBar`), in the song's rows. */
  private songRow = 0;
  /**
   * SONG DESIGN, the song strip: a lane of clips per track, one strip step = one bar (`songPage`
   * = which 16). `stripBar` = the cursor (selected track); STEP EDIT = ◀ ▶ change the length of
   * the cursor's clip; `stripStart` = the bar PLAY starts from.
   */
  private songPage = 0;
  private stripBar = 0;
  private stripEdit = false;
  private stripStart = 0;
  /** The transport is playing the song (not the patterns). */
  private songPlaying = false;
  /** Step entry in progress: the key held down and the step it wrote (for ties). */
  /** chord: PAD / PLUCK keys added to the step meanwhile (the cursor moves on when all are up). */
  /** The note(s) being entered in step entry: their key, step, held chord, and (PAD / PLUCK) which notes ▶ / ◀ tie. */
  private entry: { button: number; index: number; chord?: boolean; notes?: number[] } | null = null;
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
  /** SCALE held (+ ◀ ▶ = the root a semitone down / up; released unused = minor / chromatic). */
  private scaleHeld = false;
  private scaleUsed = false;
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
  /**
   * The project as last saved (the open slot's saved copy; nothing saved: as the session / a
   * new project began), for RESET and the knobs' yellow. Its patterns are left out: each
   * pattern keeps its own saved copy (Pattern.savedNotes / savedPatch).
   */
  private saved: Project;
  /** The empty slot a new project was started from (LOAD): SAVE opens on its bank. -1 = none. */
  private newSlot = -1;
  /** SAVE / LOAD (stopped only): name entry and the 64 slots, 16 to a bank on the strip. */
  projMenu: ProjectMenu | null = null;
  /** MENU open. */
  menu: MainMenu | null = null;
  /**
   * MENU > MODE = SONG: the modes work on the song. RECORD = the grid (building it), PLAY /
   * DESIGN = as with patterns while PLAY plays the song.
   */
  song = false;
  /** SONG: the bar inside the cursor row PLAY starts from (BAR + ◀ ▶; 0 = its first). */
  private songStartBar = 0;
  /**
   * SONG RECORD step entry: the primed cell (song position), the knobs touched since with the
   * value each will be locked at, and the knobs' own values to put back (auditioned meanwhile).
   */
  private primed: {
    cell: number;
    /** STEP EDIT: the pattern whose step it is (cell = its step); absent = a SONG RECORD cell. */
    pattern?: { ch: number; p: number };
    staged: Map<string, { t: KnobTarget; v: number }>;
    orig: Map<string, { t: KnobTarget; v: number }>;
    dirty: boolean[];
  } | null = null;
  private glides = new Map<string, Glide>();
  private glideStart = 0;
  private glideEnd = 0;
  /** RESET was just tapped: until then a second tap reverts unsaved notes too. */
  private resetAgainUntil = 0;
  /** RESET lit until (the patches' glide to the bar line). */
  private resetLitUntil = 0;
  private targets: (KnobTarget | null)[] = [];
  /**
   * Knobs held down (slot -> the job it had when touched): a held knob keeps that job through
   * FUNC, page and view changes until it is let go (MENU / name entry take it over).
   */
  private readonly heldKnobs = new Map<number, KnobTarget | null>();
  /** The knobs' jobs before the SONG / primed / playhead wrappers (what a held knob keeps). */
  private rawTargets: (KnobTarget | null)[] = [];
  /** The click setting last sent to the engine. */
  private clickSent = '';

  constructor(
    public project: Project,
    private readonly panel: Panel,
    private send: (msg: MainToWorklet) => void,
  ) {
    project.channels.forEach(initPatterns);
    this.saved = this.savedOf(project);
    this.octave = project.channels.map((c) => (c.instrument === 'none' ? 36 : INSTRUMENTS[c.instrument].baseNote));
    this.snap = snapshot(project);
    panel.subscribe((e) => this.onControl(e));
    this.refreshPanel();
  }

  setStatus(s: Status): void {
    this.status = s;
    this.statusAt = performance.now();
    if (s.countIn > 0) {
      this.message = `COUNT-IN ${s.countIn}`;
      this.messageUntil = this.statusAt + 200;
    }
  }

  /** The project as last saved (see `saved`). */
  private savedProject(): Project {
    return this.saved;
  }

  /** `saved` for a project just opened: its slot's saved copy, else the project as it is; without patterns. */
  private savedOf(project: Project): Project {
    const openId = projectStore.openId();
    const from = (openId ? projectStore.load(openId) : null) ?? project;
    return JSON.parse(JSON.stringify({ ...from, channels: from.channels.map((c) => ({ ...c, patterns: [] })) })) as Project;
  }

  /** Track ch as last saved, when it was the same type then (else nothing to compare). */
  private savedChannel(ch: number): ChannelState | undefined {
    const s = this.savedProject().channels[ch];
    return s && s.instrument === this.project.channels[ch].instrument ? s : undefined;
  }

  /** A GLOBAL setting as it applies now: the project's own choice, else (DEFAULT) the device's. */
  private setting(key: SettingKey): number {
    return this.project.settings?.[key] ?? deviceSettings[key];
  }

  /** METRONOME: the click with the music (RECORDING = in RECORD mode), at CLICK LEVEL. */
  private clickMessage(): Extract<MainToWorklet, { type: 'setClick' }> {
    const m = this.setting('metronome');
    return { type: 'setClick', on: m === 2 || (m === 1 && this.mode === 'record' && !this.song), level: CLICK_LEVELS[this.setting('clickLevel')] / 100 };
  }

  /** Sends the click setting when it changed (mode or settings). */
  private syncClick(): void {
    const msg = this.clickMessage();
    const key = `${msg.on}:${msg.level}`;
    if (key === this.clickSent) return;
    this.clickSent = key;
    this.send(msg);
  }

  /** Messages that bring a freshly started engine in line with the UI. */
  syncMessages(): MainToWorklet[] {
    return [
      { type: 'loadProject', project: this.project },
      ...this.muteMessages(),
      { type: 'transport', playing: this.playing, gen: this.transportGen },
      this.clickMessage(),
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
      // A PAD / PLUCK note joined the step (one step long), or was released (its own length).
      if (!step.active) return;
      const notes = stepNotes(step);
      const k = notes.findIndex((n, i) => i > 0 && n.note === m.note);
      if (k > 0) notes[k].gate = m.gate;
      else notes.push({ note: m.note, gate: m.gate });
      setStepNotes(step, notes);
    } else if (m.type === 'recordedNote') {
      if (m.start) { delete step.extra; delete step.extraGate; } // a new note replaces the step, chord notes too
      // Chord notes keep their own lengths when the first note's changes.
      if (step.extra && !step.extraGate) step.extraGate = step.extra.map(() => step.gate);
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
    if (this.autoSteps || this.copyBar || this.stepEdit) return false;
    if (this.song) return true; // SONG never edits a pattern's steps
    if (this.clearHeld && this.mode !== 'design') return false;
    if (this.stepsMode) return false;
    if (this.placing && this.mode === 'record') return false;
    return !this.stripSteps();
  }

  /**
   * Track ch's strip shows steps (painted like a drum lane), not keys, in every mode (SONG
   * aside). Drums (KICK, SNARE, HAT) by default, the others with the STRIP key (`stripFlip`).
   */
  private stripSteps(ch = this.selected): boolean {
    return stepsOnStrip(this.project.channels[ch].instrument) !== this.stripFlip[ch];
  }

  /** SCALE's root (pitch class; A unless set). */
  private get root(): number {
    return this.project.root ?? 9;
  }

  /** SCALE as named on its key and screen: A MIN / A CHR. */
  private scaleName(): string {
    return `${NOTE_NAMES[this.root]} ${this.project.chromatic ? 'CHR' : 'MIN'}`;
  }

  /**
   * The note strip key `button` plays on track ch: a semitone each, up from SCALE's root
   * (within a fifth or so of the track's octave, `octave` = an A: the root moves the keys a
   * semitone at a time, jumping an octave between D and D#). `blackKey` colours them.
   */
  private keyNote(ch: number, button: number): number {
    return this.octave[ch] + ((this.root - 9 + 6 + 12) % 12) - 6 + button;
  }

  /** A strip key shows black: off SCALE's minor scale (CHROMATIC: a piano's sharps). */
  private blackKey(note: number): boolean {
    return this.project.chromatic ? isBlackKey(note) : !MINOR.includes((note - this.root + 120) % 12);
  }

  /** The ARP view open (FUNC + ARP): knobs and screen show the selected track's ARP. */
  get arpOpen(): boolean {
    return this.arpView && !this.songGrid;
  }

  /** RECORD / PLAY with a bus open: knobs and screen show that bus. */
  get sendOpen(): boolean {
    return !this.songGrid && this.fxView > 0;
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
    return this.mode === 'record' && this.playing && !this.song;
  }

  /** SONG DESIGN: the grid takes the strip, knobs, A-D, the function row and the screen. */
  get songGrid(): boolean {
    return this.song && this.mode === 'design';
  }

  /** SONG RECORD: the song's steps (locks; stopped: `autoSteps`), with the LIVE / SOUND / MIX pages. */
  get songRecord(): boolean {
    return this.song && this.mode === 'record';
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
    if (this.copyBar && ch === this.selected) return this.copyBar.to;
    if (this.stepEdit && this.primed && ch === this.selected) return Math.floor(this.primed.cell / 16);
    const c = this.project.channels[ch];
    const heard = this.status?.patterns[ch] ?? c.activePattern;
    const head = this.status?.steps[ch] ?? -1;
    // Other lanes, PLAY, DESIGN and live recording (placing a flag too) follow the playhead's
    // 16-step block.
    // Stopped, every track shows the bar it stopped in (or was set to): the next PLAY's start.
    const following = this.playing && (ch !== this.selected || (this.followsPlayhead && !this.stepsMode));
    let page: number;
    if (following) page = head >= 0 && heard === c.activePattern ? Math.floor(head / 16) : this.viewPage[ch];
    else if (!this.stripSteps(ch) && this.mode === 'record' && !this.stepsMode) {
      // Step entry: the cursor's block, or while a note is being tied, the block its end is in
      // (a tie runs on past the bar line into the next block, and round past the loop end).
      const at = this.entry && ch === this.selected ? (this.entry.index + this.entryLength() - 1) % c.patterns[c.activePattern].length : this.cursor[ch];
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

  // ---------------------------------------------------------------- knob targets

  /**
   * What a track's live knobs may control: its type's macros, every sound parameter on its
   * sound page (both layers; coarse ones and CHORD absolute), the mixer, the FX buses' volumes
   * (+ FX 1's FILTER) and the LFO.
   */
  private liveCandidates(c: ChannelState): { id: string; spec: ParamSpec }[] {
    const list: { id: string; spec: ParamSpec }[] = [];
    if (c.instrument !== 'none') {
      for (const m of LIVE_MACROS[c.instrument]) list.push({ id: m.id, spec: { ...OFFSET_SPEC, name: m.name } });
      if (!isDrum(c.instrument)) list.push({ id: 'track:notes', spec: choice('notes', 'NOTES', NOTES_NAMES) });
      const entry = INSTRUMENTS[c.instrument];
      for (const id of [...entry.layout, ...entry.funcLayout]) {
        const spec = id ? entry.params.find((p) => p.id === id) : undefined;
        if (id === 'track:chord' && !list.some((x) => x.id === id)) list.push({ id, spec: CHORD_SPEC });
        if (spec && !list.some((x) => x.id === spec.id)) list.push({ id: spec.id, spec });
      }
    }
    for (const spec of MIX_PARAMS) list.push({ id: MIX_PREFIX + spec.id, spec });
    for (const fx of FX_LIVE) list.push({ id: fx.id, spec: { ...busParam(fx.bus, fx.param)!, name: fx.name } });
    for (const id of ['rate', 'vol', 'pitch', 'filter', 'pan', 'send', 'fm', 'morph', 'phase', 'smooth'] as const) list.push({ id: `lfo:${id}`, spec: LFO_PARAMS[id] });
    return list;
  }

  /** A live knob's name (macro, sound param, mixer, LFO). */
  private liveName(c: ChannelState, id: string): string {
    if (id.startsWith('macro:')) return c.instrument === 'none' ? '-' : LIVE_MACROS[c.instrument].find((m) => m.id === id)?.name ?? '-';
    if (id.startsWith('lfo:')) return LFO_PARAMS[id.slice(4) as LfoId]?.name ?? '-';
    if (id.startsWith(MIX_PREFIX)) return MIX_PARAMS.find((p) => MIX_PREFIX + p.id === id)?.name ?? '-';
    if (id === 'track:notes') return 'NOTES';
    if (id === 'track:chord') return 'CHORD';
    const fx = FX_LIVE.find((f) => f.id === id);
    if (fx) return fx.name;
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
      auto: { key: `o:${ch}:${id}`, scale: 0.01 },
      get: () => (c.liveOffset[id] ?? 0) * 100,
      base: () => (this.savedChannel(ch)?.liveOffset[id] ?? 0) * 100,
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
    const fx = FX_LIVE.find((f) => f.id === id);
    if (fx) return { ...this.busTarget(fx.bus, fx.param), label: label ?? fx.name, channel: ch, highlight };
    if (id.startsWith('lfo:')) {
      const lfoId = id.slice(4) as LfoId;
      const spec = LFO_PARAMS[lfoId];
      return {
        label: label ?? spec.name, spec, channel: ch, highlight, key: id, auto: { key: `l:${lfoId}` },
        get: () => this.project.lfo[lfoId],
        base: () => this.savedProject().lfo[lfoId],
        set: (v) => { this.project.lfo[lfoId] = v; this.send({ type: 'setLfo', id: lfoId, value: v }); },
      };
    }
    if (id === 'track:notes') {
      return {
        label: label ?? 'NOTES', spec: choice('notes', 'NOTES', NOTES_NAMES), channel: ch, highlight, key: `${ch}:${id}`,
        get: () => c.notes - 1,
        base: () => (this.savedChannel(ch)?.notes ?? c.notes) - 1,
        set: (v) => { c.notes = v + 1; this.send({ type: 'setNotes', channel: ch, notes: c.notes }); },
      };
    }
    if (id === 'track:preset' && c.instrument !== 'none') {
      const kind = c.instrument;
      return {
        label: label ?? 'PRESET', spec: choice('preset', 'PRESET', this.presetNames(kind)), channel: ch, highlight, patch: true,
        get: () => c.presets[kind] ?? 0,
        base: () => c.patterns[c.activePattern].savedPatch?.preset ?? 0,
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
        // The knob runs in CHORD_KNOB's order (chords are stored by index).
        label: label ?? 'CHORD', spec: CHORD_SPEC, channel: ch, highlight, key: `${ch}:${id}`,
        get: () => Math.max(0, CHORD_KNOB.indexOf(c.chord)),
        base: () => Math.max(0, CHORD_KNOB.indexOf(this.savedChannel(ch)?.chord ?? 0)),
        set: (v) => {
          c.chord = CHORD_KNOB[Math.round(v)] ?? 0;
          this.send({ type: 'setChord', channel: ch, chord: c.chord });
        },
      };
    }
    if (id.startsWith(MIX_PREFIX)) {
      const mixId = id.slice(MIX_PREFIX.length) as MixId;
      const spec = MIX_PARAMS.find((p) => p.id === mixId);
      if (!spec) return null;
      const field = MIX_FIELD[mixId];
      return {
        label: label ?? spec.name, spec, channel: ch, highlight, key: `${ch}:${id}`, auto: { key: `m:${ch}:${mixId}` },
        base: () => this.savedChannel(ch)?.[field] ?? spec.defaultValue,
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
      label: label ?? spec.name, spec, channel: ch, highlight, key: `${ch}:${id}`, patch: true,
      // Coarse settings (TIMBRE, waves, presets) aren't automated; the rest are.
      auto: spec.coarse && id !== 'timbre' ? undefined : { key: `s:${ch}:${id}` },
      get: () => c.sounds[kind]?.[id] ?? spec.defaultValue,
      base: () => c.patterns[c.activePattern].savedPatch?.sound[id] ?? spec.defaultValue,
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
    c.patterns[c.activePattern].patchDirty = true;
    this.writeSound(ch, kind, c.activePattern, (c.sounds[kind] ??= {}), (c.trims[kind] ??= {}), id, v, recompute);
  }

  /** setSoundParam on a given sound / trims (the edited pattern's, or a SONG audition's). */
  private writeSound(ch: number, kind: SoundKind, pattern: number, sound: Record<string, number>, trims: Record<string, number>, id: string, v: number, recompute = true): void {
    const specs = INSTRUMENTS[kind].params;
    sound[id] = v;
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

  /** SONG: a pattern's sound knob is heard (on a copy of the patch), never kept in the pattern. */
  private auditionTarget(t: KnobTarget): KnobTarget {
    const ch = t.channel;
    const c = this.project.channels[ch];
    const id = t.spec.id;
    if (id === 'preset') return { ...t, set: () => this.flash(SONG_KEEPS) };
    return {
      ...t,
      get: () => this.audition.get(ch)?.sound[id] ?? t.get(),
      set: (v) => {
        if (c.instrument === 'none') return;
        const kind = c.instrument;
        let a = this.audition.get(ch);
        if (!a || a.kind !== kind || a.pattern !== c.activePattern) {
          if (this.audition.size === 0) this.flash('SONG: HEARD, NOT KEPT');
          a = { kind, pattern: c.activePattern, sound: { ...c.sounds[kind] }, trims: { ...c.trims[kind] } };
          this.audition.set(ch, a);
        }
        this.writeSound(ch, kind, a.pattern, a.sound, a.trims, id, v);
        for (const other of linkedParams(kind, id)) this.writeSound(ch, kind, a.pattern, a.sound, a.trims, other, v);
      },
    };
  }

  /** The SONG auditions end: each track's pattern sounds as it is again. */
  private endAudition(): void {
    for (const [ch, a] of this.audition) {
      const c = this.project.channels[ch];
      if (c.instrument === a.kind) this.send({ type: 'setPatch', channel: ch, pattern: a.pattern, sound: { ...patchOf(c, a.pattern).sound }, glide: this.playing });
    }
    this.audition.clear();
  }

  /** The sound's OCTAVE as shown ('OCT+1', 'OCT 0'); '' on a type without one (drums, PERC). */
  private soundOctave(c: ChannelState): string {
    if (c.instrument === 'none') return '';
    const spec = INSTRUMENTS[c.instrument].params.find((p) => p.id === 'octave');
    if (!spec?.options) return '';
    const name = spec.options[Math.round(c.sounds[c.instrument]?.octave ?? spec.defaultValue)] ?? '0';
    return name === '0' ? 'OCT 0' : `OCT${name}`;
  }

  /**
   * FUNC + OCT ▼ / ▲: step the selected synth's OCTAVE parameter (part of its patch) instead
   * of the keyboard's octave. False when the track has no OCTAVE (drums, PERC).
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
    const sound = { name: 'SOUND', targets: () => this.soundTargets(this.func) };
    const mix = { name: 'MIX', targets: () => this.mixTargets() };
    // SONG RECORD (automation): the live knobs instead of PROJECT, first.
    if (this.song) return [{ name: 'LIVE', targets: () => this.liveGrid() }, sound, mix];
    return [sound, mix, { name: 'PROJECT', targets: () => this.projectTargets() }];
  }

  /** The selected track's SOUND page (func: its FUNC layer). */
  private soundTargets(func: boolean): (KnobTarget | null)[] {
    const ch = this.selected;
    const c = this.channel;
    const entry = c.instrument === 'none' ? null : INSTRUMENTS[c.instrument];
    const layout = entry ? (func ? entry.funcLayout : entry.layout) : [];
    return layout.map((id) => (id ? this.paramTarget(ch, id) : null));
  }

  /** DESIGN's page for a track's sound (a channel tap opens it): SOUND, after LIVE in SONG. */
  private get soundPage(): number {
    return this.song ? 1 : 0;
  }

  /** The live knobs: column = track, rows = live knob 1 / 2 (FUNC: 3 / 4). */
  private liveGrid(func = this.func): (KnobTarget | null)[] {
    const out: (KnobTarget | null)[] = [];
    for (let row = 0; row < 2; row++) {
      for (let ch = 0; ch < KNOBS_PER_ROW; ch++) {
        const c = this.project.channels[ch];
        out.push(this.liveKnob(ch, (func ? c.liveFunc : c.live)[row], ch === this.selected));
      }
    }
    return out;
  }

  private getGlobal(id: GlobalId): number {
    return this.project[id];
  }

  private setGlobal(id: GlobalId, v: number): void {
    if (id === 'bpm') v = Math.round(v); // whole BPM only
    this.project[id] = v;
    this.send({ type: 'setGlobal', id, value: v });
  }

  /**
   * A bus's knobs (k = 0-2: FX 1-3; 3: the LFO): four units of two modules each (buses.ts),
   * the same in RECORD, PLAY and DESIGN. No FUNC layer.
   */
  private sendTargets(k: number): (KnobTarget | null)[] {
    if (k === 3) return LFO_LAYOUT.map((id) => (id ? this.paramTarget(this.selected, `lfo:${id}`) : null));
    return BUS_LAYOUT[k].map((id) => this.busTarget(k, id));
  }

  /** One bus knob (also a live knob's FX target). */
  private busTarget(k: number, id: string): KnobTarget {
    const spec = busParam(k, id)!;
    return {
      label: spec.name, spec, channel: this.selected, key: `bus:${k}:${id}`, auto: { key: `b:${k}:${id}` },
      get: () => this.project.buses[k][id] ?? spec.defaultValue,
      base: () => this.savedProject().buses[k]?.[id] ?? spec.defaultValue,
      set: (v: number) => { this.project.buses[k][id] = v; this.send({ type: 'setBus', bus: k, id, value: v }); },
    };
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
   * DESIGN > PROJECT (global): TEMPO, SWING, MASTER, TIME SIG on top; every track's
   * ACC/GHOST below. With FUNC below: TRIM on a synth track, RING (how long RING steps ring)
   * on a drum track; each slot follows its track's type (see TRACKS).
   */
  private projectTargets(): (KnobTarget | null)[] {
    const top: (KnobTarget | null)[] = GLOBAL_PARAMS.map((spec) => ({
      label: spec.name, spec, channel: this.selected, key: `global:${spec.id}`,
      base: () => this.savedProject()[spec.id as GlobalId | 'meter'],
      get: () => this.getGlobal(spec.id as GlobalId),
      set: (v: number) => this.setGlobal(spec.id as GlobalId, v),
    }));
    while (top.length < KNOBS_PER_ROW) top.push(null);
    if (this.func) {
      const bottom = this.project.channels.map((c, ch) => (c.instrument === 'none' ? null
        : isDrum(c.instrument) ? this.paramTarget(ch, 'mix:ring', `RING ${ch + 1}`, ch === this.selected)
        : this.paramTarget(ch, 'mix:gate', `TRIM ${ch + 1}`, ch === this.selected)));
      return [...new Array<KnobTarget | null>(KNOBS_PER_ROW).fill(null), ...bottom];
    }
    return [...top, ...this.trackRow('mix:dyn', 'ACC')];
  }

  /** The 16 knob targets for the current mode. */
  private computeTargets(): (KnobTarget | null)[] {
    if (this.projMenu) return this.nameTargets();
    if (this.menu) return this.menuTargets();
    // FUNC layers exist for the DESIGN pages and the live knobs; elsewhere FUNC
    // leaves the knobs empty.
    if (this.songGrid) return new Array(KNOB_COUNT).fill(null);
    // A held knob keeps its job (as touched), wrapped afresh below. SONG: a pattern's sound
    // knobs only audition. A primed step (STEP EDIT, SONG RECORD): the knobs show and set what
    // will be locked there. Playing: knobs with locks show what the locks give at the playhead.
    const step = (layer: (KnobTarget | null)[]) => {
      const t = layer.map((x, i) => (this.heldKnobs.has(i) ? this.heldKnobs.get(i) ?? null : x));
      this.rawTargets = t;
      const heard = this.song ? t.map((x) => (x?.patch ? this.auditionTarget(x) : x)) : t;
      if (this.primed) return heard.map((x) => (x?.auto ? this.primedTarget(x) : x));
      return this.playing ? heard.map((x, i) => (x?.auto ? this.heardTarget(x, i) : x)) : heard;
    };
    if (this.arpOpen) return step(this.arpTargets()); // no FUNC layer: FUNC (still held) leaves it showing
    if (this.fxView > 0) return step(this.func ? new Array(KNOB_COUNT).fill(null) : this.sendTargets(this.fxView - 1));
    // STEP EDIT: the RECORD knobs; FUNC = the track's SOUND page (its first layer).
    if (this.stepEdit) return step(this.func ? this.soundTargets(false) : this.playMix ? this.mixTargets() : this.liveGrid(false));
    if (this.mode === 'design' || this.songRecord) {
      const pages = this.designPages();
      this.designPage = Math.min(this.designPage, pages.length - 1);
      const t = pages[this.designPage].targets();
      return step(Array.from({ length: KNOB_COUNT }, (_, i) => t[i] ?? null));
    }
    if (this.playMix) return step(this.mixTargets());
    return step(this.liveGrid());
  }

  // ---------------------------------------------------------------- controls

  private onControl(e: ControlEvent): void {
    this.trackGesture(e);
    if (e.type === 'encoder') return this.onEncoder(e.id, e.delta);
    if (e.type === 'knob' && e.id.startsWith('m')) return this.onMasterKnob(e.id, e.value);
    if (e.type === 'knob') return this.onKnob(Number(e.id.slice(1)) - 1, e.value);
    if (e.type === 'touch') {
      const slot = Number(e.id.slice(1)) - 1;
      if (!e.id.startsWith('m') && !this.menu && !this.projMenu && !this.songGrid) this.heldKnobs.set(slot, this.rawTargets[slot] ?? null);
      return this.onTouch(slot);
    }
    if (e.type === 'release') {
      // Let go: the knob takes the job the panel now gives it.
      if (this.heldKnobs.delete(Number(e.id.slice(1)) - 1)) this.refreshPanel();
      return;
    }
    if (e.type !== 'button') return;
    const id = e.id;
    let m: RegExpExecArray | null;
    if ((m = /^ch(\d)$/.exec(id))) {
      if (e.pressed) this.heldChannels.add(Number(m[1]) - 1);
      else this.heldChannels.delete(Number(m[1]) - 1);
    }
    if ((m = /^fx([1-4])$/.exec(id))) {
      if (e.pressed) {
        if (this.heldBuses.size === 0) this.fxViewBefore = this.fxView; // the view before the first one
        this.heldBuses.add(Number(m[1]));
      } else this.heldBuses.delete(Number(m[1]));
    }
    if (id === 'func') return this.onFunc(e.pressed);
    if (this.projMenu && this.onProjectMenu(id, e.pressed)) {
      this.refreshPanel();
      return;
    }
    if (this.menu && this.onMenu(id, e.pressed)) {
      this.refreshPanel();
      return;
    }
    if (this.songGrid && (id === 'clear' || id === 'copy')) {
      this.stripHold(id, e.pressed);
      this.refreshPanel();
      return;
    }
    if (!e.pressed) {
      if ((m = /^step(\d+)$/.exec(id))) this.releaseKey(Number(m[1]) - 1);
      if (id === 'slide' && this.rollHeldCh >= 0) this.releaseRoll();
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
            if (this.mode === 'design' || this.songRecord) this.designPage = this.soundPage;
          }
        } else if (!this.sendOpen && !this.heldUsed && this.stepEdit && this.waiting && this.heldTrack !== this.selected) {
          this.flash('LOCK OR CANCEL FIRST');
        } else if (!this.sendOpen && !this.heldUsed) {
          // A plain tap (no A-D meanwhile) selects the track; in DESIGN it opens its SOUND
          // page (MIX and PROJECT are global).
          this.selected = this.heldTrack;
          if (this.mode === 'design' || this.songRecord) {
            this.designPage = this.soundPage;
            this.touchedKnob = -1;
          }
        }
        this.heldTrack = -1;
        this.refreshPanel();
      }
      if (id === 'clear') {
        this.clearHeld = false;
        if (!this.clearUsed) this.flash('HOLD CLEAR + STEP / TRACK / A-D');
        this.refreshPanel();
      }
      if (id === 'steppage' && this.barHeld) {
        // BAR tapped (no ◀ / ▶ meanwhile): the next bar (SONG grid: the next page of rows).
        this.barHeld = false;
        if (!this.barUsed) {
          if (this.songGrid) this.stripPage((this.songPage + 1) % this.stripPages());
          else this.changeBar(1);
        }
        this.refreshPanel();
      }
      if (id === 'scale' && this.scaleHeld) {
        // SCALE tapped (no ◀ / ▶ meanwhile): minor keys / chromatic keys.
        this.scaleHeld = false;
        if (!this.scaleUsed) {
          if (this.project.chromatic) delete this.project.chromatic;
          else this.project.chromatic = true;
          this.flash(`SCALE: ${this.scaleName()}`);
          this.save();
        }
        this.refreshPanel();
      }
      if (id === 'len' && this.lenHeld) {
        // STEPS tapped (no ◀ / ▶ meanwhile): STEPS mode on / off.
        this.lenHeld = false;
        if (!this.lenUsed) {
          this.leaveStepEdit();
          this.stepsMode = !this.stepsMode;
          this.flash(this.stepsMode ? 'STEPS: STEP = ON / OFF, TRACK = BAR' : 'STEPS OFF');
        }
        this.refreshPanel();
      }
      if (id === 'copy') {
        this.copyHeld = false;
        if (!this.copyUsed) this.flash(this.stepEdit ? 'HOLD COPY + TAP STEPS' : 'HOLD COPY + TRACK / A-D');
        this.refreshPanel();
      }
      return;
    }
    // The other strip modes (flag placing, REST) end STEP EDIT.
    if (this.stepEdit && (id === 'ring' || id === 'slide' || id === 'dyn:accent' || id === 'dyn:ghost' || id === 'rest')) this.leaveStepEdit();
    if (id === 'copy' && this.copyBar) {
      this.pasteBar();
      this.copyUsed = true; // its release is not a tap
      this.copyHeld = true;
      this.refreshPanel();
      return;
    }
    if (id === 'copy') {
      this.copyHeld = true;
      this.copyUsed = false;
      this.refreshPanel();
      return;
    }
    if (this.copyHeld && id === 'steppage' && !this.song) {
      this.leaveStepEdit();
      this.startCopyBar();
      this.copyUsed = true;
      this.refreshPanel();
      return;
    }
    if (this.copyBar && !(id === 'cancel' || id === 'play' || id.startsWith('mode:'))) {
      // ◀ ▶ = the target bar; the rest waits (CANCEL drops it, a mode change too).
      if (id === 'cur-' || id === 'cur+') this.moveCopyBar(id === 'cur+' ? 1 : -1);
      this.refreshPanel();
      return;
    }
    if (this.copyHeld && !this.songGrid && ((m = /^ch(\d)$/.exec(id)) || (m = /^pat([A-D])$/.exec(id)))) {
      // COPY + channel: the same pattern slot on that track; COPY + A-D: that pattern of
      // this track. (SONG DESIGN: COPY is its own, stripHold.)
      if (this.song) {
        this.copyUsed = true;
        this.flash(SONG_KEEPS);
        this.refreshPanel();
        return;
      }
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
    if (this.clearHeld && !this.songGrid && ((m = /^ch(\d)$/.exec(id)) || (m = /^pat([A-D])$/.exec(id)))) {
      // CLEAR + channel: that track's pattern; + A-D: that pattern of the selected track (the
      // one playing / edited too).
      const pat = id.startsWith('pat') ? PATTERN_NAMES.indexOf(m[1] as (typeof PATTERN_NAMES)[number]) : -1;
      if (this.song) { this.clearUsed = true; this.flash(SONG_KEEPS); }
      else if (pat < 0) this.clearTrack(Number(m[1]) - 1);
      else this.clearTrack(this.selected, pat);
      this.refreshPanel();
      return;
    }
    if (this.stepsMode && (m = /^ch(\d)$/.exec(id))) {
      // STEPS mode: the track buttons are the pattern's bars.
      this.toggleBar(Number(m[1]) - 1);
      this.refreshPanel();
      return;
    }
    if ((m = /^ch(\d)$/.exec(id))) {
      this.heldTrack = Number(m[1]) - 1;
      this.heldUsed = false;
    }
    if (this.songGrid && (m = /^pat([A-D])$/.exec(id))) {
      this.stripPattern(PATTERN_NAMES.indexOf(m[1] as (typeof PATTERN_NAMES)[number]));
      this.refreshPanel();
      return;
    }
    if ((m = /^pat([A-D])$/.exec(id))) {
      // A-D: every track; channels held: HOLD + PATTERN = KEEP HELD switches all but those,
      // SWITCH HELD only those.
      const pat = PATTERN_NAMES.indexOf(m[1] as (typeof PATTERN_NAMES)[number]);
      if (this.heldChannels.size > 0) {
        const held = [...this.heldChannels].sort();
        const names = held.map((ch) => ch + 1).join(' ');
        if (this.setting('holdPattern') === 1) {
          for (const ch of held) this.selectPattern(ch, pat, held.length === 1);
          if (held.length > 1) this.flash(`${names} PAT ${m[1]}`);
        } else {
          for (let ch = 0; ch < NUM_CHANNELS; ch++) if (!this.heldChannels.has(ch)) this.selectPattern(ch, pat, false);
          this.flash(`ALL BUT ${names} PAT ${m[1]}`);
        }
        this.heldUsed = true;
      } else {
        for (let ch = 0; ch < NUM_CHANNELS; ch++) this.selectPattern(ch, pat, false);
        this.flash(`ALL TRACKS PAT ${m[1]}`);
      }
      this.refreshPanel();
      return;
    }
    if (this.songGrid && this.onStripButton(id)) {
      this.refreshPanel();
      return;
    }
    // SONG: the keys that edit a pattern (STEPS, TIME, REST, flag placing, the sound's OCTAVE)
    // do nothing to it.
    const flag = id === 'ring' || id === 'slide' || id === 'dyn:accent' || id === 'dyn:ghost';
    if (this.song && (id === 'len' || id === 'speed' || id === 'rest' || (flag && (this.mode === 'record' || this.songGrid)) || ((id === 'oct-' || id === 'oct+') && this.func))) {
      if (this.funcHeld) this.funcUsed = true;
      this.flash(SONG_KEEPS);
      this.refreshPanel();
      return;
    }
    if (id === 'play') {
      // STEP EDIT stays on through PLAY / STOP (its primed step and waiting knobs too).
      if (!this.stepEdit) this.unprime();
      // FUNC + PLAY = from the top (stopping: back to the top for the next PLAY); FUNC lets go.
      const top = this.func;
      if (top) {
        this.funcHeld = false;
        this.funcLatched = false;
        this.funcUsed = true;
      }
      if (this.playing) {
        this.keepBars(top);
        this.endAudition();
      }
      if (this.playing && this.songPlaying) {
        // STOP in SONG: the next PLAY carries on from the row and bar playing (FUNC: the top).
        const row = top ? 0 : (this.status?.songRow ?? -1);
        if (row >= 0) {
          this.songRow = Math.min(row, this.songRows.length - 1);
          this.songStartBar = top ? 0 : Math.max(0, this.status?.songBar ?? 0);
          this.stripStart = this.songBarNumber(this.songRow, this.songStartBar) - 1;
          this.songPage = Math.floor(this.stripStart / 16);
        }
      }
      this.playing = !this.playing;
      // PLAY in SONG mode plays the song from `stripStart` (FUNC: the top), in whichever row
      // holds it; elsewhere the patterns, from the bar the strip shows for the selected track
      // (every track where it would be then).
      this.songPlaying = this.playing && this.song && this.project.song.rows.length > 0;
      if (this.songPlaying) {
        const at = top ? { row: 0, bar: 0 } : rowOfBar(this.songRows, Math.min(this.stripStart, songBars(this.songRows) - 1));
        this.songRow = at.row;
        this.songStartBar = at.bar;
      }
      this.send({
        type: 'transport', playing: this.playing, song: this.songPlaying, fromRow: top ? 0 : this.songRow, fromBar: top ? 0 : this.songStartBar,
        fromChannel: this.selected, fromStep: top ? 0 : this.visiblePage(this.selected) * 16,
        // COUNT-IN: before live recording only.
        countIn: this.playing && this.mode === 'record' && !this.song ? this.setting('countIn') : 0, gen: ++this.transportGen,
      });
    } else if (id.startsWith('mode:')) {
      this.setMode(id.slice(5) as Mode);
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
      this.arpView = false;
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
        this.arpView = false;
        this.touchedKnob = -1;
      }
    } else if (id === 'stepedit') {
      this.toggleStepEdit();
    } else if (id === 'arp') {
      this.onArp();
    } else if (id === 'menu') {
      this.menu = { stack: [{ page: 'top', item: 0, pending: new Map() }] };
      this.touchedKnob = -1;
    } else if (id === 'cancel') {
      this.cancel();
    } else if (id === 'undo') {
      // UNDO; FUNC + UNDO = REDO.
      if (this.funcHeld) this.funcUsed = true; // not a latching tap
      this.undo(this.func);
    } else if (id === 'reset') {
      this.startReset();
    } else if (id === 'saveproject') {
      // SAVE PROJECT = name + slot; FUNC + SAVE PROJECT = load another (stopped only).
      if (this.funcHeld) this.funcUsed = true;
      this.openProjectMenu(this.func ? 'load' : 'save');
    } else if (id === 'slide' && this.forcing && isDrum(this.channel.instrument)) {
      // PLAY / DESIGN on a drum: ROLL held = the track repeats at ROLL RATE (while playing);
      // a tap (on release) = every note rolls, on / off.
      const c = this.channel;
      this.rollHeldAt = performance.now();
      this.rollHeldCh = this.selected;
      this.send({ type: 'holdRoll', channel: this.selected, on: true, note: c.instrument === 'none' ? 36 : INSTRUMENTS[c.instrument].baseNote });
    } else if ((id === 'ring' || id === 'slide' || id === 'dyn:accent' || id === 'dyn:ghost') && this.forcing) {
      this.toggleForce(id);
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
    } else if (id === 'len') {
      // STEPS: held for ◀ / ▶ (length), a tap (on release) = STEPS mode.
      this.lenHeld = true;
      this.lenUsed = false;
    } else if (id === 'speed') {
      // TIME: the selected track's pattern in normal -> double -> half -> triplet time.
      this.cycleSpeed();
    } else if (id === 'steppage') {
      // BAR: held for ◀ / ▶, a tap (on release) = the next bar.
      this.barHeld = true;
      this.barUsed = false;
    } else if ((id === 'oct-' || id === 'oct+') && this.func) {
      // FUNC + OCT ▼ / ▲ (any mode): the sound's OCTAVE, part of the patch (synths only).
      if (this.funcHeld) this.funcUsed = true; // not a latching tap
      if (!this.stepOctave(id === 'oct+' ? 1 : -1)) this.flash('NO OCTAVE');
    } else if (id === 'oct-' || id === 'oct+') {
      const o = this.octave[this.selected] + (id === 'oct+' ? 12 : -12);
      this.octave[this.selected] = Math.max(12, Math.min(96, o));
    } else if (id === 'scale') {
      this.scaleHeld = true;
      this.scaleUsed = false;
    } else if ((id === 'cur-' || id === 'cur+') && this.scaleHeld) {
      // SCALE + ◀ / ▶: the root a semitone down / up (the strip's keys follow).
      this.project.root = (this.root + (id === 'cur+' ? 1 : 11)) % 12;
      this.send({ type: 'setRoot', root: this.project.root });
      this.scaleUsed = true;
      this.flash(`SCALE: ${this.scaleName()}`);
      this.save();
    } else if ((id === 'cur-' || id === 'cur+') && this.barHeld) {
      // BAR + ◀ / ▶: the previous / next bar (16-step block) on the strip.
      this.changeBar(id === 'cur+' ? 1 : -1);
      this.barUsed = true;
    } else if ((id === 'cur-' || id === 'cur+') && this.stepsMode) {
      // STEPS mode: ◀ / ▶ = through the bars (strip taps switch steps on / off).
      this.changeBar(id === 'cur+' ? 1 : -1);
    } else if ((id === 'cur-' || id === 'cur+') && (this.stepEdit || this.autoSteps)) {
      // STEP EDIT / SONG RECORD: the primed step one on (not while knobs wait on it).
      this.stepPrime(id === 'cur+' ? 1 : -1);
    } else if ((id === 'cur-' || id === 'cur+') && this.entry) {
      // Holding a key: ▶ ties the note over one more step, ◀ shortens it.
      this.tie(id === 'cur+' ? 1 : -1);
    } else if (id === 'cur-' || id === 'cur+') {
      this.moveCursor(id === 'cur+' ? 1 : -1);
      this.previewCursor();
    } else if (id === 'view') {
      // STRIP: the selected track's strip shows keys / steps (every mode; held notes let go first).
      const ch = this.selected;
      this.leaveStepEdit();
      this.entry = null;
      this.stroke = null;
      this.restArm = false;
      this.stripFlip[ch] = !this.stripFlip[ch];
      this.flash(`${ch + 1} ${this.kindName(this.channel)}: ${this.stripSteps() ? 'STEPS' : 'KEYS'} ON THE STRIP`);
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

  /** PLAY / DESIGN: RING / SLIDE / ACCENT / GHOST = a live effect on the selected track's notes, tap on / tap off. */
  private toggleForce(id: string): void {
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
  }

  /** ROLL let go: the repeats stop; a short press was a tap (every note rolls, on / off). */
  private releaseRoll(): void {
    const ch = this.rollHeldCh;
    this.rollHeldCh = -1;
    this.send({ type: 'holdRoll', channel: ch, on: false, note: 36 });
    if (performance.now() - this.rollHeldAt < HOLD_TIMES[deviceSettings.holdTime].ms && ch === this.selected && this.forcing) this.toggleForce('slide');
    this.refreshPanel();
  }

  /**
   * ARP: on / off for the selected track; FUNC + ARP = its knobs on screen. With them open, ARP
   * (with FUNC or not) only goes back: on / off waits until the view is closed.
   */
  private onArp(): void {
    if (this.songGrid) return;
    const c = this.channel;
    if (this.arpView) {
      if (this.funcHeld) this.funcUsed = true;
      this.arpView = false;
      this.touchedKnob = -1;
      return;
    }
    if (this.func) {
      // FUNC + ARP: the ARP view; FUNC lets go (held or latched), the view has no FUNC layer.
      if (this.funcHeld) this.funcUsed = true; // not a latching tap
      this.funcLatched = false;
      this.arpView = true;
      this.fxView = 0;
      this.touchedKnob = -1;
      return;
    }
    const arp = (c.arp = { ...(c.arp ?? defaultArp()) });
    arp.on = !arp.on;
    this.send({ type: 'setArp', channel: this.selected, id: 'on', value: arp.on ? 1 : 0 });
    this.save();
    this.flash(!arp.on ? 'ARP OFF' : arp.mode === 0 ? 'ARP ON, MODE OFF' : `ARP ON: ${ARP_MODES[arp.mode]}`);
  }

  /** The ARP view: the selected track's ARP MODE / RATE / OCT. */
  private arpTargets(): (KnobTarget | null)[] {
    const ch = this.selected;
    const c = this.channel;
    const out: (KnobTarget | null)[] = new Array(KNOB_COUNT).fill(null);
    ARP_PARAMS.forEach((spec, i) => {
      const id = spec.id as ArpId;
      out[i] = {
        label: spec.name, spec, channel: ch, key: `${ch}:arp:${id}`, auto: { key: `a:${ch}:${id}` },
        get: () => (c.arp ?? defaultArp())[id],
        base: () => (this.savedChannel(ch)?.arp ?? defaultArp())[id],
        set: (v) => {
          c.arp = { ...(c.arp ?? defaultArp()), [id]: Math.round(v) };
          this.send({ type: 'setArp', channel: ch, id, value: Math.round(v) });
        },
      };
    });
    return out;
  }

  /**
   * RESET: every patch that was edited since its SAVE goes back to it, and every other
   * parameter that differs from the saved project (mix, FX, LFO) too, with the live knobs
   * centred: gliding (each on its own curve) to land on the next bar line; stopped, at
   * once. Tapped again soon after: unsaved notes too.
   */
  private startReset(): void {
    this.endAudition();
    const now = performance.now();
    // Track / FX 1-3 / LFO buttons held down: HOLD + RESET = KEEP HELD keeps them out of it,
    // RESET HELD resets only them. A held track takes along the FX / LFO knobs its live knobs
    // move. Their buttons no longer act on release (an FX press's view change is undone).
    const held = new Set(this.heldChannels);
    const heldKeys = new Set<string>();
    for (const n of this.heldBuses) {
      if (n === 4) for (const id of Object.keys(LFO_PARAMS)) heldKeys.add(`lfo:${id}`);
      else for (const t of this.sendTargets(n - 1)) if (t?.key) heldKeys.add(t.key);
    }
    for (const ch of held) {
      const c = this.project.channels[ch];
      for (const id of [...c.live, ...c.liveFunc]) {
        const fx = FX_LIVE.find((f) => f.id === id);
        if (fx) heldKeys.add(`bus:${fx.bus}:${fx.param}`);
        else if (id.startsWith('lfo:')) heldKeys.add(id);
      }
    }
    const anyHeld = held.size > 0 || this.heldBuses.size > 0;
    if (held.size > 0) this.heldUsed = true;
    if (this.heldBuses.size > 0) this.fxView = this.fxViewBefore;
    const only = anyHeld && this.setting('holdReset') === 1;
    // The tracks left alone, and whether a bus / LFO knob (by its key) is.
    const keep = new Set<number>();
    for (let ch = 0; ch < NUM_CHANNELS; ch++) if (only ? !held.has(ch) : held.has(ch)) keep.add(ch);
    const keepKey = (key: string) => (only ? !heldKeys.has(key) : heldKeys.has(key));
    const heldNames = [...[...held].sort().map((ch) => String(ch + 1)), ...[...this.heldBuses].sort().map((n) => (n === 4 ? 'LFO' : `FX${n}`))];
    const kept = !anyHeld ? '' : only ? ` (ONLY ${heldNames.join(' ')})` : ` (KEPT ${heldNames.join(' ')})`;
    if (now < this.resetAgainUntil) {
      this.resetAgainUntil = 0;
      this.resetNotes(keep, kept);
      return;
    }
    const saved = this.saved;
    const glides = new Map<string, Glide>();
    const add = (key: string, spec: ParamSpec, current: number, target: number, set: (v: number) => void) => {
      if (Math.abs(current - target) < 1e-9) return;
      glides.set(key, { spec, from: toNorm(spec, current), to: toNorm(spec, target), target, set });
    };
    // own = a track's own knob (decided by `keep`), else an FX / LFO knob (by keepKey).
    const fromTarget = (t: KnobTarget | null, target: number, own = false) => {
      if (t?.key && (own || !keepKey(t.key))) add(t.key, t.spec, t.get(), target, (v) => t.set(v));
    };
    this.project.channels.forEach((c, ch) => {
      const s = saved.channels[ch];
      if (!s || keep.has(ch)) return;
      for (const spec of MIX_PARAMS) {
        fromTarget(this.paramTarget(ch, MIX_PREFIX + spec.id), s[MIX_FIELD[spec.id as MixId]] ?? spec.defaultValue, true);
      }
      if (!isDrum(c.instrument)) {
        fromTarget(this.paramTarget(ch, 'track:chord'), Math.max(0, CHORD_KNOB.indexOf(s.chord)), true); // a place on the knob
        fromTarget(this.paramTarget(ch, 'track:notes'), s.notes - 1, true);
      }
      // Relative live knobs glide back to the centre (the sound as set).
      for (const id of Object.keys(c.liveOffset)) fromTarget(this.liveKnob(ch, id, false), 0, true);
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
    for (const gid of only ? [] : (['swing'] as const)) {
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
   * TIME: the selected track's pattern steps through normal, double, half and triplet time
   * (its steps last a 16th, a 32nd, an 8th or a triplet 16th). An unsaved edit of its notes,
   * like LENGTH.
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



  /** SONG strip: every track's clips (a copy: change it, then `setClips`). */
  private clips(): Clip[][] {
    return songClips(this.songRows, (ch, p) => patternBars(this.project.channels[ch], p));
  }

  /** SONG strip: the song becomes these clips (false = it would not fit: SONG FULL). */
  private setClips(clips: Clip[][]): boolean {
    const rows = clipRows(clips);
    if (!rows || songBars(rows) > STRIP_MAX_BARS) {
      this.flash('SONG FULL');
      return false;
    }
    this.project.song.rows = rows;
    this.songRow = Math.max(0, Math.min(this.songRow, rows.length - 1));
    this.songStartBar = 0;
    this.sendSong();
    return true;
  }

  /** SONG strip: pages of 16 bars, up to the one after the song's last bar. */
  private stripPages(): number {
    return Math.min(STRIP_MAX_BARS / 16, Math.floor(songBars(this.songRows) / 16) + 1);
  }

  /** SONG strip: show page n (PLAY starts from its first bar; the cursor goes there too). */
  private stripPage(n: number): void {
    this.songPage = Math.max(0, Math.min(STRIP_MAX_BARS / 16 - 1, n));
    this.stripStart = this.songPage * 16;
    if (Math.floor(this.stripBar / 16) !== this.songPage) this.stripBar = this.songPage * 16;
  }

  /** SONG strip: the cursor to bar `bar` (the page follows it). */
  private stripCursor(bar: number): void {
    this.stripBar = Math.max(0, Math.min(STRIP_MAX_BARS - 1, bar));
    if (Math.floor(this.stripBar / 16) !== this.songPage) this.stripPage(Math.floor(this.stripBar / 16));
  }

  private trackName(ch: number): string {
    return `${ch + 1} ${this.kindName(this.project.channels[ch])}`;
  }

  /**
   * SONG strip A-D: the pattern goes on the cursor's bar of the selected track, as long as it
   * plays (what it covers goes), and the cursor moves on past it, as notes in step entry.
   */
  private stripPattern(pattern: number): void {
    const ch = this.selected;
    const bars = patternBars(this.project.channels[ch], pattern);
    const at = this.stripBar;
    if (at + bars > STRIP_MAX_BARS) {
      this.flash('SONG FULL');
      return;
    }
    const clips = this.clips();
    clips[ch] = placeClip(clips[ch], { at, pattern, bars });
    if (!this.setClips(clips)) return;
    this.flash(`${this.trackName(ch)} ${PATTERN_NAMES[pattern]}: BAR ${at + 1}${bars > 1 ? `-${at + bars}` : ''}`);
    if (!this.stripEdit) this.stripCursor(at + bars);
  }

  /** SONG strip: CLEAR held + step = that bar's clip goes, + channel = the whole lane; COPY: not yet. */
  private stripHold(id: 'clear' | 'copy', pressed: boolean): void {
    if (id === 'copy') {
      if (pressed) this.flash('SONG STRIP: NO COPY YET');
      return;
    }
    if (pressed) {
      this.clearHeld = true;
      this.clearUsed = false;
      return;
    }
    this.clearHeld = false;
    if (!this.clearUsed) this.flash('HOLD CLEAR + STEP / TRACK');
  }

  /** SONG strip buttons; true when handled. */
  private onStripButton(id: string): boolean {
    let m: RegExpExecArray | null;
    const ch = this.selected;
    if (id === 'stepedit') {
      this.stripEdit = !this.stripEdit;
      const clip = clipAt(this.clips()[ch], this.stripBar);
      if (this.stripEdit && clip) this.stripBar = clip.at;
      this.flash(this.stripEdit ? 'STEP EDIT: ◀ ▶ = LENGTH' : 'STEP EDIT OFF');
    } else if ((id === 'cur-' || id === 'cur+') && this.barHeld) {
      this.stripPage(this.songPage + (id === 'cur+' ? 1 : -1));
      this.barUsed = true;
    } else if ((id === 'cur-' || id === 'cur+') && this.stripEdit) {
      // STEP EDIT: the cursor's clip a bar shorter / longer (at most its pattern's length).
      const d = id === 'cur+' ? 1 : -1;
      const clips = this.clips();
      const clip = clipAt(clips[ch], this.stripBar);
      if (!clip) { this.flash('NO PATTERN HERE'); return true; }
      const most = patternBars(this.project.channels[ch], clip.pattern);
      const bars = clip.bars + d;
      if (bars < 1) { this.flash('1 BAR AT LEAST'); return true; }
      if (bars > most) { this.flash(`${PATTERN_NAMES[clip.pattern]} LASTS ${most} BAR${most > 1 ? 'S' : ''}`); return true; }
      if (d > 0 && clipAt(clips[ch], clip.at + clip.bars)) { this.flash('NEXT PATTERN IN THE WAY'); return true; }
      if (d > 0 && clip.at + bars > STRIP_MAX_BARS) { this.flash('SONG FULL'); return true; }
      clip.bars = bars;
      if (this.setClips(clips)) this.flash(`${PATTERN_NAMES[clip.pattern]}: ${bars} OF ${most} BAR${most > 1 ? 'S' : ''}`);
    } else if (id === 'cur-' || id === 'cur+') {
      this.stripCursor(this.stripBar + (id === 'cur+' ? 1 : -1));
    } else if (id === 'oct-' || id === 'oct+') {
      // TRK ▼ / ▲: the next / previous track (the screen's lanes, top to bottom).
      this.selected = Math.max(0, Math.min(NUM_CHANNELS - 1, ch + (id === 'oct-' ? 1 : -1)));
    } else if (id === 'rest') {
      // REST: the cursor's bar is left empty (a clip from before ends there), the cursor moves on.
      const clips = this.clips();
      const clip = clipAt(clips[ch], this.stripBar);
      if (clip) {
        if (clip.at === this.stripBar) clips[ch] = clips[ch].filter((c) => c !== clip);
        else clip.bars = this.stripBar - clip.at;
        if (!this.setClips(clips)) return true;
      }
      this.stripCursor(this.stripBar + 1);
    } else if (id === 'steppage') {
      this.barHeld = true;
      this.barUsed = false;
    } else if ((m = /^step(\d+)$/.exec(id))) {
      const bar = this.songPage * 16 + Number(m[1]) - 1;
      if (this.clearHeld) {
        const clips = this.clips();
        const clip = clipAt(clips[ch], bar);
        this.clearUsed = true;
        if (!clip) return true;
        clips[ch] = clips[ch].filter((c) => c !== clip);
        if (this.setClips(clips)) this.flash(`${this.trackName(ch)}: ${PATTERN_NAMES[clip.pattern]} CLEARED`);
        return true;
      }
      const clip = this.stripEdit ? clipAt(this.clips()[ch], bar) : undefined;
      this.stripBar = clip ? clip.at : bar;
    } else if ((m = /^ch(\d)$/.exec(id))) {
      const t = Number(m[1]) - 1;
      this.heldTrack = -1;
      if (this.clearHeld) {
        const clips = this.clips();
        this.clearUsed = true;
        if (clips[t].length === 0) return true;
        clips[t] = [];
        if (this.setClips(clips)) this.flash(`${this.trackName(t)}: LANE CLEARED`);
        return true;
      }
      this.selected = t;
    } else if (id === 'ring' || id === 'dyn:accent' || id === 'dyn:ghost' || id === 'len' || id === 'speed') {
      this.flash('SONG: EDIT PATTERNS IN JAM');
    } else {
      return false;
    }
    if (this.stripEdit) {
      const clip = clipAt(this.clips()[this.selected], this.stripBar);
      if (clip) this.stripBar = clip.at;
    }
    return true;
  }

  /** SONG strip: the selected track's clips over the page's 16 bars (a clip = a note tied over its bars). */
  private updateStripFrame(): void {
    const lane = this.clips()[this.selected];
    const playing = this.songPlaying ? this.playingSongBar() : -1;
    const cur = this.stripEdit ? clipAt(lane, this.stripBar) : undefined;
    const end = songBars(this.songRows);
    for (let i = 0; i < STEP_BUTTONS; i++) {
      const id = `step${i + 1}`;
      const bar = this.songPage * 16 + i;
      const clip = clipAt(lane, bar);
      const start = !!clip && clip.at === bar;
      this.panel.setButtonText(id, start ? `${bar + 1}<small>${PATTERN_NAMES[clip.pattern]}</small>` : String(bar + 1));
      this.panel.setButtonFlag(id, 'lit', start);
      this.panel.setButtonFlag(id, 'tie', !!clip && !start);
      this.panel.setButtonFlag(id, 'head', bar === playing);
      this.panel.setButtonFlag(id, 'cursor', cur ? bar >= cur.at && bar < cur.at + cur.bars : bar === this.stripBar);
      this.panel.setButtonFlag(id, 'off', bar >= end && !clip && bar !== this.stripBar);
      for (const f of ['note', 'black', 'accent', 'ghost', 'ring', 'rest', 'skip']) this.panel.setButtonFlag(id, f, false);
      this.panel.setLed(i, bar === playing ? 'on' : bar === this.stripBar ? 'cursor' : '');
    }
    const first = this.songPage * 16 + 1;
    this.panel.setButtonText('steppage', `BAR<small>${first}-${first + 15}</small>`);
    const at = clipAt(lane, this.stripBar);
    PATTERN_NAMES.forEach((name, p) => {
      this.panel.setButtonFlag(`pat${name}`, 'lit', at?.pattern === p);
      this.panel.setButtonFlag(`pat${name}`, 'playing', false);
      this.panel.setButtonFlag(`pat${name}`, 'dirty', false);
    });
  }

  /** The song bar playing (0 = the first), -1 when the song is not playing. */
  private playingSongBar(): number {
    const row = this.status?.songRow ?? -1;
    return row < 0 ? -1 : this.songBarNumber(row, Math.max(0, this.status?.songBar ?? 0)) - 1;
  }







  /** Bar `bar` of row `row` counted from the song's first bar (1 = the first). */
  private songBarNumber(row: number, bar: number): number {
    let n = 1 + bar;
    for (let r = 0; r < row; r++) n += this.songRows[r]?.bars ?? 0;
    return n;
  }



  /**
   * Switch a track's pattern, with its patch (stopped: at once; playing: at its loop end, in
   * every mode, the sound gliding there). The chosen pattern is the one edited.
   */
  private selectPattern(ch: number, pattern: number, flash = true): void {
    const c = this.project.channels[ch];
    editPattern(c, pattern);
    if (ch === this.selected) {
      this.clampCursor();
      this.entry = null;
    }
    this.send({ type: 'selectPattern', channel: ch, pattern, immediate: false });
    if (flash) this.flash(`${ch + 1} ${this.kindName(c)} PAT ${PATTERN_NAMES[pattern]}`);
    this.save();
  }

  /** Unsaved edits on a pattern (notes or patch): marked * on the screen. */
  private dirty(c: ChannelState, p = c.activePattern): boolean {
    const pat = c.patterns[p];
    return !!pat.notesDirty || !!pat.patchDirty;
  }

  private velocity(): number {
    const d = this.forcing ? this.forceDyn[this.selected] : this.dynamic;
    return DYNAMIC_VELOCITY[d];
  }

  private onStrip(button: number): void {
    if (this.autoSteps) {
      this.autoStripTap(button);
      return;
    }
    if (this.stepEdit) {
      this.stepEditTap(button);
      return;
    }
    const ch = this.selected;
    this.stripDown.add(button);
    if (this.clearHeld && this.song) {
      this.clearUsed = true;
      this.flash(SONG_KEEPS);
      return;
    }
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
      const note = this.keyNote(ch, button);
      const vel = this.velocity();
      // Played legato (a key still held), BASS / LEAD and chord-mode PAD / PLUCK slide into the new note.
      let heldNote = -1;
      for (const n of this.heldNotes.values()) heldNote = n;
      const legato = heldNote >= 0 && this.isMono(this.channel);
      // PAD / PLUCK, CHORD OFF: keys played together make one step's chord (live recording, step entry).
      const chord = heldNote >= 0 && this.stepChords(this.channel);
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
          // PAD / PLUCK: the key joins the step being entered, as long as the notes entered with it.
          const step = this.pattern.steps[this.entry.index];
          const notes = stepNotes(step);
          if (!notes.some((n) => n.note === note)) {
            const gate = notes.find((n) => n.note === this.entry!.notes?.[0])?.gate ?? 1;
            this.makeRoom(this.entry.index, note);
            setStepNotes(step, [...stepNotes(step), { note, gate }]);
            this.entry.notes = [...(this.entry.notes ?? []), note];
            this.sendStep(this.entry.index, step);
            this.save();
          }
          this.entry.chord = true;
          this.send({ type: 'trigger', channel: ch, note, velocity: vel });
          return;
        }
        if (!this.entry && this.stepChords(this.channel) && this.pattern.steps[this.cursor[ch]].active) {
          this.addChordNote(this.cursor[ch], note, button, vel);
          return;
        }
        let index = this.cursor[ch];
        if (this.entry && this.entry.button !== button) {
          index = (this.entry.index + this.entryLength()) % this.pattern.length; // wraps past the end
        }
        // PAD / PLUCK: notes tied over from earlier steps stay (six sound at most).
        if (this.stepChords(this.channel)) this.makeRoom(index, note);
        const step = this.pattern.steps[index];
        step.active = true;
        step.note = note;
        step.gate = 1;
        step.ring = this.ring;
        step.rest = false;
        step.slide = this.slideArm; // ROLL on PERC
        delete step.extra;
        delete step.extraGate;
        setStepDynamic(step, this.dynamic);
        this.sendStep(index, step);
        this.send({ type: 'trigger', channel: ch, note, velocity: vel });
        this.entry = { button, index, notes: [note] };
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
    if (!stepsOnStrip(this.channel.instrument)) this.paintNote(index, this.stroke.kind);
    if (this.paintDrumStep(step, this.stroke.kind) && !this.playing) {
      this.send({ type: 'trigger', channel: ch, note: step.note, velocity: step.velocity });
    }
    this.sendStep(index, step);
    this.save();
  }

  /**
   * A keyboard track's strip showing steps (STRIP): a painted step gets a one-step note on
   * the strip keyboard's lowest key (SCALE's root in the track's octave), and a note tied over
   * it ends there; an erased one loses its chord notes too.
   */
  private paintNote(index: number, kind: StrokeKind): void {
    const pat = this.pattern;
    const step = pat.steps[index];
    if (kind === 'erase' || kind === 'rest-on' || kind === 'rest-off') {
      delete step.extra;
      delete step.extraGate;
      return;
    }
    if (kind !== 'add' || step.active) return;
    const len = pat.length;
    for (let d = 1; d < len; d++) {
      const j = (index - d + len) % len;
      const s = pat.steps[j];
      if (!s.active) continue;
      if (s.gate > d || (s.extraGate ?? []).some((g) => g > d)) {
        s.gate = Math.min(s.gate, d);
        if (s.extraGate) s.extraGate = s.extraGate.map((g) => Math.min(g, d));
        this.sendStep(j, s);
      }
    }
    step.note = this.keyNote(this.selected, 0);
    step.gate = 1;
    delete step.extra;
    delete step.extraGate;
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
    return this.mode === 'record' && !this.stripSteps();
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

  /** RECORD / PLAY / DESIGN (the mode buttons; in SONG they work on the song). */
  private setMode(mode: Mode): void {
    this.leaveStepEdit();
    this.unprime();
    this.endAudition();
    this.dropCopyBar();
    this.mode = mode;
    this.playPage = 0; // PLAY always opens on SOUND (the live knobs)
    if (this.mode !== 'record' && this.mode !== 'play') this.stepsMode = false;
    // RING / SLIDE belong to their mode: placing in RECORD, the all-notes effect in PLAY and
    // DESIGN (kept going between those two).
    if (this.mode !== 'record') { this.ring = false; this.slideArm = false; this.dynamic = 'normal'; }
    if (!this.forcing) {
      for (let ch = 0; ch < NUM_CHANNELS; ch++) {
        if (this.forceRing[ch] || this.forceSlide[ch] || this.forceDyn[ch] !== 'normal') this.setForce(ch, false, false, 'normal');
      }
    }
    this.touchedKnob = -1;
  }

  /** MENU > MODE: SONG (opens on RECORD, the grid) or JAM (the patterns, the mode kept). */
  private setSong(on: boolean): void {
    if (on === this.song) return;
    this.song = on;
    if (on) {
      // Pattern-editing strip modes stay in JAM.
      this.stepsMode = false;
      this.restArm = false;
      this.ring = false;
      this.slideArm = false;
      this.dynamic = 'normal';
      this.setMode('play');
      if (this.project.song.rows.length === 0) {
        // A first row from what the tracks play now.
        this.project.song.rows.push({ bars: 4, patterns: this.project.channels.map((c) => c.activePattern) });
        this.sendSong();
      }
    } else this.setMode('play');
  }

  /** PLAY: every note on a track as RING / SLIDE (ROLL) / ACCENT / GHOST notes, or back. */
  /** The strip shows the bar playing: PLAY, DESIGN and live recording (RECORD while playing; not in STEP EDIT, which keeps its primed bar). */
  private get followsPlayhead(): boolean {
    return this.playing && !this.copyBar && !this.stepEdit && (this.mode === 'play' || this.mode === 'design' || this.recording);
  }

  /**
   * STOP: every track keeps the bar it was playing (top = back to bar 1), so the next PLAY
   * carries on from there; step entry's cursor moves into that bar.
   */
  private keepBars(top: boolean): void {
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const c = this.project.channels[ch];
      const head = this.status?.steps[ch] ?? -1;
      const heard = this.status?.patterns[ch] ?? c.activePattern;
      if (!top && (head < 0 || heard !== c.activePattern)) continue;
      const page = top ? 0 : Math.floor(head / 16);
      this.viewPage[ch] = page;
      this.cursor[ch] = Math.min(page * 16 + (this.cursor[ch] % 16), c.patterns[c.activePattern].length - 1);
    }
  }

  /** PLAY and DESIGN: RING / SLIDE / ACCENT / GHOST make every note on the track play that way. */
  private get forcing(): boolean {
    return this.mode === 'play' || this.mode === 'design';
  }

  private setForce(ch: number, ring: boolean, slide: boolean, dyn: Dynamic): void {
    this.forceRing[ch] = ring;
    this.forceSlide[ch] = slide;
    this.forceDyn[ch] = dyn;
    this.send({ type: 'setForce', channel: ch, ring, slide, velocity: dyn === 'normal' ? 0 : DYNAMIC_VELOCITY[dyn] });
  }

  /** Hits per step of a ROLL-flagged drum step on this channel: ROLL RATE (per 16th) x the pattern's step length. */
  private rollHits(c: ChannelState): number {
    const v = c.instrument === 'none' ? DEFAULT_ROLL_RATE : c.sounds[c.instrument]?.rolldiv ?? DEFAULT_ROLL_RATE;
    return Math.max(1, Math.round((ROLL_DIVS[Math.round(v)]?.hits ?? 1) * speedSteps(c.patterns[c.activePattern].speed)));
  }

  /** The SLIDE button's job on this track: ROLL on drums. */
  private get slideName(): string {
    return isDrum(this.channel.instrument) ? 'ROLL' : 'SLIDE';
  }

  /**
   * One chord root at a time, played legato into slides: BASS, LEAD, and PAD / PLUCK with a
   * CHORD on (each key plays the chord on it, so held keys slide chord to chord).
   */
  private isMono(c: ChannelState): boolean {
    return c.instrument === 'bass' || c.instrument === 'lead' || (playsChords(c.instrument) && c.chord !== 0);
  }

  /** PAD / PLUCK with CHORD OFF: keys held together go on one step, each note its own length. */
  private stepChords(c: ChannelState): boolean {
    return playsChords(c.instrument) && c.chord === 0;
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
    delete step.extraGate;
    this.sendStep(index, step);
    this.clearUsed = true;
    this.save();
  }

  /**
   * COPY: a pattern's notes (length, speed, steps and flags; never its patch) onto another
   * track's / pattern slot, of any type. Onto KICK, SNARE and HAT the pitches do not carry
   * over (their hits play as designed); a drum's hits onto a pitched track land on its base
   * note; a chord onto a one-note track keeps its lowest note. Locks only go to a track of
   * the same type. The copy is an unsaved edit there.
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
    // A drum's hits onto a pitched track land on its keyboard's base note.
    const fromDrum = from.instrument !== 'none' && stepsOnStrip(from.instrument) && !plainDrum;
    const base = to.instrument === 'none' ? 36 : INSTRUMENTS[to.instrument].baseNote;
    dst.length = src.length;
    this.send({ type: 'setPatternLength', channel: toCh, pattern: toPat, length: dst.length });
    if (src.speed && src.speed !== 'normal') dst.speed = src.speed;
    else delete dst.speed;
    this.send({ type: 'setPatternSpeed', channel: toCh, pattern: toPat, speed: dst.speed ?? 'normal' });
    src.steps.forEach((s, i) => {
      const step: Step = JSON.parse(JSON.stringify(s));
      if (plainDrum) step.note = emptyStep().note; // a drum's own pitch (as designed)
      else if (fromDrum) step.note = base;
      if (from.instrument !== to.instrument) dropSoundLocks(step, fromCh);
      // One note at a time: the chord's lowest, as a CHORD plays it.
      if (!playsChords(to.instrument)) lowestNoteOnly(step);
      dst.steps[i] = step;
      this.send({ type: 'setStep', channel: toCh, pattern: toPat, index: i, step });
    });
    dst.notesDirty = true;
    // Only the notes: the pattern keeps its own sound.
    this.copyUsed = true;
    this.flash(`COPIED ${fromCh + 1} ${PATTERN_NAMES[fromPat]} > ${toCh + 1} ${PATTERN_NAMES[toPat]}`);
    this.relabel(`COPY > ${this.kindName(to)} ${PATTERN_NAMES[toPat]}`);
    this.save();
  }

  // ---------------------------------------------------------------- COPY BAR

  /** COPY held + BAR: the bar the strip shows is the one to copy; ◀ ▶ pick where to. */
  private startCopyBar(): void {
    const bar = this.visiblePage(this.selected);
    this.copyBar = { from: bar, to: bar, length: this.pattern.length, saved: new Map() };
    this.flash(`COPY BAR ${bar + 1}: < > TO, COPY = PASTE`);
  }

  /**
   * ◀ ▶ in COPY BAR: the target bar. Past the pattern's last bar it grows by empty bars (up to
   * 8); going back takes them away again (the steps they covered as they were).
   */
  private moveCopyBar(d: number): void {
    const cb = this.copyBar!;
    const to = cb.to + d;
    if (to < 0) return;
    if (to >= MAX_STEPS / 16) {
      this.flash('PATTERN FULL (8 BARS)');
      return;
    }
    this.fitCopyBar(to >= Math.ceil(cb.length / 16) ? (to + 1) * 16 : cb.length);
    cb.to = to;
    this.viewPage[this.selected] = to;
  }

  /** The pattern at this length for COPY BAR: steps it grows over start empty, those it gives back are as they were. */
  private fitCopyBar(length: number): void {
    const cb = this.copyBar!;
    const pat = this.pattern;
    if (length > pat.length) {
      for (let i = pat.length; i < length; i++) {
        if (!cb.saved.has(i)) cb.saved.set(i, pat.steps[i]);
        pat.steps[i] = emptyStep(pat.steps[0]?.note ?? 36);
        this.sendStep(i, pat.steps[i]);
      }
    } else {
      for (let i = length; i < pat.length; i++) {
        const was = cb.saved.get(i);
        if (!was) continue;
        pat.steps[i] = was;
        cb.saved.delete(i);
        this.sendStep(i, was);
      }
    }
    if (length !== pat.length) this.setLength(this.selected, length);
  }

  /** COPY again: the target bar becomes the copied one, all 16 steps (empty and switched-off ones too). */
  private pasteBar(): void {
    const cb = this.copyBar!;
    const pat = this.pattern;
    if (cb.to === cb.from) {
      this.flash('PICK ANOTHER BAR');
      this.dropCopyBar();
      return;
    }
    this.copyBar = null;
    const src = Array.from({ length: 16 }, (_, i) => {
      const at = cb.from * 16 + i;
      // Beyond the pattern's end a step is empty.
      return at < pat.length ? (JSON.parse(JSON.stringify(pat.steps[at])) as Step) : emptyStep(pat.steps[0]?.note ?? 36);
    });
    src.forEach((step, i) => {
      const at = cb.to * 16 + i;
      pat.steps[at] = step;
      this.sendStep(at, step);
    });
    if (pat.length < (cb.to + 1) * 16) this.setLength(this.selected, (cb.to + 1) * 16);
    pat.notesDirty = true;
    this.viewPage[this.selected] = cb.to;
    this.save();
    this.flash(`COPIED BAR ${cb.from + 1} > ${cb.to + 1}`);
    this.relabel(`COPY BAR ${cb.from + 1} > ${cb.to + 1}`);
  }

  /** Leave COPY BAR without pasting: bars added for it go again. */
  private dropCopyBar(): void {
    if (!this.copyBar) return;
    this.fitCopyBar(this.copyBar.length);
    this.copyBar = null;
    this.clampCursor();
  }

  /** A track's (edited) pattern length, here and in the engine. */
  private setLength(ch: number, length: number): void {
    const c = this.project.channels[ch];
    c.patterns[c.activePattern].length = length;
    c.patterns[c.activePattern].notesDirty = true;
    this.send({ type: 'setPatternLength', channel: ch, pattern: c.activePattern, length });
  }

  /** CLEAR + channel / A-D: empty a track's pattern (its sound stays). */
  private clearTrack(ch: number, p = this.project.channels[ch].activePattern): void {
    const c = this.project.channels[ch];
    const pat = c.patterns[p];
    pat.steps.forEach((step, i) => {
      if (!step.active && !step.rest && !step.locks) return;
      step.active = false;
      step.ring = false;
      step.rest = false;
      step.slide = false;
      step.gate = 1;
      delete step.locks;
      delete step.extra;
      delete step.extraGate;
      pat.notesDirty = true;
      this.send({ type: 'setStep', channel: ch, pattern: p, index: i, step });
    });
    this.clearUsed = true;
    this.flash(`CLEARED ${ch + 1} ${this.kindName(c)} ${PATTERN_NAMES[p]}`);
    this.relabel(`CLEAR ${this.kindName(c)} ${PATTERN_NAMES[p]}`);
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
    // The cursor moves on when the entered key is up (a PAD / PLUCK chord: when all its keys are).
    if (this.entry && (this.entry.chord ? this.heldNotes.size === 0 : this.entry.button === button)) {
      const len = this.pattern.length;
      this.cursor[this.selected] = (this.entry.index + this.entryLength()) % len;
      if (!this.plays(this.cursor[this.selected])) this.moveCursor(1); // past dark steps
      this.entry = null;
      this.refreshPanel();
    }
  }

  /**
   * PAD / PLUCK step entry on a step that already has notes: the key joins them as a note of its own
   * (one step long; hold + ▶ ties it on, the others keep their lengths), or, already there,
   * comes back out (the last one out empties the step).
   */
  private addChordNote(index: number, note: number, button: number, vel: number): void {
    const step = this.pattern.steps[index];
    const notes = stepNotes(step);
    if (notes.some((n) => n.note === note)) {
      const rest = notes.filter((n) => n.note !== note);
      setStepNotes(step, rest);
      this.heldNotes.delete(button); // nothing sounds for this key: its release is a no-op
      this.flash(rest.length ? `${noteName(note)} OUT OF THE STEP` : 'STEP CLEARED');
    } else {
      this.makeRoom(index, note);
      setStepNotes(step, [...stepNotes(step), { note, gate: 1 }]);
      this.entry = { button, index, notes: [note] };
      this.send({ type: 'trigger', channel: this.selected, note, velocity: vel });
    }
    this.sendStep(index, step);
    this.save();
  }

  /**
   * PAD / PLUCK: at most STEP_NOTES notes sound at any step. Before `note` starts (or reaches) step
   * `at`, if six already sound there, the one that started earliest goes (several started
   * together: the one nearest in pitch to the new note). `keep` = the note being tied on,
   * not counted.
   */
  private makeRoom(at: number, note: number, keep?: { index: number; note: number }): void {
    const sounding = soundingAt(this.pattern.steps, this.pattern.length, at)
      .filter((n) => !(keep && keep.index === n.index && keep.note === n.note));
    if (sounding.length < STEP_NOTES) return;
    sounding.sort((a, b) => b.back - a.back || Math.abs(a.note - note) - Math.abs(b.note - note));
    const out = sounding[0];
    const step = this.pattern.steps[out.index];
    setStepNotes(step, stepNotes(step).filter((n) => n.note !== out.note));
    this.sendStep(out.index, step);
    this.flash(`6 NOTES: ${noteName(out.note)} REPLACED`);
  }

  /** How long the note being entered is (PAD / PLUCK: its own length), in steps. */
  private entryLength(): number {
    const step = this.pattern.steps[this.entry!.index];
    if (!this.stepChords(this.channel)) return step.gate;
    const notes = stepNotes(step).filter((n) => this.entry!.notes?.includes(n.note));
    return notes.length ? Math.max(...notes.map((n) => n.gate)) : step.gate;
  }

  /**
   * Lengthen (+1) or shorten (-1) the note being entered. Tied-over steps are cleared; on
   * PAD / PLUCK each note ties on its own and the others stay (six sound at most).
   */
  private tie(delta: number): void {
    if (!this.entry) return;
    const { index } = this.entry;
    const len = this.pattern.length;
    const step = this.pattern.steps[index];
    if (this.stepChords(this.channel)) {
      const notes = stepNotes(step);
      let changed = false;
      for (const n of notes) {
        if (!this.entry.notes?.includes(n.note)) continue;
        // Up to the whole loop: a tie can run past the end and on from the start.
        const gate = Math.max(1, Math.min(len, n.gate + delta));
        if (gate === n.gate) continue;
        if (delta > 0) this.makeRoom((index + gate - 1) % len, n.note, { index, note: n.note });
        n.gate = gate;
        changed = true;
      }
      if (!changed) return;
      // makeRoom may have taken a note off this very step: keep the others as they are now.
      const now = stepNotes(step);
      setStepNotes(step, now.map((m) => notes.find((n) => n.note === m.note) ?? m));
      this.sendStep(index, step);
      this.save();
      return;
    }
    // Up to the whole loop: a tie can run past the end and on from the start.
    const gate = Math.max(1, Math.min(len, step.gate + delta));
    if (gate === step.gate) return;
    step.gate = gate;
    if (delta > 0) {
      const at = (index + gate - 1) % len;
      const covered = this.pattern.steps[at];
      if (covered.active || covered.locks || covered.rest) {
        // A rest left under the tie would cut a RING / SLIDE note short: it goes too.
        covered.active = false;
        covered.rest = false;
        delete covered.locks;
        this.sendStep(at, covered);
      }
    }
    this.sendStep(index, step);
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
  /** BAR: the previous / next bar on the strip; BAR + ▶ on the last bar (grow) adds an empty one. */
  private changeBar(delta: number): void {
    if (this.waiting) {
      this.flash('LOCK OR CANCEL FIRST');
      return;
    }
    if (this.songRecord) {
      this.gotoSongBar(this.songBarNumber(this.songRow, this.songStartBar) - 1 + delta);
      return;
    }
    const ch = this.selected;
    if (this.followsPlayhead && !this.stepsMode) {
      this.flash('THE STRIP FOLLOWS THE PLAYHEAD');
      return;
    }
    const pages = this.pageCount();
    if (pages <= 1) {
      this.flash('1 BAR: STEPS + TRACK 2 ADDS ONE');
      return;
    }
    const page = (this.visiblePage(ch) + delta + pages) % pages;
    if (this.stepEdit && this.primed) {
      this.movePrime(Math.min(this.pattern.length - 1, page * 16 + (this.primed.cell % 16)));
      this.flash(`BAR ${page + 1}/${pages}`);
      return;
    }
    this.viewPage[ch] = page;
    if (!this.stripSteps() && this.mode === 'record' && !this.entry) {
      this.cursor[ch] = page * 16 + (this.cursor[ch] % 16);
    }
    this.flash(`BAR ${page + 1}/${pages}`);
  }

  /**
   * STEPS mode, a track button = that bar of the pattern (lit = it has it): an unlit one grows
   * the pattern up to it with empty bars, a lit one takes that bar out (the bars after it move
   * up; one bar stays). Bar 8 at most (128 steps).
   */
  private toggleBar(bar: number): void {
    if (this.song) {
      this.flash(SONG_KEEPS);
      return;
    }
    const ch = this.selected;
    const pat = this.pattern;
    const len = pat.length;
    const bars = Math.ceil(len / 16);
    if (bar >= bars) {
      const to = (bar + 1) * 16;
      // Whatever an earlier length left past the end goes.
      for (let i = len; i < to; i++) {
        const step = pat.steps[i];
        if (step.active || step.rest || step.locks || step.flip) {
          pat.steps[i] = emptyStep(step.note);
          this.sendStep(i, pat.steps[i]);
        }
      }
      this.setLength(ch, to);
      this.flash(`${bar + 1} BARS (${to} STEPS)`);
    } else {
      if (bars === 1) {
        this.flash('1 BAR AT LEAST');
        return;
      }
      const from = bar * 16;
      const n = Math.min(16, len - from);
      for (let i = from; i < len; i++) {
        pat.steps[i] = i + n < len ? pat.steps[i + n] : emptyStep(pat.steps[i].note);
        this.sendStep(i, pat.steps[i]);
      }
      this.setLength(ch, len - n);
      this.flash(`BAR ${bar + 1} TAKEN OUT (${len - n} STEPS)`);
    }
    if (this.viewPage[ch] >= this.pageCount()) this.viewPage[ch] = this.pageCount() - 1;
    this.clampCursor();
    this.save();
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
   * one 0-127 step, one option for discrete choices, 1 BPM for TEMPO.
   */
  private onEncoder(id: string, delta: number): void {
    const gid = MASTER_GLOBAL[id];
    if (gid) {
      const spec = GLOBAL_PARAMS.find((p) => p.id === gid) as ParamSpec;
      const step = gid === 'bpm' ? 1 : 1 / 127;
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
      if (!this.funcUsed && performance.now() - this.funcDownAt < HOLD_TIMES[deviceSettings.holdTime].ms) this.funcLatched = !this.funcLatched;
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
    if (!(this.song && t.patch)) this.save(); // a SONG audition is not kept
    // Discrete choices can change what other knobs mean (type, preset, live assignment).
    if (t.spec.options) this.refreshPanel();
  }

  private save(): void {
    this.edited = true;
    mirrorToCloud(this.project);
    saveWorkSoon(this.project, () => this.flash('STORAGE FULL: NOT KEPT'));
  }

  // ---------------------------------------------------------------- projects

  private openProjectMenu(kind: 'save' | 'load'): void {
    if (this.playing) {
      this.flash(kind === 'save' ? 'STOP TO SAVE' : 'STOP TO LOAD');
      return;
    }
    this.endAudition();
    void syncSlots(); // the slots as saved on other devices too (claude.ai)
    this.funcLatched = false;
    const slots = projectStore.slots();
    const openId = projectStore.openId();
    const at = slots.findIndex((e) => !!e && e.id === openId);
    const name = (at >= 0 ? slots[at]!.name : 'PROJECT').slice(0, NAME_LENGTH);
    this.projMenu = { kind, bank: Math.floor((at >= 0 ? at : Math.max(0, this.newSlot)) / SLOTS_PER_BANK), name: [...name], cursor: Math.min(name.length, NAME_LENGTH - 1), confirm: -1, knobs: [0, 0, 0, 0] };
    this.touchedKnob = -1;
  }

  private closeProjectMenu(): void {
    this.projMenu = null;
    this.barHeld = false;
  }

  // ---------------------------------------------------------------- MENU, CANCEL

  private get menuPage(): MainMenu['stack'][number] {
    const st = this.menu!.stack;
    return st[st.length - 1];
  }

  private openPage(page: MenuPage): void {
    this.menu!.stack.push({ page, item: 0, pending: new Map() });
  }

  /** MENU back one page (from the top: closed); the page's unsaved changes are dropped. */
  private menuBack(): void {
    const menu = this.menu!;
    menu.stack.pop();
    if (menu.stack.length === 0) this.menu = null;
  }

  /** PLAY in MENU: save the page's changed settings, then back one page. */
  private menuSave(): void {
    const at = this.menuPage;
    const lines = this.menuLines(at.page);
    for (const [i, value] of at.pending) lines[i]?.set?.(value);
    if (at.pending.size > 0) this.flash('SAVED');
    this.menuBack();
  }

  /** A line's setting as shown: changed (not saved yet) or as saved. */
  private menuValue(line: MenuLine, i: number): number {
    return this.menuPage.pending.get(i) ?? line.get!();
  }

  /** Change a line's setting on screen (saved by PLAY); back to the saved value = no change. */
  private menuPick(line: MenuLine, i: number, value: number): void {
    const pending = this.menuPage.pending;
    const v = Math.max(0, Math.min(line.options!.length - 1, value));
    if (v === line.get!()) pending.delete(i);
    else pending.set(i, v);
  }

  /** The lines of a MENU page. */
  private menuLines(page: MenuPage): MenuLine[] {
    if (page === 'top') {
      return [
        {
          label: 'MODE', options: ['JAM', 'SONG'],
          get: () => (this.song ? 1 : 0),
          set: (i) => this.setSong(i === 1),
        },
        { label: 'PROJECT SETTINGS', open: () => this.openPage('project') },
        { label: 'GLOBAL SETTINGS', open: () => this.openPage('global') },
      ];
    }
    if (page === 'project') {
      // The project's own GLOBAL settings: DEFAULT = whatever GLOBAL SETTINGS say.
      const own = (label: string, key: SettingKey, options: readonly string[]): MenuLine => ({
        label, options: ['DEFAULT', ...options],
        get: () => (this.project.settings?.[key] ?? -1) + 1,
        set: (i) => {
          const s = (this.project.settings ??= {});
          if (i === 0) delete s[key];
          else s[key] = i - 1;
          this.save();
        },
      });
      return [
        { label: 'TRACKS', open: () => this.openPage('tracks') },
        own('COUNT-IN', 'countIn', COUNT_INS),
        own('METRONOME', 'metronome', METRONOMES),
        own('CLICK LEVEL', 'clickLevel', CLICK_LEVELS.map((v) => `${v} %`)),
        own('HOLD + RESET', 'holdReset', HOLD_RESETS),
        own('HOLD + PATTERN', 'holdPattern', HOLD_PATTERNS),
      ];
    }
    // GLOBAL / TOUCH SETTINGS are kept on this device (storage/settings.ts), not in the project.
    const device = (label: string, key: keyof typeof deviceSettings, options: readonly string[]): MenuLine => ({
      label, options,
      get: () => deviceSettings[key],
      set: (i) => { deviceSettings[key] = i; saveDeviceSettings(); },
    });
    if (page === 'global') {
      return [
        device('COUNT-IN', 'countIn', COUNT_INS),
        device('METRONOME', 'metronome', METRONOMES),
        device('CLICK LEVEL', 'clickLevel', CLICK_LEVELS.map((v) => `${v} %`)),
        device('HOLD + RESET', 'holdReset', HOLD_RESETS),
        device('HOLD + PATTERN', 'holdPattern', HOLD_PATTERNS),
        { label: 'TOUCH SETTINGS', open: () => this.openPage('touch') },
      ];
    }
    if (page === 'touch') {
      return [
        device('KNOB SPEED', 'knobSpeed', KNOB_SPEEDS.map((k) => k.name)),
        device('KNOB ACCEL', 'knobAccel', ['OFF', 'ON']),
        device('TOUCH DELAY', 'touchDelay', TOUCH_DELAYS.map((ms) => `${ms} MS`)),
        device('HOLD TIME', 'holdTime', HOLD_TIMES.map((h) => h.name)),
        device('KEEP SCREEN ON', 'screenOn', ['PLAYING', 'ALWAYS']),
      ];
    }
    return this.project.channels.map((c, ch) => ({
      label: `TRACK ${ch + 1}`,
      options: TRACK_KINDS.map((k) => (k === 'none' ? 'OFF' : INSTRUMENTS[k].name)),
      get: () => TRACK_KINDS.indexOf(c.instrument),
      set: (i) => this.setTrackType(ch, TRACK_KINDS[i]),
    }));
  }

  /**
   * A button while MENU is open. ▼ / ▲ (the OCT keys) move; ◀ ▶ change a setting on screen,
   * ▶ opens a page; a strip key goes to its line (and opens a page); PLAY saves the page's
   * changes and goes back a page, CANCEL (◀ on a page line) goes back without saving; MENU
   * closes it, a mode button closes it and goes there (neither saves). True = handled here.
   */
  private onMenu(id: string, pressed: boolean): boolean {
    if (id.startsWith('mode:')) {
      if (pressed) this.menu = null;
      return false;
    }
    if (!pressed) return true;
    const at = this.menuPage;
    const lines = this.menuLines(at.page);
    const line = lines[at.item];
    let m: RegExpExecArray | null;
    if (id === 'oct-' || id === 'oct+') {
      at.item = Math.max(0, Math.min(lines.length - 1, at.item + (id === 'oct-' ? 1 : -1)));
    } else if ((id === 'cur-' || id === 'cur+') && line.options) {
      this.menuPick(line, at.item, this.menuValue(line, at.item) + (id === 'cur+' ? 1 : -1));
    } else if (id === 'cur+') {
      line.open?.();
    } else if ((m = /^step(\d+)$/.exec(id)) && Number(m[1]) <= lines.length) {
      at.item = Number(m[1]) - 1; // to the line only: ▶ opens it
    } else if (id === 'play') {
      this.menuSave();
    } else if (id === 'cancel') {
      this.menuBack();
    } else if (id === 'menu') {
      this.menu = null;
    }
    return true;
  }

  /** MENU: knob 1 = the setting on the cursor's line. */
  private menuTargets(): (KnobTarget | null)[] {
    const out: (KnobTarget | null)[] = new Array(KNOB_COUNT).fill(null);
    const at = this.menuPage;
    const line = this.menuLines(at.page)[at.item];
    if (line?.options) {
      out[0] = {
        label: line.label, spec: choice('menu', line.label, line.options), channel: this.selected,
        get: () => this.menuValue(line, at.item),
        base: () => line.get!(), // a change not saved with PLAY yet shows yellow
        set: (v) => this.menuPick(line, at.item, Math.round(v)),
      };
    }
    return out;
  }

  /**
   * TRACKS: track ch becomes another type (or OFF). Its notes stay; every pattern gets the
   * new type's starting sound (the saved patches too: RESET doesn't bring the old type
   * back), its locks go (they belong to the old type's knobs), its live knobs and CHORD are
   * the type's defaults. Mix and routing stay.
   */
  private setTrackType(ch: number, kind: InstrumentKind): void {
    const c = this.project.channels[ch];
    trackDefaults(c, kind);
    const patch = patchOf(c, c.activePattern);
    c.patterns.forEach((pat, p) => {
      if (p !== c.activePattern) setPatchOf(c, p, patch);
      pat.savedPatch = clonePatch(patch);
      pat.patchDirty = true;
      // Locks on the old sound's knobs go (mixer / FX / LFO / ARP locks stay); onto a
      // one-note type a chord keeps its lowest note.
      pat.steps.forEach((st, i) => {
        const before = JSON.stringify(st);
        dropSoundLocks(st, ch);
        if (!playsChords(kind)) lowestNoteOnly(st);
        if (JSON.stringify(st) !== before) this.send({ type: 'setStep', channel: ch, pattern: p, index: i, step: st });
      });
      for (const st of pat.savedNotes?.steps ?? []) {
        dropSoundLocks(st, ch);
        if (!playsChords(kind)) lowestNoteOnly(st);
      }
    });
    this.octave[ch] = kind === 'none' ? 36 : INSTRUMENTS[kind].baseNote;
    this.relabel(`TRACK ${ch + 1} TYPE`);
    this.send({ type: 'setInstrument', channel: ch, kind, sound: { ...patch.sound } });
    this.send({ type: 'setChord', channel: ch, chord: c.chord });
    this.send({ type: 'setNotes', channel: ch, notes: c.notes });
    this.save();
    this.flash(`TRACK ${ch + 1}: ${this.kindName(c)}`);
  }

  // ---------------------------------------------------------------- SONG step entry

  /** SONG RECORD stopped: the strip is one bar of the song, for locking knob values on its steps. */
  private get autoSteps(): boolean {
    return this.songRecord && !this.playing && this.songRows.length > 0;
  }

  /** Go to song bar b (from 0; wraps): the strip shows it and PLAY starts there. */
  private gotoSongBar(b: number): void {
    const rows = this.songRows;
    const total = rows.reduce((n, r) => n + r.bars, 0);
    if (total === 0) return;
    if (this.waiting) {
      this.flash('LOCK OR CANCEL FIRST');
      return;
    }
    let left = ((b % total) + total) % total;
    let row = 0;
    while (left >= rows[row].bars) left -= rows[row++].bars;
    this.unprime();
    this.songRow = row;
    this.songStartBar = left;
    this.stripStart = this.songBarNumber(row, left) - 1;
    this.songPage = Math.floor(this.stripStart / 16);
    this.flash(`BAR ${this.songBarNumber(row, left)} = R${row + 1} B${left + 1}`);
  }

  /** A knob's locked value at song cell p (in its own units); NaN before its first lock. */
  private laneAt(t: KnobTarget, p: number): number {
    const pts = this.project.song.auto?.[t.auto!.key];
    if (!pts?.length) return NaN;
    const scale = t.auto!.scale ?? 1;
    return valueAt(pts.map((q) => q[0]), pts.map((q) => q[1]), pts.length, p, scale === 1 ? t.spec : null) / scale;
  }

  /**
   * Playing: the knob in slot `slot` shows the value its locks give at the playhead (a SONG
   * lane while the song plays wins over the pattern's, as in the engine), else its own; a
   * knob turned in the last second shows its own value under the finger.
   */
  private heardTarget(t: KnobTarget, slot: number): KnobTarget {
    return {
      ...t,
      heard: true,
      get: () => {
        if (slot === this.touchedKnob && performance.now() - this.touchedAt < 1000) return t.get();
        const v = this.heardValue(t);
        return v === v ? v : t.get();
      },
    };
  }

  /** What a knob's locks give at the playhead (NaN = none there: the knob plays as set). */
  private heardValue(t: KnobTarget): number {
    const st = this.status;
    if (!st || !st.playing || !t.auto) return NaN;
    const scale = t.auto.scale ?? 1;
    if (this.songPlaying && st.songRow >= 0) {
      const v = this.laneAt(t, this.songCell(st.songRow, st.songBar, st.barPhase, st.barSteps));
      if (v === v) return v;
    }
    const a = parseAutoKey(t.auto.key);
    if (!a) return NaN;
    // Track knobs: that track's pattern; bus / LFO knobs: any track's pattern may lock them.
    const tracks = a.kind === 'b' || a.kind === 'l' ? this.project.channels.map((_, ch) => ch) : [a.index];
    for (const ch of tracks) {
      const idx = st.steps[ch] ?? -1;
      const c = this.project.channels[ch];
      const pat = c?.patterns[st.patterns[ch] ?? c.activePattern];
      if (idx < 0 || !pat) continue;
      const key = this.lockKey(t.auto.key, ch);
      const pos: number[] = [], val: number[] = [];
      for (let i = 0; i < pat.length; i++) {
        const v = pat.steps[i].locks?.[key];
        if (v !== undefined) { pos.push(i); val.push(v); }
      }
      const v = valueAt(pos, val, pos.length, idx, scale === 1 ? t.spec : null);
      if (v === v) return v / scale;
    }
    return NaN;
  }

  /** A song position (bar x 16 + strip cell) from the playing row, its bar and the bar's phase. */
  private songCell(row: number, bar: number, phase: number, barSteps: number): number {
    let played = Math.floor(phase * barSteps);
    let cell = 0;
    for (; cell < CELLS_PER_BAR - 1; cell++) if (meterPlays(this.project.meter, cell) && played-- === 0) break;
    return (this.songBarNumber(row, bar) - 1) * CELLS_PER_BAR + cell;
  }

  /** A knob while a step is primed: shows the value the step will lock (or plays now); turning auditions it. */
  private primedTarget(t: KnobTarget): KnobTarget {
    const pr = this.primed!;
    const key = t.auto!.key;
    return {
      ...t,
      inner: t,
      staged: pr.staged.has(key),
      get: () => {
        const s = pr.staged.get(key);
        if (s) return s.v;
        const v = pr.pattern ? this.lockAt(t, pr.pattern.ch, pr.pattern.p, pr.cell) : this.laneAt(t, pr.cell);
        return v === v ? v : t.get();
      },
      set: (v) => {
        if (!pr.orig.has(key)) pr.orig.set(key, { t, v: t.get() });
        pr.staged.set(key, { t, v });
        t.set(v);
      },
    };
  }

  /**
   * A knob touched. SONG RECORD: a primed step takes it (locked at the value it shows, even
   * unturned); with CLEAR held, all its locks in the song go.
   */
  private onTouch(slot: number): void {
    const t = this.targets[slot];
    if (!t?.auto || (!this.songRecord && !this.stepEdit)) return;
    if (this.clearHeld && this.stepEdit) {
      // CLEAR + touch: the knob's locks go from every step of the pattern.
      const key = this.lockKey(t.auto.key, this.selected);
      let n = 0;
      this.pattern.steps.forEach((step, i) => {
        if (step.locks?.[key] === undefined) return;
        delete step.locks[key];
        if (Object.keys(step.locks).length === 0) delete step.locks;
        this.sendStep(i, step);
        n++;
      });
      if (n > 0) this.save();
      this.flash(n > 0 ? `${t.label}: ${n} CLEARED` : `${t.label}: NO LOCKS`);
      this.clearUsed = true;
    } else if (this.clearHeld) {
      const lanes = this.project.song.auto;
      if (lanes?.[t.auto.key]) {
        delete lanes[t.auto.key];
        this.sendSong();
        this.save();
        this.flash(`${t.label} CLEARED`);
      }
      this.clearUsed = true;
    } else if (this.primed && !this.primed.staged.has(t.auto.key)) {
      this.primed.staged.set(t.auto.key, { t: t.inner ?? t, v: t.get() });
    } else return;
    this.refreshPanel();
  }

  /** SONG RECORD strip: tap = prime the step, again = lock (FUNC: every knob on the page); CLEAR + step = its locks go. */
  private autoStripTap(cell: number): void {
    if (!meterPlays(this.project.meter, cell)) return;
    const bar = this.songBarNumber(this.songRow, this.songStartBar) - 1;
    const pos = bar * CELLS_PER_BAR + cell;
    if (this.clearHeld) {
      const lanes = this.project.song.auto ?? {};
      let n = 0;
      for (const key of Object.keys(lanes)) {
        const kept = lanes[key].filter((q) => q[0] !== pos);
        n += lanes[key].length - kept.length;
        if (kept.length > 0) lanes[key] = kept;
        else delete lanes[key];
      }
      this.clearUsed = true;
      this.sendSong();
      this.save();
      this.flash(n > 0 ? `STEP ${cell + 1}: ${n} CLEARED` : 'NO LOCKS HERE');
      return;
    }
    if (this.primed?.cell === pos) {
      if (this.funcHeld) this.funcUsed = true;
      this.lockPrimed(this.func);
      return;
    }
    this.movePrime(pos);
  }

  /** Knobs touched on the primed step, not locked yet: nothing moves until LOCK or CANCEL. */
  private get waiting(): boolean {
    return !!this.primed && this.primed.staged.size > 0;
  }

  /** Prime another step / cell (refused while knobs wait on the primed one). */
  private movePrime(cell: number): boolean {
    if (this.waiting) {
      this.flash('LOCK OR CANCEL FIRST');
      return false;
    }
    this.unprime();
    this.primeAt(cell);
    return true;
  }

  private primeAt(cell: number): void {
    this.endAudition(); // the step locks against the patterns as they are
    const c = this.channel;
    this.primed = {
      cell, pattern: this.stepEdit ? { ch: this.selected, p: c.activePattern } : undefined,
      staged: new Map(), orig: new Map(),
      dirty: this.project.channels.flatMap((ch) => ch.patterns.map((p) => !!p.patchDirty)),
    };
  }

  /** ◀ ▶ in STEP EDIT / SONG RECORD: the primed step one on (the song: across bars). */
  private stepPrime(d: number): void {
    if (this.waiting) {
      this.flash('LOCK OR CANCEL FIRST');
      return;
    }
    if (this.stepEdit) {
      const len = this.pattern.length;
      this.movePrime((((this.primed?.cell ?? 0) + d) % len + len) % len);
      return;
    }
    const bar = this.songBarNumber(this.songRow, this.songStartBar) - 1;
    const pos = this.primed ? this.primed.cell + d : bar * CELLS_PER_BAR + (d > 0 ? 0 : CELLS_PER_BAR - 1);
    const to = Math.floor(pos / CELLS_PER_BAR);
    if (to !== bar) this.gotoSongBar(to);
    const now = this.songBarNumber(this.songRow, this.songStartBar) - 1;
    this.movePrime(now * CELLS_PER_BAR + (((pos % CELLS_PER_BAR) + CELLS_PER_BAR) % CELLS_PER_BAR));
  }

  /** A pattern step lock's key: the track's own sound params by their bare id (Step.locks). */
  private lockKey(autoKey: string, ch: number): string {
    const own = `s:${ch}:`;
    return autoKey.startsWith(own) ? autoKey.slice(own.length) : autoKey;
  }

  /** A knob's lock on a pattern step, in its own units; NaN = none. */
  private lockAt(t: KnobTarget, ch: number, p: number, index: number): number {
    const v = this.project.channels[ch].patterns[p].steps[index]?.locks?.[this.lockKey(t.auto!.key, ch)];
    return v === undefined ? NaN : v / (t.auto!.scale ?? 1);
  }

  /** STEP EDIT strip: tap the yellow step = lock; another = prime it; CLEAR + step = its locks go. */
  private stepEditTap(button: number): void {
    const index = this.visiblePage(this.selected) * 16 + button;
    if (index >= this.pattern.length) return;
    if (this.clearHeld) {
      const step = this.pattern.steps[index];
      this.clearUsed = true;
      if (!step.locks) {
        this.flash('NO LOCKS HERE');
        return;
      }
      delete step.locks;
      this.sendStep(index, step);
      this.save();
      this.relabel(`CLEAR LOCKS ${index + 1}`);
      this.flash(`STEP ${index + 1}: LOCKS CLEARED`);
      return;
    }
    if (this.copyHeld && this.primed?.cell !== index) {
      this.copyPrimed(index);
      return;
    }
    if (this.primed?.cell === index) {
      if (this.funcHeld) this.funcUsed = true;
      this.lockPrimed(this.func);
      return;
    }
    this.movePrime(index);
  }

  /**
   * STEP EDIT, COPY held: the primed step (its notes, flags and locks) onto step `index`; more
   * taps place more copies until COPY is let go. Whether a step plays (STEPS) stays the target's.
   */
  private copyPrimed(index: number): void {
    this.copyUsed = true;
    if (this.waiting) {
      this.flash('LOCK OR CANCEL FIRST');
      return;
    }
    const steps = this.pattern.steps;
    const from = this.primed!.cell;
    const copy = JSON.parse(JSON.stringify(steps[from])) as Step;
    if (steps[index].flip) copy.flip = true;
    else delete copy.flip;
    steps[index] = copy;
    this.sendStep(index, copy);
    this.save();
    this.relabel(`COPY STEP ${from + 1}`);
    this.flash(`STEP ${from + 1} COPIED TO ${index + 1}`);
  }

  /** STEP EDIT on (RECORD, stopped): the other strip modes go, the step entry cursor's step is primed. */
  private toggleStepEdit(): void {
    if (this.stepEdit) {
      this.leaveStepEdit();
      return;
    }
    if (this.mode !== 'record' || this.song) {
      this.flash('STEP EDIT: RECORD ONLY');
      return;
    }
    this.stepsMode = false;
    this.ring = false;
    this.slideArm = false;
    this.dynamic = 'normal';
    this.restArm = false;
    this.dropCopyBar();
    this.entry = null;
    const ch = this.selected;
    const cell = this.stripSteps() ? this.visiblePage(ch) * 16 : this.cursor[ch];
    this.stepEdit = true;
    this.primeAt(Math.min(cell, this.pattern.length - 1));
    this.flash('STEP EDIT: TOUCH KNOBS');
  }

  private leaveStepEdit(): void {
    if (!this.stepEdit) return;
    this.unprime();
    this.stepEdit = false;
  }

  /** The second tap: each knob touched since priming is locked at its value there. */
  private lockPrimed(all: boolean): void {
    const pr = this.primed!;
    if (all) for (const t of this.targets) if (t?.auto && !pr.staged.has(t.auto.key)) pr.staged.set(t.auto.key, { t: t.inner ?? t, v: t.get() });
    const n = pr.staged.size;
    if (pr.pattern) {
      // STEP EDIT: the values go on the pattern step (Step.locks).
      const { ch, p } = pr.pattern;
      const pat = this.project.channels[ch].patterns[p];
      const step = pat.steps[pr.cell];
      const locks = { ...step.locks };
      for (const [key, { t, v }] of pr.staged) locks[this.lockKey(key, ch)] = v * (t.auto?.scale ?? 1);
      this.unprime();
      this.primeAt(pr.cell);
      if (n === 0) {
        this.flash('TOUCH KNOBS TO LOCK');
        return;
      }
      step.locks = locks;
      pat.notesDirty = true;
      this.send({ type: 'setStep', channel: ch, pattern: p, index: pr.cell, step });
      this.save();
      this.relabel(`LOCK STEP ${pr.cell + 1}`);
      this.flash(`LOCKED ${n} AT STEP ${pr.cell + 1}`);
      return;
    }
    const lanes = (this.project.song.auto ??= {});
    for (const [key, { t, v }] of pr.staged) {
      const pts = (lanes[key] ?? []).filter((q) => q[0] !== pr.cell);
      pts.push([pr.cell, v * (t.auto?.scale ?? 1)]);
      pts.sort((a, b) => a[0] - b[0]);
      lanes[key] = pts;
    }
    const cell = pr.cell;
    this.unprime();
    if (n === 0) {
      this.flash('TOUCH KNOBS TO LOCK');
      return;
    }
    this.sendSong();
    this.save();
    this.flash(`LOCKED ${n} AT ${Math.floor(cell / CELLS_PER_BAR) + 1}.${(cell % CELLS_PER_BAR) + 1}`);
  }

  /** Leave a primed step: the knobs auditioned meanwhile go back to their own values. */
  private unprime(): void {
    const pr = this.primed;
    if (!pr) return;
    this.primed = null;
    for (const { t, v } of pr.orig.values()) t.set(v);
    let i = 0;
    for (const c of this.project.channels) for (const p of c.patterns) p.patchDirty = pr.dirty[i++];
  }

  private primedHint(): string {
    const pr = this.primed!;
    const step = pr.pattern ? pr.cell + 1 : (pr.cell % CELLS_PER_BAR) + 1;
    return pr.staged.size ? `TAP ${step} TO LOCK ${pr.staged.size}` : `STEP ${step}: TOUCH KNOBS`;
  }

  /**
   * STEP EDIT strip: the bar of the selected track's pattern with the primed step; lit = locks
   * on the step, outlined = a note, × = a step the time signature leaves out, yellow = primed.
   */
  private updateStepEditStrip(): void {
    const pr = this.primed;
    const page = this.visiblePage(this.selected);
    const pattern = this.pattern;
    // Playing: the step being heard lights (the edited pattern only).
    const c = this.channel;
    const head = this.playing && (this.status?.patterns[this.selected] ?? c.activePattern) === c.activePattern ? (this.status?.steps[this.selected] ?? -1) : -1;
    for (let i = 0; i < STEP_BUTTONS; i++) {
      const id = `step${i + 1}`;
      const index = page * 16 + i;
      const off = index >= pattern.length;
      const step = pattern.steps[index];
      const dark = !off && !this.plays(index);
      const meterOut = dark && !step.flip && !meterPlays(this.project.meter, index);
      const primed = pr?.cell === index;
      this.panel.setButtonText(id, meterOut ? '×' : String(index + 1));
      this.panel.setButtonFlag(id, 'off', off);
      this.panel.setButtonFlag(id, 'skip', dark);
      this.panel.setButtonFlag(id, 'lit', !off && !!step.locks);
      this.panel.setButtonFlag(id, 'note', !off && step.active);
      this.panel.setButtonFlag(id, 'cursor', primed);
      for (const f of ['black', 'accent', 'ghost', 'ring', 'rest', 'head', 'tie']) this.panel.setButtonFlag(id, f, false);
      this.panel.setLed(i, primed ? 'cursor' : !off && index === head ? 'on' : '');
    }
    this.panel.setButtonText('steppage', `BAR<small>${page + 1}/${this.pageCount()}</small>`);
  }

  /** SONG RECORD strip: the bar's 16 steps; lit = something is locked there, yellow = primed. */
  private updateAutoStrip(): void {
    const bar = this.songBarNumber(this.songRow, this.songStartBar) - 1;
    const from = bar * CELLS_PER_BAR;
    const locked = new Set<number>();
    for (const pts of Object.values(this.project.song.auto ?? {})) {
      for (const [p] of pts) if (p >= from && p < from + CELLS_PER_BAR) locked.add(Math.floor(p - from));
    }
    for (let i = 0; i < STEP_BUTTONS; i++) {
      const id = `step${i + 1}`;
      const primed = this.primed?.cell === from + i;
      this.panel.setButtonText(id, String(i + 1));
      this.panel.setButtonFlag(id, 'off', !meterPlays(this.project.meter, i));
      this.panel.setButtonFlag(id, 'lit', locked.has(i));
      this.panel.setButtonFlag(id, 'cursor', primed);
      for (const f of ['note', 'black', 'accent', 'ghost', 'ring', 'rest', 'head', 'tie', 'skip']) this.panel.setButtonFlag(id, f, false);
      this.panel.setLed(i, primed ? 'cursor' : '');
    }
    const total = this.songRows.reduce((n, r) => n + r.bars, 0);
    this.panel.setButtonText('steppage', `BAR<small>${bar + 1}/${total}</small>`);
  }

  /**
   * CANCEL outside the menus: knobs waiting on a primed step (STEP EDIT / SONG RECORD) are left
   * unlocked, COPY BAR copies nothing; with nothing pending it says so (UNDO is its own key).
   */
  private cancel(): void {
    if (this.waiting) {
      const pr = this.primed!;
      this.unprime();
      if (pr.pattern) this.primeAt(pr.cell);
      this.flash('STEP LEFT UNLOCKED');
    } else if (this.copyBar) {
      this.dropCopyBar();
      this.flash('NOTHING COPIED');
    } else {
      this.flash('NOTHING TO CANCEL');
    }
  }

  /** Something CANCEL would drop (the CANCEL key lights). */
  private get cancelShows(): boolean {
    return !!(this.menu || this.projMenu || this.waiting || this.copyBar);
  }

  // ---------------------------------------------------------------- UNDO / REDO

  /** Live recording: one PLAY -> STOP pass is one step back. */
  private get livePass(): boolean {
    return this.playing && this.mode === 'record' && !this.song && !this.stepEdit; // STEP EDIT: each lock its own step
  }

  /**
   * A gesture starts with a knob touch (or a knob / encoder turn not part of the last one)
   * or a button press with nothing else held; what changed during the one before becomes a
   * step back.
   */
  private trackGesture(e: ControlEvent): void {
    const inMenu = !!(this.menu || this.projMenu);
    // A primed SONG RECORD step and COPY BAR are one gesture until locked / pasted (or dropped).
    const pending = this.waiting || !!this.copyBar;
    if (e.type === 'button' && e.id !== 'func') {
      if (e.pressed) this.down.add(e.id);
      else this.down.delete(e.id);
    }
    if (pending) return;
    if (e.type === 'touch') {
      this.beginGesture(e.id, this.knobLabel(e.id), inMenu);
    } else if (e.type === 'knob' || e.type === 'encoder') {
      if (this.gesture?.key !== e.id) this.beginGesture(e.id, this.knobLabel(e.id), inMenu);
    } else if (e.type === 'button' && e.pressed && e.id !== 'func' && this.down.size === 1) {
      this.beginGesture(e.id, this.pressLabel(e.id), inMenu || e.id === 'cancel' || e.id === 'undo');
    }
  }

  private beginGesture(key: string, label: string, skip: boolean): void {
    if (this.livePass && this.gesture?.label === 'RECORDING') return; // the pass runs on
    this.commitGesture();
    this.gesture = { key, label, skip };
  }

  /** The gesture that ran (if it changed the project) becomes a step back. */
  private commitGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    if (!this.edited) return;
    this.edited = false;
    const now = snapshot(this.project);
    if (now === this.snap) return;
    if (!g?.skip) {
      this.undoStack.push({ label: g?.label ?? 'EDIT', before: this.snap, after: now });
      if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
      this.redoStack = [];
    }
    this.snap = now;
  }

  /** What UNDO will call this gesture (CLEAR / COPY / the menu's TRACKS name it better). */
  private relabel(label: string): void {
    if (!this.gesture) return;
    this.gesture.label = label;
    this.gesture.skip = false;
  }

  private knobLabel(id: string): string {
    const gid = MASTER_GLOBAL[id];
    if (gid) return GLOBAL_PARAMS.find((p) => p.id === gid)?.name ?? 'KNOB';
    return this.targets[Number(id.slice(1)) - 1]?.label ?? 'KNOB';
  }

  private pressLabel(id: string): string {
    const c = this.channel;
    const at = `${this.kindName(c)} ${PATTERN_NAMES[c.activePattern]}`;
    if (this.songGrid) return 'SONG';
    if (this.autoSteps) return 'SONG LOCK';
    if (id === 'play') return this.mode === 'record' && !this.song && !this.playing ? 'RECORDING' : 'PLAY';
    if (id === 'reset') return 'RESET';
    if (id === 'clear') return `CLEAR ${at}`;
    if (id === 'copy') return `COPY ${at}`;
    if (id === 'speed') return `TIME ${at}`;
    if (id === 'len') return `STEPS ${at}`;
    if (/^(fx\d|ch\d)$/.test(id)) return 'FX ROUTING';
    if (id.startsWith('oct')) return 'OCTAVE';
    return `NOTES ${at}`;
  }

  /** UNDO: back one step (REDO: forward one), playing or not. */
  private undo(redo = false): void {
    this.endAudition();
    this.commitGesture(); // a live-recording pass so far is a step too
    const from = redo ? this.redoStack : this.undoStack;
    const to = redo ? this.undoStack : this.redoStack;
    const step = from.pop();
    if (!step) {
      this.flash(redo ? 'NOTHING TO REDO' : 'NOTHING TO UNDO');
    } else {
      to.push(step);
      this.applySnapshot(redo ? step.after : step.before);
      this.flash(`${redo ? 'REDO' : 'UNDO'}: ${step.label}`);
    }
    this.gesture = this.livePass ? { key: 'play', label: 'RECORDING', skip: false } : null;
  }

  /** Go to a snapshot: the engine gets what differs, the UI lets go of what it no longer fits. */
  private applySnapshot(snap: string): void {
    const next = restore(snap, this.project);
    for (const msg of changes(this.project, next)) this.send(msg);
    next.channels.forEach((c, ch) => {
      if (c.instrument !== this.project.channels[ch].instrument) this.octave[ch] = c.instrument === 'none' ? 36 : INSTRUMENTS[c.instrument].baseNote;
      const length = c.patterns[c.activePattern].length;
      if (this.cursor[ch] >= length) this.cursor[ch] = 0;
      if (this.viewPage[ch] * 16 >= length) this.viewPage[ch] = 0;
    });
    // In place: whatever holds the project or a channel sees the change.
    const assign = (to: object, from: object) => {
      for (const k of Object.keys(to)) if (!(k in from)) delete (to as Record<string, unknown>)[k];
      Object.assign(to, from);
    };
    next.channels.forEach((c, ch) => assign(this.project.channels[ch], c));
    next.channels = this.project.channels;
    assign(this.project, next);
    this.entry = null;
    this.glides.clear();
    this.songRow = Math.max(0, Math.min(this.songRow, next.song.rows.length - 1));
    this.save();
    this.edited = false;
    this.snap = snapshot(this.project);
  }

  /** The MENU screen. */
  menuView(): MenuView {
    const now = performance.now();
    const at = this.menuPage;
    const lines = this.menuLines(at.page);
    const changed = at.pending.size > 0;
    const hint = changed ? 'PLAY = SAVE  CANCEL = BACK WITHOUT SAVING'
      : lines.some((l) => l.options) ? 'OCT ARROWS MOVE  < > SET  PLAY = SAVE  CANCEL = BACK'
      : 'OCT ARROWS MOVE  > OPEN  CANCEL = BACK';
    return {
      title: this.menu!.stack.map((e) => MENU_TITLES[e.page]).join(' > '),
      items: lines.map((l, i) => ({
        label: l.label,
        value: l.options ? (l.options[this.menuValue(l, i)] ?? '') + (at.pending.has(i) ? '?' : '') : '',
        page: !!l.open,
        pending: at.pending.has(i),
      })),
      item: at.item,
      message: now < this.messageUntil ? this.message : hint,
    };
  }

  /** MENU: strip keys 1-n = the page's lines (the cursor's marked, changed ones flagged), the rest dark. */
  private updateMenuStrip(): void {
    const at = this.menuPage;
    const lines = this.menuLines(at.page);
    for (let i = 0; i < STEP_BUTTONS; i++) {
      const id = `step${i + 1}`;
      const used = i < lines.length;
      this.panel.setButtonText(id, used ? String(i + 1) : '');
      this.panel.setButtonFlag(id, 'off', !used);
      this.panel.setButtonFlag(id, 'lit', used);
      this.panel.setButtonFlag(id, 'cursor', i === at.item);
      this.panel.setButtonFlag(id, 'accent', used && at.pending.has(i));
      for (const f of ['note', 'black', 'ghost', 'ring', 'rest', 'head', 'tie', 'skip']) this.panel.setButtonFlag(id, f, false);
      this.panel.setLed(i, used && at.pending.has(i) ? 'rec' : i === at.item ? 'cursor' : '');
    }
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
    if (id === 'cancel') {
      this.closeProjectMenu();
      return true;
    }
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
    this.newSlot = -1;
    this.saved = this.savedOf(this.project);
    this.closeProjectMenu();
    this.flash(`SAVED ${name} IN ${slot + 1}`);
  }

  private loadFromSlot(slot: number): void {
    const entry = projectStore.slots()[slot];
    if (!entry) {
      this.newProject(slot);
      return;
    }
    const openId = projectStore.openId();
    this.newSlot = -1;
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

  /**
   * LOAD on an empty slot: a new project (the default one). The project open now keeps its
   * unsaved edits in its slot, as on any load; one never saved (and changed) needs a second
   * tap, since it is not kept anywhere.
   */
  private newProject(slot: number): void {
    const menu = this.projMenu!;
    const openId = projectStore.openId();
    const fresh = createDefaultProject();
    const changed = JSON.stringify(toStored(this.project)) !== JSON.stringify(toStored(fresh));
    if (!openId && changed && menu.confirm !== slot) {
      menu.confirm = slot;
      this.flash(`NOT SAVED: TAP ${slot + 1} AGAIN FOR NEW`);
      return;
    }
    if (openId) projectStore.saveWork(openId, this.project);
    projectStore.setOpen(null);
    this.newSlot = slot;
    this.replaceProject(fresh);
    this.closeProjectMenu();
    this.flash('NEW PROJECT: SAVE TO KEEP');
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
    this.saved = this.savedOf(project);
    this.resetAgainUntil = 0;
    this.entry = null;
    project.channels.forEach((c, i) => { this.octave[i] = c.instrument === 'none' ? 36 : INSTRUMENTS[c.instrument].baseNote; });
    this.selected = 0;
    this.viewPage.fill(0);
    this.cursor.fill(0);
    this.soloed.fill(false);
    this.glides.clear();
    this.audition.clear(); // the new project's patches go to the engine whole
    this.fxView = 0;
    for (const msg of this.syncMessages()) this.send(msg);
    this.save();
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = null;
    this.snap = snapshot(project);
    this.edited = false;
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
      // Whatever the strip showed before (steps, ties, dark steps, keys) is cleared.
      for (const f of ['note', 'black', 'accent', 'ghost', 'ring', 'rest', 'head', 'tie', 'skip']) this.panel.setButtonFlag(id, f, false);
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
    this.syncClick();
    this.targets = this.computeTargets();
    if (this.menu || this.projMenu || this.songGrid) this.heldKnobs.clear();
    this.targets.forEach((t, i) => {
      this.panel.configureKnob(
        i,
        t ? { label: t.label, value: toNorm(t.spec, t.get()), defaultValue: toNorm(t.spec, t.base?.() ?? t.spec.defaultValue), highlight: t.highlight, staged: t.staged } : null,
      );
    });

    for (const m of MODES) this.panel.setButtonLit(`mode:${m.id}`, m.id === this.mode);
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const c = this.project.channels[ch];
      // While a bus is open (RECORD/PLAY), channel buttons show which tracks are on it.
      const sendView = this.sendOpen;
      // STEPS mode: a track button per bar, lit = the pattern has it.
      const lit = sendView ? this.onBus(c, this.fxView) : this.stepsMode ? ch < this.pageCount() : ch === this.selected;
      this.panel.setButtonLit(`ch${ch + 1}`, lit);
      this.panel.setButtonFlag(`ch${ch + 1}`, 'send', sendView);
      this.panel.setButtonLit(`mute${ch + 1}`, c.mute);
      this.panel.setButtonLit(`solo${ch + 1}`, this.soloed[ch]);
      this.panel.setButtonText(`ch${ch + 1}`, `${ch + 1}<small>${this.kindName(c)}</small>`);
    }
    for (const [id, gid] of Object.entries(MASTER_GLOBAL)) {
      const spec = GLOBAL_PARAMS.find((p) => p.id === gid) as ParamSpec;
      this.panel.configureMaster(id, toNorm(spec, this.project[gid]), toNorm(spec, this.savedProject()[gid]));
    }
    for (let n = 1; n <= FX_SEND_BUTTONS; n++) {
      this.panel.setButtonLit(`fx${n}`, this.fxView === n);
    }
    // DESIGN: SOUND / MIX / PROJECT. PLAY: SOUND (live knobs) / MIX; PROJECT shown but off.
    const names = this.pageNames();
    const current = this.mode === 'play' ? this.playPage : this.designPage;
    for (let i = 0; i < DESIGN_PAGE_BUTTONS; i++) {
      const name = names[i];
      const usable = !!name && (this.mode === 'design' || this.songRecord || i < PLAY_PAGES);
      this.panel.setButtonText(`dpage${i}`, name ?? '');
      this.panel.setButtonEnabled(`dpage${i}`, usable);
      this.panel.setButtonLit(`dpage${i}`, usable && i === current && this.fxView === 0);
    }
    this.panel.setButtonLit('clear', this.clearHeld);
    this.panel.setButtonLit('reset', this.glides.size > 0 || performance.now() < this.resetLitUntil);
    this.panel.setButtonLit('menu', !!this.menu);
    this.panel.setButtonLit('cancel', this.cancelShows);
    this.panel.setButtonText('undo', this.func ? 'REDO' : 'UNDO');
    this.panel.setButtonText('menu', this.song ? 'MENU<small>SONG</small>' : 'MENU');
    // SAVE PROJECT doubles as LOAD (FUNC): the label says which one a tap opens.
    this.panel.setButtonText('saveproject', this.func ? 'LOAD<small>PROJECT</small>' : 'SAVE/LOAD<small>PROJECT</small>');
    this.panel.setButtonEnabled('clear', this.mode !== 'design' || this.songGrid);
    this.panel.setButtonLit('copy', this.copyHeld || !!this.copyBar);
    this.panel.setButtonEnabled('copy', this.mode !== 'design' || this.songGrid);
    this.panel.setButtonLit('play', this.playing);
    this.panel.setButtonText('play', this.playing ? 'STOP' : 'PLAY');

    const rec = this.mode === 'record';
    const kb = this.keyboard;
    this.panel.setButtonLit('func', this.func);
    const play = this.forcing;
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
    // BAR: not where the strip follows the playhead (PLAY, DESIGN, live recording). TIME (the
    // pattern's speed) works in every mode but SONG.
    this.panel.setButtonEnabled('steppage', !!this.projMenu || this.autoSteps || this.stepsMode || !this.followsPlayhead);
    for (const id of ['oct-', 'oct+']) this.panel.setButtonEnabled(id, kb);
    // Drum lanes in RECORD paint by sliding; with CLEAR held any strip clears by sliding.
    this.panel.setStripSlide(!this.stepsMode && (this.stripSteps() || (this.clearHeld && this.mode !== 'design')));
    for (const id of ['cur-', 'cur+']) this.panel.setButtonEnabled(id, (kb && rec) || this.barHeld || this.lenHeld || this.scaleHeld || this.stepsMode || !!this.projMenu || !!this.copyBar || this.stepEdit || this.autoSteps);
    this.panel.setButtonEnabled('rest', rec);
    // SCALE: the strip keyboard's root / minor or chromatic (not on the SONG grid).
    this.panel.setButtonEnabled('scale', !this.songGrid);
    this.panel.setButtonText('scale', `SCALE<small>${this.scaleName()}</small>`);
    this.panel.setButtonLit('scale', this.scaleHeld);
    // STRIP: keys / steps on the strip, the selected track's (RECORD); lit = not its type's own.
    this.panel.setButtonEnabled('view', !this.song);
    this.panel.setButtonText('view', `STRIP<small>${this.stripSteps() ? 'STEPS' : 'KEYS'}</small>`);
    this.panel.setButtonLit('view', this.stripFlip[this.selected]);
    // STEP EDIT: RECORD, stopped, on the pattern it was primed on (else it starts over there).
    if (this.stepEdit && (!rec || this.song)) this.leaveStepEdit();
    if (this.stepEdit && !this.waiting && (this.primed?.pattern?.ch !== this.selected || this.primed.pattern.p !== this.channel.activePattern)) {
      const cell = Math.min(this.primed?.cell ?? 0, this.pattern.length - 1);
      this.unprime();
      this.primeAt(cell);
    }
    this.panel.setButtonEnabled('stepedit', rec && !this.song);
    this.panel.setButtonLit('stepedit', this.stepEdit);
    this.panel.setButtonEnabled('arp', !this.songGrid);
    this.panel.setButtonLit('arp', !!this.channel.arp?.on || this.arpOpen);
    if (kb || !rec) this.restArm = false;
    this.panel.setButtonLit('rest', this.restArm);
    // The SAVE / LOAD menu's slots look the same in every mode (never as keys).
    this.panel.root.classList.toggle('keyboard', kb && !this.projMenu);
    // SONG DESIGN: the function row edits the song strip.
    const song = this.songGrid;
    if (!song) this.stripEdit = false;
    // FUNC: the sound's OCTAVE keys (SND), showing where it is now; else the keyboard's.
    const snd = this.soundOctave(this.channel);
    const sndSmall = snd ? `<small>${snd}</small>` : '';
    this.panel.setButtonText('oct-', song ? 'TRK ▼' : this.func && !this.menu ? `SND ▼${sndSmall}` : 'OCT ▼');
    this.panel.setButtonText('oct+', song ? 'TRK ▲' : this.func && !this.menu ? `SND ▲${sndSmall}` : 'OCT ▲');
    if (song) {
      // REST = an empty bar, STEP EDIT = clip lengths, ▼ ▲ = the next / previous track.
      for (const id of ['ring', 'slide', 'dyn:accent', 'dyn:ghost']) {
        this.panel.setButtonLit(id, false);
        this.panel.setButtonEnabled(id, false);
      }
      this.panel.setButtonEnabled('len', false);
      this.panel.setButtonEnabled('speed', false);
      this.panel.setButtonEnabled('rest', true);
      this.panel.setButtonEnabled('steppage', true);
      this.panel.setButtonEnabled('stepedit', true);
      this.panel.setButtonLit('stepedit', this.stripEdit);
      for (const id of ['oct-', 'oct+', 'cur-', 'cur+']) this.panel.setButtonEnabled(id, true);
      this.panel.root.classList.toggle('keyboard', false);
    } else {
      // SONG RECORD / PLAY: the keys that edit a pattern are off (SONG_KEEPS).
      const off = this.song;
      this.panel.setButtonEnabled('dyn:accent', !off || this.forcing);
      this.panel.setButtonEnabled('dyn:ghost', !off || this.forcing);
      if (off && !this.forcing) for (const id of ['ring', 'slide']) this.panel.setButtonEnabled(id, false);
      this.panel.setButtonEnabled('len', !off);
      this.panel.setButtonEnabled('speed', !off);
      if (off) this.panel.setButtonEnabled('rest', false);
    }
    if (this.menu) {
      for (const id of ['oct-', 'oct+', 'cur-', 'cur+']) this.panel.setButtonEnabled(id, true);
      this.panel.root.classList.toggle('keyboard', false);
    }
  }

  /** Per-frame updates: strip lights/labels, LEDs, pending pattern blink. */
  updateFrame(now: number): void {
    this.stepGlides(now);
    // Playing: knobs with locks follow them.
    if (this.playing) this.targets.forEach((t, i) => { if (t?.heard) this.panel.setKnob(`k${i + 1}`, toNorm(t.spec, t.get())); });
    if (this.projMenu) {
      this.updateProjectStrip();
      return;
    }
    if (this.menu) {
      this.updateMenuStrip();
      return;
    }
    if (this.autoSteps) {
      this.updateAutoStrip();
      return;
    }
    if (this.stepEdit) {
      this.updateStepEditStrip();
      this.updatePatternButtons(now);
      return;
    }
    if (this.songGrid) {
      this.updateStripFrame();
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
    const entryGate = this.entry ? this.entryLength() : 0; // the entered note's own length (PAD / PLUCK)
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
      let cursorNotes = pitchedRecord && cursorStep.active ? [cursorStep.note, ...(cursorStep.extra ?? [])] : [];
      // PAD / PLUCK: every note sounding at the playhead is lit dim (held keys show bright). Step
      // entry: the ring = only the note(s) being entered; the other notes sounding at the
      // step (on it, or tied over from earlier) are lit dim.
      let under: number[] = [];
      if (playsChords(c.instrument) && head >= 0) under = soundingAt(pattern.steps, pattern.length, head).map((n) => n.note);
      if (pitchedRecord && playsChords(c.instrument)) {
        cursorNotes = this.entry?.notes ?? [];
        under = soundingAt(pattern.steps, pattern.length, this.entry?.index ?? cursor).map((n) => n.note).filter((n) => !cursorNotes.includes(n));
      }
      for (let i = 0; i < STEP_BUTTONS; i++) {
        const id = `step${i + 1}`;
        const note = this.keyNote(ch, i);
        this.panel.setButtonText(id, noteName(note));
        this.panel.setButtonFlag(id, 'black', this.blackKey(note));
        this.panel.setButtonFlag(id, 'lit', note === sounding || under.includes(note));
        this.panel.setButtonFlag(id, 'cursor', cursorNotes.includes(note));
        for (const f of ['note', 'accent', 'ghost', 'head', 'off', 'ring', 'rest', 'tie', 'skip']) this.panel.setButtonFlag(id, f, false);
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
        // A step the time signature leaves out (not switched back on with STEPS) shows ×.
        const meterOut = dark && !own.flip && !meterPlays(this.project.meter, index);
        this.panel.setButtonText(id, meterOut ? '×' : roll ? `${index + 1}<small>×${roll}</small>` : String(index + 1));
        this.panel.setButtonFlag(id, 'off', off);
        // STEPS mode: lit = the step plays.
        this.panel.setButtonFlag(id, 'lit', this.stepsMode ? !off && !dark : d !== null);
        this.panel.setButtonFlag(id, 'accent', !view && d === 'accent');
        this.panel.setButtonFlag(id, 'ghost', view ? d !== null && !flagged : d === 'ghost');
        this.panel.setButtonFlag(id, 'head', head === index);
        this.panel.setButtonFlag(id, 'ring', !view && d !== null && !!step.ring);
        this.panel.setButtonFlag(id, 'rest', !off && !step.active && !!step.rest);
        for (const f of ['note', 'black', 'cursor']) this.panel.setButtonFlag(id, f, false);
        if (tie && !meterOut) this.panel.setButtonText(id, String(index + 1));
      }
    }

    this.panel.setButtonText('steppage', `BAR<small>${page + 1}/${this.pageCount()}</small>`);
    // TIME: the pattern's speed (tap to change).
    this.panel.setButtonText('speed', `TIME<small>${(this.pattern.speed ?? 'normal').toUpperCase()}</small>`);

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
    // Room for ~10 characters: output latency, the audio thread's load, then the panel's drawing
    // cost per frame and its frame rate, 3 s each; a load near the limit stays up, flagged.
    const dsp = `DSP ${Math.round(audio.dspLoad * 100)}%`;
    if (audio.dspLoad >= DSP_ALERT) return { text: dsp, alert: true };
    const phase = audio.fps > 0 ? Math.floor(performance.now() / 3000) % 4 : 0;
    if (phase === 1) return { text: dsp, alert: false };
    if (phase === 2) return { text: `UI ${audio.uiMs.toFixed(1)}MS`, alert: false };
    if (phase === 3) return { text: `UI ${Math.round(audio.fps)}FPS`, alert: false };
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
      // The sound's OCTAVE beside the name (synths), so it is always in sight.
      channelLabel: `CH${ch + 1} ${this.kindName(c)}${this.soundOctave(c) ? ' ' + this.soundOctave(c) : ''}`,
      patternLabel: (this.playing && playingPattern !== c.activePattern
        ? `PAT ${PATTERN_NAMES[playingPattern]}>${PATTERN_NAMES[c.activePattern]}`
        : `PAT ${PATTERN_NAMES[c.activePattern]}`) + (this.dirty(c) ? '*' : ''),
      bpmText: this.project.bpm.toFixed(0),
      playing: this.playing,
      message: performance.now() < this.messageUntil ? this.message : this.primed ? this.primedHint()
        : this.copyBar ? `COPY BAR ${this.copyBar.from + 1} > ${this.copyBar.to + 1}` : '',
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
      const tied = pitched ? tiedSteps(pat.steps, pat.length, playsChords(lc.instrument)) : null;
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
      stepsLabel: this.stepsMode ? 'STEPS: TAP = ON / OFF' : this.clearHeld ? 'CLEAR: STEP / TRACK / A-D' : this.copyHeld ? 'COPY: TRACK / A-D' : this.func && this.fxView === 0 ? 'FUNC: LIVE 3 / 4' : (len > 16 ? `${page * 16 + 1}-${Math.min(len, page * 16 + 16)}/${len}` : `${len} STEPS`) + SPEED_MARK[this.pattern.speed ?? 'normal'],
      motion: this.recording && this.keyboard,
      lanes,
      modeLabel: this.mode === 'record' ? 'RECORD' : 'PLAY',
      keyboardLabel: this.keyboard ? `KEYS ${noteName(this.keyNote(ch, 0))} ${this.project.chromatic ? 'CHR' : 'MIN'}` : '',
      dynamicLabel: this.dynamic === 'normal' ? '' : this.dynamic.toUpperCase(),
      slots: this.slots(),
      touchedSlot: this.touchedKnob,
      peak: audio.peak,
      footerRight: f.text,
      footerAlert: f.alert,
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }

  /** SONG strip: every track's lane over the page's 16 bars. */
  songStripView(now: number, audio: AudioInfo): SongStripView {
    const f = this.footer(audio);
    const clips = this.clips();
    const lane = clips[this.selected];
    const cur = this.stripEdit ? clipAt(lane, this.stripBar) : undefined;
    const end = songBars(this.songRows);
    const playing = this.songPlaying ? this.playingSongBar() : -1;
    const at = clipAt(lane, this.stripBar);
    return {
      ...this.header(),
      channelLabel: 'SONG',
      patternLabel: `${end} BARS`,
      tracks: this.project.channels.map((c, i) => `${i + 1}${this.kindName(c).slice(0, 3)}`),
      selected: this.selected,
      firstBar: this.songPage * 16,
      lanes: clips.map((l) => l.map((c) => ({ at: c.at, bars: c.bars, name: PATTERN_NAMES[c.pattern] }))),
      cursorFrom: cur ? cur.at : this.stripBar,
      cursorTo: cur ? cur.at + cur.bars - 1 : this.stripBar,
      playingBar: playing,
      endBar: end,
      footerLeft: playing >= 0 ? `BAR ${playing + 1}/${end}`
        : `${this.stripEdit ? 'EDIT ' : ''}BAR ${this.stripBar + 1}${at ? ` ${PATTERN_NAMES[at.pattern]} ${at.bars}/${patternBars(this.project.channels[this.selected], at.pattern)}` : ''} START ${Math.min(this.stripStart, Math.max(0, end - 1)) + 1}`,
      peak: audio.peak,
      footerRight: f.text,
      footerAlert: f.alert,
      blink: Math.floor(now / 400) % 2 === 0,
    };
  }


  /** The ARP view (FUNC + ARP): the selected track's ARP knobs on screen, like a bus. */
  arpScreen(now: number, audio: AudioInfo): DesignView {
    const f = this.footer(audio);
    const c = this.channel;
    const arp = c.arp ?? defaultArp();
    return {
      ...this.header(),
      channelLabel: `ARP ${this.selected + 1} ${this.kindName(c)}`,
      patternLabel: '',
      kindLabel: this.mode.toUpperCase(),
      pages: ['ARP'],
      page: 0,
      slots: this.slots(),
      touchedSlot: this.touchedKnob,
      liveLabel: !arp.on ? 'ARP OFF' : arp.mode === 0 ? 'ON, MODE OFF' : `ARP ON ${ARP_MODES[arp.mode]}`,
      chordLabel: 'ARP = ON/OFF',
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
    return this.mode === 'design' || this.mode === 'play' || this.songRecord ? this.designPages().map((p) => p.name) : [];
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
