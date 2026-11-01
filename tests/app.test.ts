// The App (UI controller) driven through its ControlSurface events, with a stand-in panel.
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/ui/App';
import { createDefaultProject } from '../src/engine/defaultProject';
import { patchOf, setStepNotes, stepNotes } from '../src/engine/project';
import { fromStored, toStored } from '../src/engine/projectFile';
import { CHORD_KNOB, CHORD_NAMES } from '../src/engine/chords';
import { projectStore } from '../src/storage/projects';
import type { ControlEvent } from '../src/controls/ControlSurface';
import type { Panel } from '../src/ui/Panel';
import type { MainToWorklet } from '../src/engine/protocol';
import { deviceSettings } from '../src/storage/settings';
import { INK } from '../src/ui/screen';
import { applyTheme } from '../src/ui/colours';
import { changes, restore, snapshot } from '../src/ui/history';
import { FILL_STEPS, GLIDE_STEPS, initPatterns } from '../src/engine/project';
import start from '../src/engine/startProject.json';

/** A panel that swallows every call (the App only needs its events). */
function makeApp() {
  let handler: (e: ControlEvent) => void = () => {};
  const noop = () => {};
  /** Strip button flags as last set (`step1` -> flags on). */
  const flags = new Map<string, Set<string>>();
  /** Step lights as last set. */
  const leds: string[] = [];
  /** Button labels as last set. */
  const texts = new Map<string, string>();
  const setButtonFlag = (id: string, f: string, on: boolean) => {
    const set = flags.get(id) ?? new Set<string>();
    if (on) set.add(f); else set.delete(f);
    flags.set(id, set);
  };
  const panel = new Proxy({}, {
    get: (_t, k) => (k === 'subscribe' ? (h: (e: ControlEvent) => void) => { handler = h; return noop; }
      : k === 'root' ? { classList: { toggle: noop } } : k === 'setButtonFlag' ? setButtonFlag
      : k === 'setLed' ? (i: number, state: string) => { leds[i] = state; }
      : k === 'setButtonText' ? (id: string, html: string) => { texts.set(id, html); } : noop),
  }) as unknown as Panel;
  const sent: MainToWorklet[] = [];
  const app = new App(createDefaultProject(), panel, (m) => sent.push(m));
  const press = (id: string) => handler({ type: 'button', id, pressed: true });
  const release = (id: string) => handler({ type: 'button', id, pressed: false });
  const tap = (id: string) => { press(id); release(id); };
  const emit = (e: ControlEvent) => handler(e);
  return { app, sent, press, release, tap, flags, leds, texts, emit };
}

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k),
  };
  (globalThis as { window?: unknown }).window = globalThis;
});

describe('PAD step entry: every note with its own tie', () => {
  const padSteps = (app: App) => {
    const c = app.project.channels[5];
    return c.patterns[c.activePattern].steps;
  };
  const cursorOf = (app: App) => (app as unknown as { cursor: number[] }).cursor[5];
  /** Moves the cursor to step `to` (0-based) with ◀ / ▶. */
  const goTo = (app: App, tap: (id: string) => void, to: number) => {
    while (cursorOf(app) !== to) tap(cursorOf(app) < to ? 'cur+' : 'cur-');
  };
  /** Enters key `k` (strip button) at the cursor, tied over `steps` steps. */
  const enter = (press: (id: string) => void, release: (id: string) => void, tap: (id: string) => void, k: number, steps: number) => {
    press(`step${k}`);
    for (let i = 1; i < steps; i++) tap('cur+');
    release(`step${k}`);
  };
  const notesAt = (app: App, i: number) => stepNotes(padSteps(app)[i]);
  /** The App with the PAD's CHORD OFF (a CHORD plays one root at a time, legato = slides). */
  const padApp = () => {
    const r = makeApp();
    r.app.project.channels[5].chord = 0;
    r.app.project.chromatic = true; // the notes below count semitones
    return r;
  };

  it('A tied 1-8, C tied 9-16, then G 1-16: all three stay, each with its own length', () => {
    const { app, press, release, tap } = padApp();
    tap('mode:record');
    tap('ch6');
    enter(press, release, tap, 1, 8); // A (45) on step 1, 8 steps
    expect(cursorOf(app)).toBe(8);
    enter(press, release, tap, 4, 8); // C (48) on step 9, 8 steps
    goTo(app, tap, 0);
    enter(press, release, tap, 11, 16); // G (55) on step 1, 16 steps
    expect(notesAt(app, 0)).toEqual([{ note: 45, gate: 8 }, { note: 55, gate: 16 }]);
    expect(notesAt(app, 8)).toEqual([{ note: 48, gate: 8 }]);
  });

  it('the same key again on a step takes its note out; the last one out empties the step', () => {
    const { app, tap } = padApp();
    tap('mode:record');
    tap('ch6');
    tap('step1'); // A
    tap('cur-');
    tap('step5'); // + C#
    tap('cur-');
    tap('step1'); // A out
    expect(notesAt(app, 0)).toEqual([{ note: 49, gate: 1 }]);
    expect(cursorOf(app)).toBe(0); // taking a note out leaves the cursor where it is
    tap('step5');
    expect(padSteps(app)[0].active).toBe(false);
  });

  it('six notes at most where a note starts: the earliest-started one goes', () => {
    const { app, press, release, tap } = padApp();
    tap('mode:record');
    tap('ch6');
    // Six notes started on steps 1-6, each tied to step 16.
    for (let i = 0; i < 6; i++) { goTo(app, tap, i); enter(press, release, tap, 1 + i, 16 - i); }
    goTo(app, tap, 8);
    tap('step12'); // a seventh note on step 9: the one from step 1 (A) goes
    expect(padSteps(app)[0].active).toBe(false);
    expect([1, 2, 3, 4, 5].every((i) => padSteps(app)[i].active)).toBe(true);
    expect(notesAt(app, 8)[0].note).toBe(56);
  });

  it('six started together, a seventh: the one nearest in pitch goes', () => {
    const { app, press, release, tap } = padApp();
    tap('mode:record');
    tap('ch6');
    for (const k of [1, 3, 5, 8, 10, 12]) { press(`step${k}`); } // six keys together on step 1
    for (const k of [1, 3, 5, 8, 10, 12]) { release(`step${k}`); }
    expect(notesAt(app, 0).map((n) => n.note)).toEqual([45, 47, 49, 52, 54, 56]);
    goTo(app, tap, 0);
    tap('step7'); // 51: nearest is 52
    expect(notesAt(app, 0).map((n) => n.note).sort()).toEqual([45, 47, 49, 51, 54, 56]);
  });

  it('strip: the ring only on the note being entered, the other notes sounding at the step lit (dim)', () => {
    const { app, press, release, tap, flags } = padApp();
    const keys = (f: string) => { app.updateFrame(0); return [...flags].filter(([id, v]) => id.startsWith('step') && v.has(f)).map(([id]) => id).sort(); };
    tap('mode:record');
    tap('ch6');
    enter(press, release, tap, 1, 8); // A on step 1, 8 steps
    goTo(app, tap, 2);
    expect(keys('cursor')).toEqual([]);
    expect(keys('lit')).toEqual(['step1']); // A, tied over step 3
    press('step5'); // C# on step 3
    expect(keys('cursor')).toEqual(['step5']);
    expect(keys('lit')).toEqual(['step1']);
    release('step5');
    goTo(app, tap, 2);
    press('step8'); // E joins step 3
    expect(keys('cursor')).toEqual(['step8']);
    expect(keys('lit')).toEqual(['step1', 'step5']);
    release('step8');
  });

  it('step lights: only the steps of the note being entered, not of the notes already there', () => {
    const { app, press, release, tap, leds } = padApp();
    const lit = () => { app.updateFrame(0); return leds.flatMap((st, i) => (st === 'cursor' ? [i] : [])); };
    tap('mode:record');
    tap('ch6');
    enter(press, release, tap, 1, 8); // A on step 1, 8 steps
    goTo(app, tap, 0);
    expect(lit()).toEqual([0]);
    press('step5'); // C# joins step 1
    expect(lit()).toEqual([0]);
    tap('cur+');
    expect(lit()).toEqual([0, 1]);
    release('step5');
  });

  it('live-recorded chord notes keep their own lengths', () => {
    const { app } = padApp();
    const rec = (m: object) => app.onRecorded({ channel: 5, pattern: 0, index: 0, ...m } as Parameters<App['onRecorded']>[0]);
    rec({ type: 'recordedNote', note: 57, velocity: 0.8, accent: false, gate: 1, slide: false, start: true });
    rec({ type: 'recordedChord', note: 61, gate: 1 });
    rec({ type: 'recordedChord', note: 64, gate: 1 });
    rec({ type: 'recordedChord', note: 61, gate: 2 });
    rec({ type: 'recordedNote', note: 57, velocity: 0.8, accent: false, gate: 4, slide: false });
    rec({ type: 'recordedChord', note: 64, gate: 8 });
    expect(notesAt(app, 0)).toEqual([{ note: 57, gate: 4 }, { note: 61, gate: 2 }, { note: 64, gate: 8 }]);
  });

  it('PLUCK works the same: A 1-8, C 9-16, G 1-16 all stay', () => {
    const { app, press, release, tap } = makeApp();
    tap('mode:record');
    tap('ch8');
    const c = app.project.channels[7];
    const at = (i: number) => stepNotes(c.patterns[c.activePattern].steps[i]);
    const cur = () => (app as unknown as { cursor: number[] }).cursor[7];
    enter(press, release, tap, 1, 8);
    enter(press, release, tap, 4, 8);
    while (cur() !== 0) tap('cur-');
    enter(press, release, tap, 11, 16);
    expect(at(0).map((n) => n.gate)).toEqual([8, 16]);
    expect(at(8)).toHaveLength(1);
  });

  it('BASS still replaces the note on a step', () => {
    const { app, tap } = makeApp();
    app.project.chromatic = true;
    tap('mode:record');
    tap('ch5');
    tap('step1');
    tap('cur-');
    tap('step5');
    const c = app.project.channels[4];
    const s = c.patterns[c.activePattern].steps[0];
    expect([s.note, s.extra]).toEqual([37, undefined]);
  });
});

describe('SAVE PROJECT', () => {
  it('saving into a filled slot (tap it twice) gives it the name typed now', () => {
    const { app, tap } = makeApp();
    const saveAs = (name: string, slot: number, taps = 1) => {
      tap('saveproject');
      (app as unknown as { projMenu: { name: string[] } }).projMenu.name = [...name];
      for (let i = 0; i < taps; i++) tap(`step${slot}`);
    };
    saveAs('FIRST', 1);
    saveAs('SECOND', 2);
    saveAs('THIRD', 1, 2); // another project's slot: tap twice to overwrite
    expect(projectStore.slots().slice(0, 2).map((e) => e?.name)).toEqual(['THIRD', 'SECOND']);
    saveAs('RENAMED', 1); // its own slot: saved over, under the new name
    expect(projectStore.slots()[0]?.name).toBe('RENAMED');
  });
});

describe('PAD / PLUCK with a CHORD: one root at a time, legato slides', () => {
  it('PLAY: a key pressed while another is held slides the chord (CHORD OFF: plays both)', () => {
    for (const chord of [6, 0]) {
      const { app, sent, press, release } = makeApp();
      app.project.channels[5].chord = chord;
      press('mode:play');
      release('mode:play');
      press('ch6');
      release('ch6');
      press('step1');
      press('step5');
      const t = sent.filter((m) => m.type === 'trigger').slice(-1)[0] as { slideFrom?: number };
      expect(t.slideFrom, `chord ${chord}`).toBe(chord ? 45 : -1);
    }
  });

  it('step entry with a CHORD: a key while another is held goes on the next step', () => {
    const { app, press, tap } = makeApp();
    app.project.chromatic = true;
    tap('mode:record');
    tap('ch6');
    press('step1');
    press('step5');
    const steps = app.project.channels[5].patterns[app.project.channels[5].activePattern].steps;
    expect([steps[0].note, steps[0].extra, steps[1].note]).toEqual([45, undefined, 49]);
  });
});

describe('TEMPO', () => {
  it('stays in whole BPM: the knob lands on whole numbers, an encoder detent moves 1 BPM', () => {
    const { app, emit, sent } = makeApp();
    emit({ type: 'knob', id: 'mtempo', value: 0.3337 });
    expect(Number.isInteger(app.project.bpm)).toBe(true);
    const before = app.project.bpm;
    emit({ type: 'encoder', id: 'mtempo', delta: 1 });
    expect(app.project.bpm).toBe(before + 1);
    const tempos = sent.filter((m) => m.type === 'setGlobal' && m.id === 'bpm').map((m) => (m as { value: number }).value);
    expect(tempos.length).toBeGreaterThan(1);
    expect(tempos.every(Number.isInteger)).toBe(true);
  });
});

describe('RECORD strip: the same as PLAY', () => {
  const status = (steps: number[]) => ({ type: 'status' as const, peakL: 0, peakR: 0, frame: 0, playing: true, steps, patterns: new Array<number>(8).fill(0), barPhase: 0, barSteps: 16, songRow: -1, songBar: 0, load: 0, countIn: 0 });

  it('placing a flag while playing follows the playhead to the bar it is in', () => {
    const { app, tap, texts } = makeApp();
    const kick = app.project.channels[0];
    kick.patterns[kick.activePattern].length = 32;
    tap('mode:record');
    tap('ch1');
    tap('play');
    tap('ring');
    app.setStatus(status([20, 0, 0, 0, 0, 0, 0, 0]));
    app.updateFrame(0);
    expect(texts.get('step1')).toBe('17');
  });

  it('DESIGN follows the playhead to the bar playing too', () => {
    const { app, tap, texts } = makeApp();
    const bass = app.project.channels[4];
    bass.patterns[bass.activePattern].length = 32;
    tap('mode:design');
    tap('ch5');
    tap('play');
    app.setStatus(status([0, 0, 0, 0, 20, 0, 0, 0]));
    app.updateFrame(0);
    expect(texts.get('steppage')).toBe('BAR<small>2/2</small>');
  });

  it('SAVE / LOAD shows the slots on the strip, with nothing left over from the step view', () => {
    const { app, tap, flags } = makeApp();
    app.project.meter = 1; // 3/4: steps 13-16 dark in the step view
    tap('mode:record');
    tap('ch1');
    app.updateFrame(0);
    expect(flags.get('step13')?.has('skip')).toBe(true);
    tap('saveproject');
    app.updateFrame(0);
    expect(flags.get('step13')?.has('skip')).toBe(false);
  });
});

describe('PLAY flags carry into DESIGN', () => {
  const lastForce = (sent: MainToWorklet[], ch: number) => [...sent].reverse().find((m) => m.type === 'setForce' && m.channel === ch);

  it('SLIDE all notes stays on from PLAY into DESIGN, can be turned off there, and ends in RECORD', () => {
    const { sent, tap } = makeApp();
    tap('mode:play');
    tap('ch7');
    tap('slide');
    expect(lastForce(sent, 6)).toMatchObject({ slide: true });
    const before = sent.length;
    tap('mode:design');
    expect(sent.slice(before).some((m) => m.type === 'setForce')).toBe(false); // still on
    tap('slide');
    expect(lastForce(sent, 6)).toMatchObject({ slide: false });
    tap('ring');
    expect(lastForce(sent, 6)).toMatchObject({ ring: true });
    tap('mode:record');
    expect(lastForce(sent, 6)).toMatchObject({ ring: false, slide: false });
  });
});

describe('CLEAR + A-D and the TIME key', () => {
  it('CLEAR + the pattern being edited empties it', () => {
    const { app, press, release, tap } = makeApp();
    tap('mode:record');
    tap('ch1');
    const steps = () => app.project.channels[0].patterns[app.project.channels[0].activePattern].steps;
    tap('step1');
    expect(steps()[0].active).toBe(true);
    press('clear');
    tap('patA');
    release('clear');
    expect(steps().some((s) => s.active)).toBe(false);
    expect(app.project.channels[0].activePattern).toBe(0);
  });

  it('TIME cycles the pattern speed', () => {
    const { app, tap } = makeApp();
    tap('mode:design');
    tap('ch5');
    const pat = () => app.project.channels[4].patterns[app.project.channels[4].activePattern];
    tap('speed');
    expect(pat().speed).toBe('double');
    tap('speed');
    expect(pat().speed).toBe('half');
  });
});

describe('live knobs', () => {
  it('KICK top live knob = INT (the SOUND page\'s own value); SNARE / HAT / PERC top knobs ride FX 1: MOD, DELAY, FILTER', () => {
    const { app, sent, tap, emit } = makeApp();
    tap('mode:play');
    tap('ch1');
    tap('mode:design');
    emit({ type: 'knob', id: 'k9', value: 0.25 }); // DESIGN SOUND: INT
    tap('mode:play');
    expect((app as unknown as { targets: { get(): number }[] }).targets[0].get()).toBeCloseTo(0.25, 2); // live INT shows it
    emit({ type: 'knob', id: 'k1', value: 1 });
    expect(app.project.channels[0].sounds.kick!.intensity).toBe(1);
    emit({ type: 'knob', id: 'k2', value: 1 });
    emit({ type: 'knob', id: 'k3', value: 0.5 });
    emit({ type: 'knob', id: 'k4', value: 0 });
    expect(app.project.buses[0].mod_vol).toBe(1);
    expect(app.project.buses[0].dly_vol).toBe(0.5);
    expect(app.project.buses[0].flt).toBe(0);
    const live = (ch: number) => [...app.project.channels[ch].live, ...app.project.channels[ch].liveFunc];
    expect(live(0)).toEqual(['intensity', 'macro:decay', 'mix:volume', 'macro:air']);
    expect(live(1)).toEqual(['fx1:mod_vol', 'intensity', 'mix:volume', 'macro:air']);
    expect(live(2)).toEqual(['fx1:dly_vol', 'macro:attack', 'mix:volume', 'macro:grit']);
    expect(live(3)).toEqual(['fx1:flt', 'intensity', 'mix:volume', 'macro:grit']);
    expect(sent).toContainEqual({ type: 'setBus', bus: 0, id: 'flt', value: 0 });
  });

  it('a macro knob sits where its parameters sit: HAT ATTACK starts fully left and a full turn adds the whole range', () => {
    const { app, tap, emit, sent } = makeApp();
    tap('mode:play');
    const t = (app as unknown as { targets: { label: string; spec: { min: number; max: number }; get(): number }[] }).targets[10];
    expect(t.label).toBe('ATTACK');
    expect((t.get() - t.spec.min) / (t.spec.max - t.spec.min)).toBeCloseTo(0, 2);
    emit({ type: 'knob', id: 'k11', value: 1 });
    expect(app.project.channels[2].liveOffset['macro:attack']).toBeCloseTo(1, 1);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'setOffset', channel: 2, id: 'macro:attack' }));
  });

  it('a live knob can take every sound page parameter, the FX volumes and CHORD', () => {
    const { app } = makeApp();
    const ids = (ch: number) => (app as unknown as { liveCandidates(c: unknown): { id: string }[] }).liveCandidates(app.project.channels[ch]).map((x) => x.id);
    expect(ids(0)).toEqual(expect.arrayContaining(['rolldiv', 'fx1:mod_vol', 'fx1:dly_vol', 'fx1:flt', 'fx2:vrb_vol', 'fx3:drv_vol']));
    expect(ids(0)).not.toContain('fx1:cmp_ratio');
    expect(ids(5)).toContain('track:chord');
    expect(ids(7)).toEqual(expect.arrayContaining(['dtime', 'track:chord']));
  });
});

describe('PLAY starts from the bar shown', () => {
  const status = (steps: number[]) => ({ type: 'status' as const, peakL: 0, peakR: 0, frame: 0, playing: true, steps, patterns: new Array<number>(8).fill(0), barPhase: 0, barSteps: 16, songRow: -1, songBar: 0, load: 0, countIn: 0 });
  const lastStart = (sent: MainToWorklet[]) => sent.filter((m) => m.type === 'transport').pop() as Extract<MainToWorklet, { type: 'transport' }>;

  it('BAR picks the start bar of the selected track, also in PLAY while stopped', () => {
    const { app, sent, tap } = makeApp();
    app.project.channels[0].patterns[app.project.channels[0].activePattern].length = 64;
    tap('mode:play');
    tap('ch1');
    tap('steppage');
    tap('steppage');
    tap('play');
    expect(lastStart(sent)).toMatchObject({ playing: true, fromChannel: 0, fromStep: 32 });
  });

  it('STOP keeps the bar playing, so PLAY carries on from there', () => {
    const { app, sent, tap } = makeApp();
    app.project.channels[0].patterns[app.project.channels[0].activePattern].length = 64;
    tap('mode:play');
    tap('ch1');
    tap('play');
    app.setStatus(status([50, 2, 2, 2, 2, 2, 2, 2]));
    tap('play');
    tap('play');
    expect(lastStart(sent)).toMatchObject({ playing: true, fromStep: 48 });
  });

  it('FUNC + PLAY starts from the top and lets go of FUNC (held or latched)', () => {
    const { app, sent, tap, press, release } = makeApp();
    app.project.channels[0].patterns[app.project.channels[0].activePattern].length = 64;
    tap('mode:record');
    tap('ch1');
    tap('steppage');
    tap('func'); // latched
    tap('play');
    expect(lastStart(sent)).toMatchObject({ playing: true, fromStep: 0 });
    expect((app as unknown as { func: boolean }).func).toBe(false);
    press('func');
    tap('play'); // stop, back to the top
    release('func');
    expect((app as unknown as { func: boolean }).func).toBe(false);
    tap('play');
    expect(lastStart(sent)).toMatchObject({ playing: true, fromStep: 0 });
  });
});

describe('PROJECT page TRIM, COUNT-IN, METRONOME', () => {
  it('FUNC on the PROJECT page: RING on drum tracks, TRIM on synths; each follows a track switched to the other', () => {
    const { app, tap, press, release } = makeApp();
    const labels = () => (app as unknown as { targets: ({ label: string } | null)[] }).targets.slice(8).map((t) => t?.label);
    tap('mode:design');
    tap('dpage2');
    press('func');
    expect(labels()).toEqual(['RING 1', 'RING 2', 'RING 3', 'RING 4', 'TRIM 5', 'TRIM 6', 'TRIM 7', 'TRIM 8']);
    release('func');
    tap('menu');
    tap('step2'); // PROJECT SETTINGS
    tap('cur+'); // ▶ opens it
    tap('step1'); // TRACKS
    tap('cur+'); // ▶ opens it
    tap('step3'); // TRACK 3 (HAT)
    for (let i = 0; i < 3; i++) tap('cur+'); // HAT -> PERC -> BASS -> PAD
    tap('play');
    tap('menu'); // closed
    press('func');
    expect(labels()[2]).toBe('TRIM 3');
  });

  it('COUNT-IN goes with PLAY in RECORD only; the click follows METRONOME and the mode', () => {
    const { tap, sent } = makeApp();
    deviceSettings.countIn = 1;
    deviceSettings.metronome = 1; // RECORDING
    tap('mode:design');
    tap('play');
    expect(sent.filter((m) => m.type === 'transport').pop()).toMatchObject({ playing: true, countIn: 0 });
    tap('play');
    tap('mode:record');
    expect(sent.filter((m) => m.type === 'setClick').pop()).toMatchObject({ on: true });
    tap('play');
    expect(sent.filter((m) => m.type === 'transport').pop()).toMatchObject({ playing: true, countIn: 1 });
    tap('play');
    tap('mode:play');
    expect(sent.filter((m) => m.type === 'setClick').pop()).toMatchObject({ on: false });
    deviceSettings.countIn = 0;
    deviceSettings.metronome = 0;
  });
});

describe('MENU and CANCEL', () => {
  const page = (app: App) => app.menu?.stack[app.menu.stack.length - 1];

  it('MODE: ◀ ▶ change it on screen, PLAY saves (and goes back), CANCEL drops it', () => {
    const { app, tap, texts } = makeApp();
    tap('mode:design');
    tap('menu');
    expect(page(app)).toEqual({ page: 'top', item: 0, pending: new Map() });
    tap('cur+'); // SONG, not saved yet
    expect(app.song).toBe(false);
    tap('cancel'); // back without saving: closed
    expect(app.menu).toBeNull();
    expect(app.song).toBe(false);
    tap('menu');
    tap('cur+');
    tap('play'); // saved: SONG, the menu closes (the top page); SONG opens on PLAY
    expect(app.song).toBe(true);
    expect(app.mode).toBe('play');
    expect(app.menu).toBeNull();
    expect(app.playing).toBe(false); // PLAY in the menu is SAVE, not the transport
    app.updateFrame(0);
    expect(texts.get('menu')).toBe('MENU<small>SONG</small>');
    tap('menu');
    tap('cur-'); // JAM
    tap('play');
    expect(app.song).toBe(false);
    expect(app.mode).toBe('play'); // JAM opens on PLAY too
  });

  it('▼ / ▲ move, ▶ opens a page, CANCEL goes back a page and closes at the top', () => {
    const { app, tap } = makeApp();
    tap('menu');
    tap('oct+'); // ▲ on the first line: stays
    expect(page(app)?.item).toBe(0);
    tap('oct-'); // ▼ to PROJECT SETTINGS
    expect(page(app)?.item).toBe(1);
    tap('cur+');
    expect(page(app)?.page).toBe('project');
    tap('step1'); // TRACKS
    tap('cur+'); // ▶ opens it
    expect(page(app)?.page).toBe('tracks');
    tap('cancel');
    expect(page(app)?.page).toBe('project');
    tap('cancel');
    tap('cancel');
    expect(app.menu).toBeNull();
  });

  it('TRACKS: ◀ ▶ pick types on screen, PLAY saves them all; notes stay, locks go', () => {
    const { app, tap, sent } = makeApp();
    const snare = app.project.channels[1];
    const hat = app.project.channels[2];
    snare.patterns[0].steps[4].active = true;
    snare.patterns[0].steps[4].locks = { decay: 0.3 };
    tap('menu');
    tap('step2'); // PROJECT SETTINGS
    tap('cur+'); // ▶ opens it
    tap('step1'); // TRACKS
    tap('cur+'); // ▶ opens it
    tap('oct-'); // TRACK 2
    tap('cur+'); // SNARE -> HAT, on screen only
    tap('oct-'); // TRACK 3
    tap('cur-'); // HAT -> SNARE
    expect(snare.instrument).toBe('snare');
    tap('play');
    expect(snare.instrument).toBe('hat');
    expect(hat.instrument).toBe('snare');
    expect(page(app)?.page).toBe('project'); // back a page
    expect(snare.patterns[0].steps[4].active).toBe(true);
    expect(snare.patterns[0].steps[4].locks).toBeUndefined();
    expect(sent).toContainEqual(expect.objectContaining({ type: 'setInstrument', channel: 1, kind: 'hat' }));
    // Changed, then CANCEL: nothing saved.
    tap('step1');
    tap('cur+');
    tap('cancel');
    expect(app.project.channels[0].instrument).toBe('kick');
  });

  it('GLOBAL SETTINGS > TOUCH SETTINGS: ◀ ▶ and knob 1 change device settings, PLAY saves them to storage', () => {
    const { app, tap, emit } = makeApp();
    tap('menu');
    tap('step3'); // GLOBAL SETTINGS
    tap('cur+'); // ▶ opens it
    tap('step6'); // TOUCH SETTINGS
    tap('cur+'); // ▶ opens it
    expect(page(app)?.page).toBe('touch');
    expect(deviceSettings.knobSpeed).toBe(1);
    tap('cur+'); // KNOB SPEED: FAST (on screen)
    tap('cur+'); // already the last choice
    tap('oct-');
    tap('oct-'); // TOUCH DELAY
    emit({ type: 'knob', id: 'k1', value: 0 });
    expect(deviceSettings.knobSpeed).toBe(1);
    tap('play');
    expect(deviceSettings.knobSpeed).toBe(2);
    expect(deviceSettings.touchDelay).toBe(0);
    expect(JSON.parse(localStorage.getItem('groovebox.device') ?? '{}').knobSpeed).toBe(2);
    deviceSettings.knobSpeed = 1;
    deviceSettings.touchDelay = 3;
  });

  it('GLOBAL SETTINGS > THEME: CLASSIC first (the first look); a pick shows at once, CANCEL goes back; COLOUR = FX knobs in alternating pairs', () => {
    const { app, tap } = makeApp();
    const colour = (slot: number) => (app as unknown as { knobColour(t: unknown): string; targets: unknown[] }).knobColour((app as unknown as { targets: unknown[] }).targets[slot]);
    expect(deviceSettings.theme).toBe(0); // CLASSIC at HIGH
    expect(INK.warn).toBe('#e8b53a');
    expect(colour(0)).toBe('#3cc8b4');
    tap('menu');
    tap('step3'); // GLOBAL SETTINGS
    tap('cur+');
    tap('step7'); // THEME
    tap('cur+'); // COLOUR, not saved yet: shown at once
    expect(deviceSettings.theme).toBe(0);
    expect(INK.warn).toBe('#ffffff');
    tap('cancel'); // back to the saved look
    expect(INK.warn).toBe('#e8b53a');
    tap('cur+'); // GLOBAL SETTINGS again
    tap('step7');
    tap('cur+'); // COLOUR
    tap('oct-'); // SATURATION
    tap('cur-'); // MEDIUM
    tap('play'); // saved
    expect(deviceSettings.theme).toBe(1);
    expect(deviceSettings.saturation).toBe(1);
    expect(INK.warn).toBe('#ffffff');
    tap('menu'); // closed
    tap('fx2'); // FX 2's knobs: modules 1-2 one colour, 3-4 the other, 5-6 the first again
    expect(colour(0)).toBe(colour(1));
    expect(colour(2)).not.toBe(colour(0));
    expect(colour(4)).toBe(colour(0));
    expect(colour(14)).toBe(colour(2));
    tap('fx2');
    // INVERT: hues turned half way round (CLASSIC: gold -> blue); MONO ignores it.
    Object.assign(deviceSettings, { theme: 0, saturation: 2, invert: 1 });
    applyTheme();
    expect(INK.warn).toMatch(/^#[0-5][0-9a-f][0-9a-f]{2}[c-f][0-9a-f]$/); // blue
    deviceSettings.theme = 2;
    applyTheme();
    expect(INK.warn).toBe('#f4f7fa');
    Object.assign(deviceSettings, { theme: 0, saturation: 2, invert: 0 });
    applyTheme();
    expect(INK.warn).toBe('#e8b53a');
  });

  it('CANCEL (lit when something is pending) leaves the SAVE / LOAD screen; UNDO is its own key (REDO with FUNC); neither touches views', () => {
    const { app, tap, texts } = makeApp();
    const priv = app as unknown as { fxView: number; message: string; cancelShows: boolean };
    tap('saveproject');
    expect(priv.cancelShows).toBe(true); // CANCEL lit
    tap('cancel');
    expect(app.projMenu).toBeNull();
    expect(priv.cancelShows).toBe(false);
    tap('cancel'); // nothing pending
    expect(priv.message).toBe('NOTHING TO CANCEL');
    expect(texts.get('undo')).toBe('UNDO');
    tap('func'); // latched
    expect(texts.get('undo')).toBe('REDO');
    tap('func');
    tap('fx2');
    tap('cancel');
    tap('undo');
    expect(priv.fxView).toBe(2);
  });

  it('a mode button closes MENU and goes there', () => {
    const { app, tap } = makeApp();
    tap('menu');
    tap('mode:play');
    expect(app.menu).toBeNull();
    expect(app.mode).toBe('play');
  });
});

describe('SONG never changes a pattern', () => {
  const songMode = (mode: string) => {
    const r = makeApp();
    r.tap('menu');
    r.tap('cur+'); // MODE: SONG
    r.tap('play');
    r.tap(mode);
    return r;
  };

  it('CLEAR, COPY, TIME, STEPS and FUNC + OCT leave the patterns alone in SONG PLAY / DESIGN', () => {
    for (const mode of ['mode:play', 'mode:record']) {
      const { app, tap, press, release } = songMode(mode);
      const c = app.project.channels[4];
      tap('ch5');
      c.patterns[0].steps[2].active = true;
      const before = JSON.stringify(app.project.channels.map((x) => [x.patterns, x.sounds]));
      press('clear');
      tap('ch5');
      tap('patA');
      tap('step3');
      release('clear');
      press('copy');
      tap('ch6');
      tap('patB');
      tap('steppage');
      release('copy');
      tap('speed');
      press('len');
      tap('cur+');
      release('len');
      press('func');
      tap('oct+');
      release('func');
      expect(JSON.stringify(app.project.channels.map((x) => [x.patterns, x.sounds]))).toBe(before);
    }
  });

  it('the page buttons name what the knobs show in every SONG mode (SONG PLAY: SOUND = live knobs, MIX = the mixer)', () => {
    const labels = (app: App) => (app as unknown as { targets: ({ label: string } | null)[] }).targets.map((t) => t?.label ?? '');
    const play = songMode('mode:play');
    expect([play.texts.get('dpage0'), play.texts.get('dpage1')]).toEqual(['SOUND', 'MIX']);
    play.tap('dpage1');
    expect(labels(play.app).slice(0, 8)).toEqual(['VOL 1', 'VOL 2', 'VOL 3', 'VOL 4', 'VOL 5', 'VOL 6', 'VOL 7', 'VOL 8']);
    play.tap('dpage0');
    expect(labels(play.app)).not.toContain('VOL 1');
    const rec = songMode('mode:record');
    expect([rec.texts.get('dpage0'), rec.texts.get('dpage1'), rec.texts.get('dpage2')]).toEqual(['LIVE', 'SOUND', 'MIX']);
    const design = songMode('mode:design');
    expect([design.texts.get('dpage0'), design.texts.get('dpage1'), design.texts.get('dpage2')]).toEqual(['', '', '']);
  });

  it('SONG RECORD SOUND knobs are heard, not kept: the pattern keeps its patch, which comes back on a mode change', () => {
    const { app, tap, emit, sent } = songMode('mode:record');
    tap('ch5'); // BASS SOUND page
    const c = app.project.channels[4];
    const ts = (app as unknown as { targets: ({ label: string; get(): number } | null)[] }).targets;
    const k = ts.findIndex((t) => t?.label === 'CUTOFF');
    const was = c.sounds.bass!.cutoff;
    emit({ type: 'knob', id: `k${k + 1}`, value: 0.1 });
    expect(c.sounds.bass!.cutoff).toBe(was);
    expect(c.patterns[0].patchDirty).toBeFalsy();
    expect(ts[k]!.get()).not.toBe(was); // the knob shows what is heard
    expect(sent.filter((m) => m.type === 'setSound' && m.channel === 4 && m.id === 'cutoff').pop()).toMatchObject({ value: ts[k]!.get() });
    tap('mode:play');
    expect(sent.filter((m) => m.type === 'setPatch' && m.channel === 4).pop()).toMatchObject({ sound: { cutoff: was } });
  });
});

describe('A-D', () => {
  it('FUNC + A-D is plain A-D (every track); held channels keep their pattern (KEEP HELD, the default)', () => {
    const { app, tap, press, release } = makeApp();
    const pats = () => app.project.channels.map((c) => c.activePattern).join('');
    press('func');
    tap('patB');
    release('func');
    expect(pats()).toBe('11111111');
    press('ch3');
    press('ch5');
    tap('patC');
    release('ch5');
    release('ch3');
    expect(pats()).toBe('22121222');
  });

  it('HOLD + PATTERN SWITCH HELD (here the project\'s own): only the held channels switch', () => {
    const { app, tap, press, release } = makeApp();
    app.project.settings = { holdPattern: 1 };
    press('ch3');
    tap('patC');
    release('ch3');
    expect(app.project.channels.map((c) => c.activePattern).join('')).toBe('00200000');
  });
});

describe('changed knobs', () => {
  it('every knob of a new project sits on its saved value; a turned one (TIMBRE too) does not', () => {
    const { app, tap, emit } = makeApp();
    type T = { label: string; get(): number; base?(): number; spec: { defaultValue: number } } | null;
    const targets = () => (app as unknown as { targets: T[] }).targets;
    const off = () => targets().filter((t) => t && Math.abs(t.get() - (t.base?.() ?? t.spec.defaultValue)) > 1e-9).map((t) => t!.label);
    tap('mode:design');
    for (let ch = 1; ch <= 8; ch++) {
      tap(`ch${ch}`);
      expect(off()).toEqual([]);
    }
    for (const page of ['dpage1', 'dpage2', 'fx1', 'fx2', 'fx3', 'fx4']) {
      tap(page);
      expect(off()).toEqual([]);
    }
    tap('dpage0');
    tap('ch5');
    emit({ type: 'knob', id: 'k14', value: 0.1 }); // BASS CUTOFF
    expect(off()).toHaveLength(1);
    emit({ type: 'knob', id: 'k1', value: 0.9 }); // TIMBRE counts too
    expect(off()).toContain('TIMBRE');
  });
});

describe('RESET with buttons held', () => {
  const glide = (app: App) => (app as unknown as { stepGlides(n: number): void }).stepGlides(performance.now() + 10);

  it('a held track keeps its own settings and the FX knobs its live knobs move (PLAY: HAT LIVE 1 = FX1:DELAY)', () => {
    const { app, tap, press, release, emit } = makeApp();
    tap('mode:play');
    tap('ch1');
    emit({ type: 'knob', id: 'k3', value: 0.9 }); // HAT FX1:DELAY
    emit({ type: 'knob', id: 'k11', value: 0.9 }); // HAT ATTACK
    emit({ type: 'knob', id: 'k2', value: 0.1 }); // SNARE LIVE 1 = FX1:MOD
    const dly = app.project.buses[0].dly_vol;
    press('ch3');
    tap('reset');
    release('ch3');
    glide(app);
    expect(app.project.buses[0].dly_vol).toBe(dly);
    expect(app.project.channels[2].liveOffset['macro:attack']).toBeGreaterThan(0);
    expect(app.project.buses[0].mod_vol).toBe(createDefaultProject().buses[0].mod_vol); // SNARE's: reset
    expect(app.selected).toBe(0);
  });

  it('a held FX / LFO button keeps that bus / the LFO, and its view stays as it was', () => {
    const { app, tap, press, release, emit } = makeApp();
    const priv = app as unknown as { fxView: number };
    tap('mode:design');
    tap('fx2');
    emit({ type: 'knob', id: 'k1', value: 0.7 });
    tap('fx4');
    emit({ type: 'knob', id: 'k1', value: 0.7 });
    tap('fx4'); // back to the pages
    const fx2 = JSON.stringify(app.project.buses[1]);
    const lfo = JSON.stringify(app.project.lfo);
    press('fx2');
    press('fx4');
    tap('reset');
    release('fx2');
    release('fx4');
    glide(app);
    expect(JSON.stringify(app.project.buses[1])).toBe(fx2);
    expect(JSON.stringify(app.project.lfo)).toBe(lfo);
    expect(priv.fxView).toBe(0);
    tap('reset'); // nothing held: both go back
    glide(app);
    expect(JSON.stringify(app.project.lfo)).not.toBe(lfo);
  });
});

describe('HOLD + RESET and project settings', () => {
  const glide = (app: App) => (app as unknown as { stepGlides(n: number): void }).stepGlides(performance.now() + 10);

  it('RESET HELD: only the held track (with its FX knob) and the held bus reset; the rest stay', () => {
    const { app, tap, press, release, emit } = makeApp();
    app.project.settings = { holdReset: 1 };
    tap('mode:play');
    emit({ type: 'knob', id: 'k3', value: 0.9 }); // HAT FX1:DELAY
    emit({ type: 'knob', id: 'k9', value: 0.9 }); // KICK DECAY
    tap('mode:design');
    tap('dpage1'); // MIX
    emit({ type: 'knob', id: 'k1', value: 0.2 }); // KICK VOLUME
    emit({ type: 'knob', id: 'k2', value: 0.2 }); // SNARE VOLUME
    tap('fx2');
    emit({ type: 'knob', id: 'k1', value: 0.7 });
    emit({ type: 'knob', id: 'k3', value: 0.2 }); // HAT VOLUME
    tap('fx2');
    const kick = app.project.channels[0].volume;
    const fx2 = JSON.stringify(app.project.buses[1]);
    press('ch3');
    tap('reset');
    release('ch3');
    glide(app);
    const fresh = createDefaultProject();
    expect(app.project.channels[2].volume).toBe(fresh.channels[2].volume);
    expect(app.project.buses[0].dly_vol).toBe(fresh.buses[0].dly_vol);
    expect(app.project.channels[0].volume).toBe(kick);
    expect(app.project.channels[0].liveOffset['macro:decay']).toBeGreaterThan(0);
    expect(JSON.stringify(app.project.buses[1])).toBe(fx2);
  });

  it('a project setting overrides GLOBAL; DEFAULT follows it; it is saved with the project', () => {
    const { app, tap, sent } = makeApp();
    deviceSettings.countIn = 2;
    tap('menu');
    tap('step2'); // PROJECT SETTINGS
    tap('cur+'); // ▶ opens it
    tap('oct-'); // COUNT-IN
    tap('cur+'); // DEFAULT -> OFF
    tap('play');
    expect(app.project.settings?.countIn).toBe(0);
    tap('menu'); // closed
    tap('mode:record');
    tap('play');
    expect(sent.filter((m) => m.type === 'transport').pop()).toMatchObject({ countIn: 0 });
    tap('play');
    delete app.project.settings!.countIn; // DEFAULT
    tap('play');
    expect(sent.filter((m) => m.type === 'transport').pop()).toMatchObject({ countIn: 2 });
    tap('play');
    deviceSettings.countIn = 0;
    const p = createDefaultProject();
    p.settings = { metronome: 2 };
    expect(fromStored(toStored(p))!.settings).toEqual({ metronome: 2 });
  });
});

describe('SONG DESIGN: the song strip', () => {
  const strip = () => {
    const r = makeApp();
    r.app.project.channels[0].patterns[1].length = 48; // KICK B: 3 bars
    r.tap('menu');
    r.tap('cur+'); // MODE: SONG
    r.tap('play'); // (SONG opens on PLAY)
    r.tap('mode:design'); // the strip
    r.app.project.song.rows = []; // (SONG starts with a row of A on every track)
    r.tap('ch1');
    return r;
  };
  const rows = (app: App) => app.project.song.rows.map((r) => ({ bars: r.bars, p: r.patterns[0], q: r.patterns[1], k: r.keep ? [r.keep[0], r.keep[1]] : undefined }));

  it('A-D put a pattern on the cursor bar as long as it lasts (a tie), the cursor moving past it', () => {
    const { app, tap, flags } = strip();
    expect(app.songGrid).toBe(true);
    tap('patB');
    tap('patA');
    expect(rows(app)).toEqual([{ bars: 3, p: 1, q: -1, k: undefined }, { bars: 1, p: 0, q: -1, k: undefined }]);
    app.updateFrame(0);
    expect([...flags.get('step1')!]).toContain('lit');
    expect([...flags.get('step2')!]).toContain('tie');
    expect([...flags.get('step3')!]).toContain('tie');
    expect([...flags.get('step4')!]).toContain('lit');
    expect([...flags.get('step5')!]).toContain('cursor');
  });

  it('another track\'s clip across a row line keeps playing (keep); STEP EDIT ◀ ▶ = length, never past the pattern', () => {
    const { app, tap } = strip();
    tap('patB'); // 1: B over bars 1-3
    tap('ch2');
    tap('cur-'); tap('cur-');
    tap('patA'); // 2: A on bar 2 (1 bar)
    expect(rows(app)).toEqual([
      { bars: 1, p: 1, q: -1, k: undefined },
      { bars: 1, p: 1, q: 0, k: [1, 0] },
      { bars: 1, p: 1, q: -1, k: [1, 0] },
    ]);
    tap('ch1');
    tap('stepedit');
    tap('step2'); // the clip under it
    tap('cur-');
    expect(rows(app)).toEqual([{ bars: 1, p: 1, q: -1, k: undefined }, { bars: 1, p: 1, q: 0, k: [1, 0] }]);
    tap('cur+');
    tap('cur+'); // 3 bars is all B has
    expect(rows(app).reduce((n, r) => n + r.bars, 0)).toBe(3);
  });

  it('REST and CLEAR + step empty bars; PLAY starts from the page shown', () => {
    const { app, tap, press, release, sent } = strip();
    tap('patB');
    tap('step2');
    tap('rest'); // B now ends after bar 1
    expect(rows(app)).toEqual([{ bars: 1, p: 1, q: -1, k: undefined }]);
    press('clear');
    tap('step1');
    release('clear');
    expect(app.project.song.rows).toEqual([]);
    tap('step1');
    for (let i = 0; i < 17; i++) tap('patA'); // bars 1-17: the cursor on bar 18, page 2
    tap('play');
    const t = sent.filter((m) => m.type === 'transport').pop() as Extract<MainToWorklet, { type: 'transport' }>;
    expect(t).toMatchObject({ playing: true, song: true, fromRow: 16, fromBar: 0 }); // one row per clip
    tap('play');
    tap('steppage'); // page 1 again
    tap('play');
    expect(sent.filter((m) => m.type === 'transport').pop()).toMatchObject({ fromRow: 0, fromBar: 0 });
  });
});

describe('STRIP key: keys / steps on the strip', () => {
  const steps = (app: App, ch: number) => app.project.channels[ch].patterns[app.project.channels[ch].activePattern].steps;

  it('a keyboard track shows steps: a tap paints the strip\'s lowest note, a tie over it ends there, a tap again erases', () => {
    const { app, tap, press, release, texts } = makeApp();
    tap('mode:record');
    tap('ch5');
    press('step8'); // BASS: a note at step 1, tied over 8 steps
    for (let i = 1; i < 8; i++) tap('cur+');
    release('step8');
    tap('view');
    expect(texts.get('view')).toContain('STEPS');
    tap('step5');
    expect(steps(app, 4)[4]).toMatchObject({ active: true, note: 33, gate: 1 }); // A1, not the A2 before it
    expect(steps(app, 4)[0].gate).toBe(4);
    tap('step5');
    expect(steps(app, 4)[4].active).toBe(false);
    tap('view');
    expect(texts.get('view')).toContain('KEYS');
  });

  it('a drum track shows keys: tuned hits at the cursor, which moves on', () => {
    const { app, tap } = makeApp();
    tap('mode:record');
    tap('ch1');
    tap('view');
    tap('step3');
    tap('step1');
    const s = steps(app, 0);
    expect(s[0].active && s[1].active).toBe(true);
    expect(s[0].note - s[1].note).toBe(2);
  });
});

describe('CHORD knob', () => {
  it('runs in groups, KEY last in each: MIN7, then DOM7, then KEY7', () => {
    const { app, tap, emit } = makeApp();
    tap('mode:design');
    tap('ch6'); // PAD: CHORD on module 8's top knob
    const at = (name: string) => CHORD_KNOB.indexOf(CHORD_NAMES.indexOf(name)) / (CHORD_KNOB.length - 1);
    emit({ type: 'knob', id: 'k8', value: at('KEY7') });
    expect(CHORD_NAMES[app.project.channels[5].chord]).toBe('KEY7');
    emit({ type: 'knob', id: 'k8', value: at('DOM7') });
    expect(CHORD_NAMES[app.project.channels[5].chord]).toBe('DOM7');
  });
});

describe('COPY: hold COPY, tap what, then where', () => {
  const copyView = (app: App) => app.copyView();

  it('a step: COPY + a step, then other steps get copies (notes, flags, locks; STEPS on / off stays theirs); the screen shows it large', () => {
    const { app, tap, press, release, flags } = makeApp();
    tap('mode:record');
    tap('ch5');
    const steps = app.project.channels[4].patterns[0].steps;
    Object.assign(steps[0], { active: true, note: 40, gate: 2, slide: true, locks: { cutoff: 900 } });
    steps[5].flip = true;
    press('copy');
    expect(app.copyShowing).toBe(true);
    expect(copyView(app).title).toBe('COPY');
    tap('step1');
    expect(copyView(app).title).toBe('COPY STEP 1');
    app.updateFrame(0);
    expect(flags.get('step1')?.has('cursor')).toBe(true); // the strip shows steps, the source yellow
    tap('step4');
    tap('step6');
    expect(copyView(app).done).toBe('> STEP 4 / STEP 6');
    release('copy');
    expect(app.copyShowing).toBe(false);
    for (const i of [3, 5]) expect(steps[i]).toMatchObject({ active: true, note: 40, gate: 2, slide: true, locks: { cutoff: 900 } });
    expect(steps[5].flip).toBe(true);
    expect(steps[3].flip).toBeUndefined();
    expect(steps[3]).not.toBe(steps[0]);
  });

  it('a bar: COPY + BAR, the track keys are the bars (yellow = this one, lit = the pattern has it); an unlit one grows the pattern', () => {
    const { app, tap, press, release, flags, texts } = makeApp();
    tap('mode:record');
    tap('ch1');
    const pat = app.project.channels[0].patterns[0];
    pat.steps[0].active = true;
    pat.steps[4].active = true;
    pat.steps[4].accent = true;
    pat.steps[13].flip = true;
    pat.length = 32;
    pat.steps[16].active = true;
    pat.steps[20].active = true;
    press('copy');
    tap('steppage');
    expect(app.copyView().title).toBe('COPY BAR 1');
    expect(flags.get('ch1')?.has('cursor')).toBe(true);
    expect(texts.get('ch3')).toBe('3<small>BAR</small>');
    tap('ch2'); // over bar 2 (its hits replaced: empty steps too)
    tap('ch4'); // past the end: grows to 4 bars, bar 3 empty
    release('copy');
    expect(pat.length).toBe(64);
    expect(pat.steps.slice(16, 32).map((st) => st.active)).toEqual(pat.steps.slice(0, 16).map((st) => st.active));
    expect(pat.steps[20].accent).toBe(true);
    expect(pat.steps[29].flip).toBe(true);
    expect(pat.steps.slice(32, 48).every((st) => !st.active)).toBe(true);
    expect(pat.steps[48].active).toBe(true);
    expect(flags.get('ch1')?.has('cursor')).toBe(false);
    expect(texts.get('ch1')).toBe('1<small>KICK</small>');
  });

  it('a pattern: COPY + A-D (or a track), then A-D = that pattern of the track, a track = its pattern of that letter; CANCEL picks again', () => {
    const { app, tap, press, release } = makeApp();
    tap('mode:record');
    tap('ch1');
    const kick = app.project.channels[0];
    kick.patterns[0].steps[2].active = true;
    press('copy');
    tap('patA');
    expect(app.copyView().title).toBe('COPY PATTERN A');
    tap('patC');
    expect(kick.patterns[2].steps[2].active).toBe(true);
    tap('cancel');
    expect(app.copyView().title).toBe('COPY');
    tap('ch1'); // track 1's pattern (A)
    tap('ch7'); // LEAD's A
    release('copy');
    expect(app.project.channels[6].patterns[0].steps[2]).toMatchObject({ active: true, note: 45 });
  });

  it('onto an empty pattern the sound comes too; onto one with notes only the notes', () => {
    const { app, tap, press, release } = makeApp();
    tap('mode:record');
    tap('ch5');
    const c = app.project.channels[4];
    c.sounds.bass!.cutoff = 321;
    c.patterns[0].steps[0].active = true;
    c.patterns[2].steps[5].active = true; // C has notes
    const soundC = patchOf(c, 2).sound.cutoff;
    press('copy');
    tap('patA');
    tap('patB'); // B empty: notes and sound
    tap('patC'); // C: notes only
    release('copy');
    expect(patchOf(c, 1).sound.cutoff).toBe(321);
    expect(c.patterns[1].steps[0].active).toBe(true);
    expect(patchOf(c, 2).sound.cutoff).toBe(soundC);
  });

});

describe('REST and ties', () => {
  it('REST on a tied-over step ends the tie there (the rest shows); a tie grown over a rest takes it away', () => {
    const { app, tap } = makeApp();
    tap('mode:record');
    tap('ch7'); // LEAD
    const steps = app.project.channels[6].patterns[0].steps;
    Object.assign(steps[0], { active: true, note: 57, gate: 4, slide: true });
    const cursor = () => (app as unknown as { cursor: number[] }).cursor[6];
    while (cursor() !== 2) tap(cursor() < 2 ? 'cur+' : 'cur-');
    tap('rest'); // on step 3, under the tie
    expect(steps[0].gate).toBe(2);
    expect(steps[2].rest).toBe(true);
  });
});

describe('STEP EDIT: ties', () => {
  it('the strip shows the steps (notes, ties); ◀ ▶ make the primed note a step longer / shorter, shown as a tie (a longer tie clears what it covers)', () => {
    const { app, tap, flags, leds } = makeApp();
    tap('mode:record');
    tap('ch5'); // BASS
    const steps = app.project.channels[4].patterns[0].steps;
    Object.assign(steps[0], { active: true, note: 40, gate: 1, accent: true });
    Object.assign(steps[2], { active: true, note: 45, gate: 1 });
    tap('stepedit'); // step 1 primed
    app.updateFrame(0);
    expect(flags.get('step1')?.has('lit')).toBe(true);
    expect(flags.get('step1')?.has('accent')).toBe(true);
    expect(flags.get('step3')?.has('lit')).toBe(true);
    tap('cur+');
    expect(steps[0].gate).toBe(2);
    app.updateFrame(0);
    expect(flags.get('step2')?.has('tie')).toBe(true); // shown on the strip
    expect(leds.slice(0, 3)).toEqual(['cursor', 'cursor', '']);
    tap('cur+'); // over step 3: its note goes
    expect(steps[0].gate).toBe(3);
    expect(steps[2].active).toBe(false);
    tap('cur-');
    expect(steps[0].gate).toBe(2);
    tap('step2'); // a tied-over step: ◀ ▶ work on the note tied over it
    tap('cur+');
    expect(steps[0].gate).toBe(3);
    tap('step5'); // nothing there
    tap('cur+');
    expect(steps[4].active).toBe(false);
    expect((app as unknown as { message: string }).message).toBe('NO NOTE HERE: TAP A NOTE');
  });

  it('PAD: every note on the primed step gets a step longer, each by its own length', () => {
    const { app, tap } = makeApp();
    tap('mode:record');
    tap('ch6'); // PAD
    const c = app.project.channels[5];
    c.chord = 0;
    const steps = c.patterns[0].steps;
    setStepNotes(steps[0], [{ note: 57, gate: 1 }, { note: 60, gate: 3 }]);
    tap('stepedit');
    tap('cur+');
    expect(stepNotes(steps[0]).map((n) => n.gate)).toEqual([2, 4]);
  });
});

describe('SONG strip: GLIDE and FILL windows on the screen', () => {
  it('each clip start carries its glide (from another pattern, reach limited) and fill windows', () => {
    const { app } = makeApp();
    const a = app as unknown as { laneEntries(lane: unknown[], ch: number): { at: number; glide?: number[]; fill?: number[] }[]; clips(): unknown[][] };
    app.project.song = { rows: [
      { bars: 2, patterns: [0, -1, -1, -1, -1, -1, -1, -1] },
      { bars: 1, patterns: [1, -1, -1, -1, -1, -1, -1, -1], entry: [{ glideStart: -48, glideEnd: 8, fill: 2, fillLen: 6 }, null, null, null, null, null, null, null] },
      { bars: 1, patterns: [1, -1, -1, -1, -1, -1, -1, -1] },
      { bars: 1, patterns: [-1, -1, -1, -1, -1, -1, -1, -1] },
      { bars: 1, patterns: [0, -1, -1, -1, -1, -1, -1, -1], entry: [{ fill: 1, fillLen: 32 }, null, null, null, null, null, null, null] },
    ] };
    const lane = a.laneEntries(a.clips()[0], 0);
    expect(lane.map((c) => c.at)).toEqual([0, 1, 2, 3, 5]); // A loops in its 2-bar row
    expect(lane[0].glide).toBeUndefined(); // the song's first clip
    expect(lane[1].glide).toBeUndefined(); // a loop inside its row: no clip start
    expect(lane[2]).toMatchObject({ glide: [0, 40], fill: [26, 32] }); // reach back: to the row before's start (bar 1)
    expect(lane[3].glide).toBeUndefined(); // B again: no glide
    expect(lane[4]).toMatchObject({ glide: [80 - 16, 80], fill: [64, 80] }); // after an empty bar: from where the lane changed
  });
});

describe('SCALE key', () => {
  const notes = (app: App) => app.project.channels[4].patterns[0].steps.map((st) => st.note);
  const black = (flags: Map<string, Set<string>>, k: number) => flags.get(`step${k}`)!.has('black');

  it('the strip is a keyboard up from the root, black = off A minor; SCALE + ◀ ▶ moves the root, a tap = piano colours', () => {
    const { app, tap, press, release, texts, flags } = makeApp();
    tap('mode:record');
    tap('ch5'); // BASS, octave A1 (33)
    for (const k of [1, 2, 3, 8]) tap(`step${k}`);
    expect(notes(app).slice(0, 4)).toEqual([33, 34, 35, 40]); // A A# B E
    app.updateFrame(0);
    expect(texts.get('scale')).toContain('A MIN');
    expect([1, 2, 3, 4].map((k) => black(flags, k))).toEqual([false, true, false, false]); // A A# B C
    press('scale');
    tap('cur+');
    release('scale');
    expect(app.project.root).toBe(10);
    tap('step1');
    expect(notes(app)[4]).toBe(34); // A#
    app.updateFrame(0);
    expect([1, 2, 3, 4].map((k) => black(flags, k))).toEqual([false, true, false, false]); // A# B C C#: B is off A# minor
    tap('scale'); // a tap: a piano's colours
    app.updateFrame(0);
    expect([1, 2, 3, 4].map((k) => black(flags, k))).toEqual([true, false, false, true]);
    expect(fromStored(toStored(app.project))).toMatchObject({ root: 10, chromatic: true });
  });

  it('the STRIP view is the same in every mode: a drum shows steps in PLAY, keys once switched', () => {
    const { app, tap, flags } = makeApp();
    tap('mode:play');
    tap('ch1');
    tap('step3'); // steps: a hit on step 3
    expect(app.project.channels[0].patterns[0].steps[2].active).toBe(true);
    tap('view');
    tap('mode:record');
    app.updateFrame(0);
    expect(flags.get('step2')!.has('black')).toBe(true); // keys here too
  });
});


describe('SONG over RECORD / PLAY / DESIGN', () => {
  const song = () => {
    const r = makeApp();
    r.tap('menu');
    r.tap('cur+'); // MODE: SONG
    r.tap('play'); // (SONG opens on PLAY)
    r.tap('mode:design'); // the grid
    return r;
  };
  const lastTransport = (sent: MainToWorklet[]) => sent.filter((m) => m.type === 'transport').pop() as Extract<MainToWorklet, { type: 'transport' }>;

  it('DESIGN is the song strip; PLAY and RECORD play the song with their usual pages', () => {
    const { app, tap, sent } = song();
    expect(app.songGrid).toBe(true);
    tap('mode:record');
    expect(app.songGrid).toBe(false);
    tap('play');
    expect(lastTransport(sent)).toMatchObject({ playing: true, song: true, fromRow: 0, fromBar: 0 });
    tap('play');
    tap('mode:play');
    tap('play');
    expect(lastTransport(sent)).toMatchObject({ playing: true, song: true });
  });

  it('STOP keeps the row and bar playing, so PLAY carries on there', () => {
    const { app, tap, sent } = song(); // one row of 4 bars
    tap('play');
    app.setStatus({ type: 'status', peakL: 0, peakR: 0, frame: 0, playing: true, steps: new Array<number>(8).fill(0), patterns: new Array<number>(8).fill(0), barPhase: 0, barSteps: 16, songRow: 0, songBar: 2, load: 0, countIn: 0 });
    tap('play');
    tap('play');
    expect(lastTransport(sent)).toMatchObject({ fromRow: 0, fromBar: 2 });
  });
});

describe('SONG RECORD step entry', () => {
  const songDesign = () => {
    const r = makeApp();
    r.tap('menu');
    r.tap('cur+'); // MODE: SONG
    r.tap('play');
    r.tap('mode:record');
    return r;
  };
  const targets = (app: App) => (app as unknown as { targets: ({ label: string; get(): number; staged?: boolean; auto?: { key: string } } | null)[] }).targets;

  it('SONG RECORD pages are LIVE / SOUND / MIX; a channel tap opens SOUND', () => {
    const { app, tap } = songDesign();
    expect((app as unknown as { pageNames(): string[] }).pageNames()).toEqual(['LIVE', 'SOUND', 'MIX']);
    tap('ch5');
    expect(app.designPage).toBe(1);
  });

  it('tap a step = primed; touched knobs (turned or not) lock there on the second tap; the knobs go back meanwhile', () => {
    const { app, tap, emit } = songDesign();
    tap('dpage2'); // MIX
    const volume = app.project.channels[0].volume;
    tap('step5'); // prime bar 1 step 5
    emit({ type: 'touch', id: 'k1' }); // KICK VOLUME, unturned
    emit({ type: 'touch', id: 'k10' }); // SNARE PAN
    emit({ type: 'knob', id: 'k10', value: 1 }); // turned right (auditioned)
    expect(targets(app)[0]?.staged).toBe(true);
    expect(app.project.channels[1].pan).toBe(1);
    tap('step5'); // lock
    expect(app.project.song.auto).toEqual({ 'm:0:volume': [[4, volume]], 'm:1:pan': [[4, 1]] });
    expect(app.project.channels[1].pan).toBe(0); // back to its own value
  });

  it('CANCEL leaves a primed step unlocked; CLEAR + step and CLEAR + touch take locks away; FUNC + tap locks the whole page', () => {
    const { app, tap, press, release, emit } = songDesign();
    tap('dpage2');
    tap('step1');
    emit({ type: 'knob', id: 'k1', value: 0.2 });
    tap('cancel');
    expect(app.project.song.auto ?? {}).toEqual({});
    expect(app.project.channels[0].volume).toBe(createDefaultProject().channels[0].volume);
    tap('step1');
    press('func');
    tap('step1'); // FUNC + tap: every knob on the page (its FUNC layer: SEND / MID CUT)
    expect(Object.keys(app.project.song.auto!)).toHaveLength(16);
    expect(app.project.song.auto!['m:0:send']).toBeDefined();
    press('clear');
    emit({ type: 'touch', id: 'k1' }); // SEND 1
    release('clear');
    release('func');
    expect(Object.keys(app.project.song.auto!)).toHaveLength(15);
    press('clear');
    tap('step1');
    release('clear');
    expect(app.project.song.auto).toEqual({});
  });

  it('BAR moves through the song (rows and their bars); PLAY starts from the bar shown', () => {
    const { app, tap, sent } = songDesign();
    app.project.song.rows = [{ bars: 2, patterns: new Array<number>(8).fill(0) }, { bars: 3, patterns: new Array<number>(8).fill(1) }];
    tap('steppage');
    tap('steppage');
    tap('steppage'); // song bar 4 = row 2 bar 2
    tap('play');
    expect(sent.filter((m) => m.type === 'transport').pop()).toMatchObject({ fromRow: 1, fromBar: 1 });
    tap('play');
    tap('step3');
    emit_helper(app);
  });
});

function emit_helper(app: App): void {
  // The primed cell of song bar 4, step 3.
  expect((app as unknown as { primed: { cell: number } | null }).primed?.cell).toBe(3 * 16 + 2);
}

describe('FUNC + COPY: the sound only', () => {
  it('copies the patch onto another pattern of the same type, keeps its notes, lets go of FUNC, and UNDO brings the old sound back', () => {
    const { app, press, release, tap, sent } = makeApp();
    tap('mode:record');
    tap('ch6'); // PAD, editing A
    const c = app.project.channels[5];
    c.sounds.pad!.cutoff = 0.123;
    const notesB = JSON.stringify(c.patterns[1].steps);
    const before = patchOf(c, 1).sound.cutoff;
    press('copy');
    tap('patA');
    tap('func');
    tap('patB');
    release('copy');
    expect(patchOf(c, 1).sound.cutoff).toBe(0.123);
    expect(JSON.stringify(c.patterns[1].steps)).toBe(notesB);
    expect(c.patterns[1].patchDirty).toBe(true);
    expect(sent.some((m) => m.type === 'setPatch' && m.channel === 5 && m.pattern === 1)).toBe(true);
    expect((app as unknown as { func: boolean }).func).toBe(false);
    tap('undo');
    expect(patchOf(c, 1).sound.cutoff).toBe(before);
  });

  it('refuses another type and leaves both tracks as they were', () => {
    const { app, press, release, tap } = makeApp();
    tap('mode:record');
    tap('ch6');
    const kick = JSON.stringify(patchOf(app.project.channels[0], 0));
    press('copy');
    tap('patA');
    tap('func');
    tap('ch1');
    release('copy');
    expect(JSON.stringify(patchOf(app.project.channels[0], 0))).toBe(kick);
    expect((app as unknown as { message: string }).message).toContain('SAME TYPE');
  });
});

describe('COPY pattern: notes only, any track', () => {
  it('a PAD chord onto BASS keeps its lowest note; the BASS keeps its sound; a KICK onto LEAD lands on its base note', () => {
    const { app, tap, press, release } = makeApp();
    const pad = app.project.channels[5];
    const bass = app.project.channels[4];
    const step = pad.patterns[0].steps[0];
    step.active = true;
    step.note = 57;
    step.extra = [50, 62];
    step.extraGate = [1, 1];
    const bassSound = JSON.stringify(bass.sounds.bass);
    tap('mode:record');
    tap('ch6');
    bass.patterns[0].steps[9].active = true; // not empty: the BASS keeps its sound
    press('copy');
    tap('ch6');
    tap('ch5');
    release('copy');
    expect(bass.patterns[0].steps[0]).toMatchObject({ active: true, note: 50 });
    expect(bass.patterns[0].steps[0].extra).toBeUndefined();
    expect(JSON.stringify(bass.sounds.bass)).toBe(bassSound);
    const kick = app.project.channels[0];
    kick.patterns[0].steps[2].active = true;
    press('copy');
    tap('ch1');
    tap('ch7');
    release('copy');
    expect(app.project.channels[6].patterns[0].steps[2]).toMatchObject({ active: true, note: 45 });
  });
});

describe('UNDO / REDO', () => {
  it('a snapshot comes back as the same project, whichever pattern is being edited', () => {
    const p = fromStored(start)!;
    p.channels.forEach(initPatterns);
    const snap = snapshot(p);
    const back = restore(snap, p);
    expect(snapshot(back)).toBe(snap);
    expect(changes(p, back)).toEqual([]);
    // Another pattern edited: the same snapshot.
    const q = restore(snap, p);
    q.channels.forEach((c) => { c.activePattern = 0; });
    const moved = restore(snap, q);
    expect(snapshot(moved)).toBe(snap);
  });

  const kick = (app: App) => app.project.channels[0].patterns[app.project.channels[0].activePattern];
  const lastFlash = (app: App) => (app as unknown as { message: string }).message;

  it('steps back and forward through strip edits, CLEAR and knob turns, each a step', () => {
    const { app, tap, press, release, emit, sent } = makeApp();
    tap('mode:record');
    tap('ch1');
    tap('step1');
    tap('step5');
    expect(kick(app).steps[0].active).toBe(true);
    expect(kick(app).steps[4].active).toBe(true);
    press('clear');
    tap('step1');
    tap('step5');
    release('clear');
    expect(kick(app).steps[0].active).toBe(false);
    tap('mode:design');
    emit({ type: 'touch', id: 'k2' });
    const before = app.project.channels[0].volume;
    const t = (app as unknown as { targets: ({ label: string; get(): number } | null)[] }).targets[1]!;
    const was = t.get();
    emit({ type: 'knob', id: 'k2', value: 0.95 });
    expect(t.get()).not.toBe(was);
    sent.length = 0;
    tap('undo'); // the knob turn
    expect(t.get()).toBe(was);
    expect(lastFlash(app)).toBe(`UNDO: ${t.label}`);
    expect(app.project.channels[0].volume).toBe(before);
    tap('undo'); // the CLEAR (both steps)
    expect(lastFlash(app)).toBe('UNDO: CLEAR KICK A');
    expect(kick(app).steps[0].active).toBe(true);
    expect(kick(app).steps[4].active).toBe(true);
    expect(sent.some((m) => m.type === 'setStep' && m.index === 0 && m.step.active)).toBe(true);
    tap('undo'); // step 5
    expect(kick(app).steps[4].active).toBe(false);
    expect(kick(app).steps[0].active).toBe(true);
    press('func');
    tap('undo'); // REDO step 5
    release('func');
    expect(kick(app).steps[4].active).toBe(true);
    expect(lastFlash(app)).toBe('REDO: NOTES KICK A');
    tap('undo');
    tap('undo');
    tap('undo');
    expect(lastFlash(app)).toBe('NOTHING TO UNDO');
    expect(kick(app).steps[0].active).toBe(false);
  });

  it('a new edit drops the REDO steps; a pattern switch and MUTE stay as they are', () => {
    const { app, tap } = makeApp();
    tap('mode:record');
    tap('ch1');
    tap('step1');
    tap('undo');
    tap('step2');
    tap('func');
    tap('undo'); // FUNC latched: REDO, nothing there
    tap('func');
    expect(lastFlash(app)).toBe('NOTHING TO REDO');
    tap('step3'); // on pattern A
    tap('mute1');
    tap('patB');
    tap('undo'); // undoes step 3 on A, stays on B, still muted
    const c = app.project.channels[0];
    expect(c.activePattern).toBe(1);
    expect(c.mute).toBe(true);
    expect(c.patterns[0].steps[2].active).toBe(false);
    expect(c.patterns[0].steps[1].active).toBe(true);
  });

  it('a track type change is one step back, sounds included', () => {
    const { app, tap, sent } = makeApp();
    const menu = app as unknown as { setTrackType(ch: number, kind: string): void };
    // The menu's TRACKS page runs setTrackType inside a gesture (its PLAY press).
    (app as unknown as { beginGesture(k: string, l: string, s: boolean): void }).beginGesture('play', 'MENU', true);
    menu.setTrackType(0, 'bass');
    expect(app.project.channels[0].instrument).toBe('bass');
    sent.length = 0;
    tap('undo');
    expect(lastFlash(app)).toBe('UNDO: TRACK 1 TYPE');
    expect(app.project.channels[0].instrument).toBe('kick');
    expect(sent.some((m) => m.type === 'setInstrument' && m.kind === 'kick')).toBe(true);
  });

  it('a live-recording pass (PLAY to STOP) is one step back', () => {
    const { app, tap } = makeApp();
    tap('mode:record');
    tap('ch5'); // BASS
    tap('play');
    const c = app.project.channels[4];
    app.onRecorded({ type: 'recordedNote', channel: 4, pattern: 0, index: 2, note: 40, velocity: 0.8, accent: false, gate: 1, slide: false, start: true });
    tap('step1'); // played live (no step entry while playing)
    app.onRecorded({ type: 'recordedNote', channel: 4, pattern: 0, index: 6, note: 41, velocity: 0.8, accent: false, gate: 1, slide: false, start: true });
    tap('play'); // STOP
    expect(c.patterns[0].steps[2].active).toBe(true);
    tap('undo');
    expect(lastFlash(app)).toBe('UNDO: RECORDING');
    expect(c.patterns[0].steps[2].active).toBe(false);
    expect(c.patterns[0].steps[6].active).toBe(false);
  });
});

describe('OCT and FUNC + OCT', () => {
  it('OCT is the keyboard octave in every mode; FUNC + OCT the sound\'s OCTAVE (drums too)', () => {
    const { app, tap, press, release, texts, sent } = makeApp();
    const priv = app as unknown as { octave: number[]; message: string };
    const bass = () => app.project.channels[4].sounds.bass!.octave;
    tap('ch5');
    tap('mode:design');
    const was = bass();
    const kb = priv.octave[4];
    tap('oct+');
    expect(bass()).toBe(was);
    expect(priv.octave[4]).toBe(kb + 12);
    tap('mode:play');
    press('func');
    expect(texts.get('oct+')).toBe('SND ▲<small>OCT 0</small>'); // its value under it
    tap('oct+');
    release('func');
    expect(bass()).toBe(was + 1);
    expect(texts.get('oct+')).toBe('OCT ▲');
    tap('ch1'); // KICK: its pitched layers an octave down, in its patch
    press('func');
    tap('oct-');
    release('func');
    expect(priv.message).toBe('OCTAVE -1');
    expect(app.project.channels[0].sounds.kick!.octave).toBe(3);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'setSound', channel: 0, id: 'octave', value: 3 }));
  });
});

describe('OCT keys', () => {
  it('work on a drum track and with the strip on steps: the keyboard octave moves, the screen says where', () => {
    const { app, tap } = makeApp();
    const priv = app as unknown as { octave: number[]; message: string };
    tap('mode:record');
    tap('ch1'); // KICK: the strip shows steps
    const before = priv.octave[0];
    tap('oct+');
    expect(priv.octave[0]).toBe(before + 12);
    expect(priv.message).toMatch(/^KEYS FROM /);
    tap('oct-');
    expect(priv.octave[0]).toBe(before);
  });
});

describe('painted steps', () => {
  it('take the strip keys\' lowest note on every track, drums too (SCALE C: a C), and sound it', () => {
    const { app, tap, sent } = makeApp();
    tap('mode:record');
    tap('ch1'); // KICK: steps
    app.project.root = 0; // SCALE: C
    tap('step3');
    const step = app.project.channels[0].patterns[0].steps[2];
    expect(step.active).toBe(true);
    expect(step.note % 12).toBe(0);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'trigger', channel: 0, note: step.note }));
    app.project.root = 9; // A
    tap('step5');
    expect(app.project.channels[0].patterns[0].steps[4].note % 12).toBe(9);
  });
});

describe('pattern switch', () => {
  it('A-D switches the tracks as one group; FUNC + A-D = the quick switch (FUNC lets go)', () => {
    const { app, tap, sent } = makeApp();
    tap('patB');
    expect(sent).toContainEqual({ type: 'switchPatterns', channels: [0, 1, 2, 3, 4, 5, 6, 7], pattern: 1, quick: false });
    tap('func'); // latched
    tap('patC');
    expect(sent).toContainEqual({ type: 'switchPatterns', channels: [0, 1, 2, 3, 4, 5, 6, 7], pattern: 2, quick: true });
    expect((app as unknown as { func: boolean }).func).toBe(false);
    expect(app.project.channels.every((c) => c.activePattern === 2)).toBe(true);
  });
});

describe('held knobs', () => {
  it('a held knob keeps its job through FUNC and page changes until it is let go', () => {
    const { app, tap, emit } = makeApp();
    const label = (slot: number) => (app as unknown as { targets: ({ label: string } | null)[] }).targets[slot]?.label;
    tap('mode:design');
    tap('ch6'); // PAD SOUND page
    const held = label(5);
    const other = label(13);
    emit({ type: 'touch', id: 'k6' });
    tap('func'); // FUNC latched: the other knobs take the FUNC layer
    expect(label(5)).toBe(held);
    expect(label(13)).not.toBe(other);
    tap('dpage1'); // MIX page
    expect(label(5)).toBe(held);
    emit({ type: 'release', id: 'k6' });
    expect(label(5)).not.toBe(held);
  });
});

describe('STEP EDIT', () => {
  type T = { label: string; get(): number; staged?: boolean; auto?: { key: string } } | null;
  const targets = (app: App) => (app as unknown as { targets: T[] }).targets;
  const priv = (app: App) => app as unknown as { primed: { cell: number; staged: Map<string, unknown> } | null; message: string };

  it('RECORD only: primes the cursor step; touched knobs lock on a tap of the yellow step; moving waits for LOCK or CANCEL', () => {
    const { app, tap, emit, flags, texts } = makeApp();
    tap('mode:play');
    tap('stepedit'); // PLAY mode: not here
    expect(app.stepEdit).toBe(false);
    tap('mode:record');
    tap('ch5'); // BASS
    tap('stepedit');
    expect(app.stepEdit).toBe(true);
    expect(priv(app).primed?.cell).toBe(0);
    tap('step3'); // a tap primes another step
    expect(priv(app).primed?.cell).toBe(2);
    app.updateFrame(0);
    expect(flags.get('step3')?.has('cursor')).toBe(true);
    emit({ type: 'touch', id: 'k5' }); // BASS LIVE 1
    emit({ type: 'knob', id: 'k5', value: 0.9 });
    expect(texts.get('undo')).toBe('UNDO');
    tap('step5'); // refused while a knob waits
    expect(priv(app).primed?.cell).toBe(2);
    expect(priv(app).message).toBe('LOCK OR CANCEL FIRST');
    tap('step3'); // lock
    const step = app.project.channels[4].patterns[0].steps[2];
    expect(Object.keys(step.locks ?? {})).toEqual(['cutoff']); // BASS LIVE 1 = CUTOFF, stored by its bare id
    expect(priv(app).primed?.cell).toBe(2); // still primed there
    app.updateFrame(0);
    expect(texts.get('step3')).toBe('3<small>L</small>'); // locks marked L
    tap('undo'); // UNDO: the lock goes
    expect(app.project.channels[4].patterns[0].steps[2].locks).toBeUndefined();
    tap('play'); // STEP EDIT stays on while playing
    expect(app.stepEdit).toBe(true);
    expect(priv(app).primed?.cell).toBe(2);
  });

  it('works while playing: the strip stays on the primed bar (BAR moves it), the playhead lights, locks are heard at once and undo one by one', () => {
    const { app, tap, emit, leds, sent } = makeApp();
    tap('mode:record');
    tap('ch5'); // BASS
    app.project.channels[4].patterns[0].length = 32;
    tap('play');
    tap('stepedit');
    expect(app.stepEdit).toBe(true);
    app.setStatus({ type: 'status', peakL: 0, peakR: 0, frame: 0, playing: true, steps: [0, 0, 0, 0, 3, 0, 0, 0], patterns: new Array<number>(8).fill(0), barPhase: 0, barSteps: 16, songRow: -1, songBar: 0, load: 0, countIn: 0 });
    app.updateFrame(0);
    expect(leds[0]).toBe('cursor');
    expect(leds[3]).toBe('on'); // the playhead
    tap('steppage'); // BAR: the next bar, playing or not
    expect(priv(app).primed?.cell).toBe(16);
    emit({ type: 'touch', id: 'k5' });
    emit({ type: 'knob', id: 'k5', value: 0.9 });
    tap('step1'); // lock step 17
    const first = app.project.channels[4].patterns[0].steps[16].locks!.cutoff;
    expect(sent.some((m) => m.type === 'setStep' && m.channel === 4 && m.index === 16)).toBe(true);
    emit({ type: 'touch', id: 'k5' });
    emit({ type: 'knob', id: 'k5', value: 0.2 });
    tap('step2'); // prime step 18 ... (knob waits on 17: refused)
    tap('step1'); // lock again on 17
    expect(app.project.channels[4].patterns[0].steps[16].locks!.cutoff).not.toBe(first);
    tap('undo'); // UNDO: only the last lock (not the whole pass)
    expect(app.project.channels[4].patterns[0].steps[16].locks?.cutoff).toBe(first);
  });

  it('FUNC shows the SOUND page; its own sound params lock by their bare id; CLEAR + step takes a step\'s locks away', () => {
    const { app, tap, press, release, emit } = makeApp();
    tap('mode:record');
    tap('ch5');
    tap('stepedit');
    press('func');
    expect(targets(app)[0]?.label).toBe('TIMBRE');
    emit({ type: 'touch', id: 'k14' }); // CUTOFF (module 6 bottom)
    emit({ type: 'knob', id: 'k14', value: 0.5 });
    release('func');
    tap('step1');
    const locks = app.project.channels[4].patterns[0].steps[0].locks ?? {};
    expect(Object.keys(locks)).toEqual(['cutoff']);
    press('clear');
    tap('step1');
    release('clear');
    expect(app.project.channels[4].patterns[0].steps[0].locks).toBeUndefined();
  });

  it('SONG RECORD works the same: no moving while knobs wait; ◀ ▶ move the primed step', () => {
    const { app, tap, emit } = makeApp();
    tap('menu');
    tap('cur+'); // MODE: SONG
    tap('play');
    tap('mode:record');
    tap('dpage2');
    tap('step1');
    tap('cur+');
    expect(priv(app).primed?.cell).toBe(1);
    emit({ type: 'touch', id: 'k1' });
    tap('step5');
    expect(priv(app).primed?.cell).toBe(1);
    tap('cancel');
    tap('step5');
    expect(priv(app).primed?.cell).toBe(4);
  });
});

describe('locks move the knobs while playing', () => {
  const status = (steps: number[], extra = {}) => ({ type: 'status' as const, peakL: 0, peakR: 0, frame: 0, playing: true, steps, patterns: new Array<number>(8).fill(0), barPhase: 0, barSteps: 16, songRow: -1, songBar: 0, load: 0, countIn: 0, ...extra });
  const shown = (app: App, i: number) => (app as unknown as { targets: ({ get(): number } | null)[] }).targets[i]!.get();

  it('a pattern lock shows on its knob at the playhead (gliding to the next), the knob as set before the first and when stopped', () => {
    const { app, tap } = makeApp();
    const steps = app.project.channels[0].patterns[0].steps;
    steps[4].locks = { 'm:0:volume': 0.2 };
    steps[8].locks = { 'm:0:volume': 0.6 };
    const own = app.project.channels[0].volume;
    tap('mode:design');
    tap('dpage1'); // MIX: VOL 1 is knob 1
    tap('play');
    app.setStatus(status([2, 0, 0, 0, 0, 0, 0, 0]));
    expect(shown(app, 0)).toBeCloseTo(own, 5); // before the first lock: as set
    app.setStatus(status([6, 0, 0, 0, 0, 0, 0, 0]));
    expect(shown(app, 0)).toBeCloseTo(0.4, 5); // half way from 0.2 to 0.6
    app.setStatus(status([12, 0, 0, 0, 0, 0, 0, 0]));
    expect(shown(app, 0)).toBeCloseTo(0.6, 5); // held after the last
    expect(app.project.channels[0].volume).toBe(own); // only shown, never stored
    tap('play'); // stopped: the knob's own value
    expect(shown(app, 0)).toBe(own);
  });

  it('a SONG lane wins over the pattern lock while the song plays', () => {
    const { app, tap } = makeApp();
    app.project.channels[0].patterns[0].steps[0].locks = { 'm:0:volume': 0.2 };
    app.project.song = { rows: [{ bars: 2, patterns: new Array<number>(8).fill(0) }], auto: { 'm:0:volume': [[0, 0.9]] } };
    tap('menu');
    tap('cur+'); // MODE: SONG
    tap('play');
    tap('mode:record'); // SONG RECORD: LIVE / SOUND / MIX
    tap('dpage2'); // MIX
    tap('play');
    app.setStatus(status([3, 0, 0, 0, 0, 0, 0, 0], { songRow: 0, songBar: 0, barPhase: 3 / 16 }));
    expect(shown(app, 0)).toBeCloseTo(0.9, 5);
  });
});

describe('the sound\'s OCTAVE in sight', () => {
  it('shows beside the track name on the screen and on the SND keys with FUNC; drums too', () => {
    const { app, tap, press, release, texts } = makeApp();
    const label = () => app.liveView(0, { peak: 0 } as never).channelLabel;
    tap('ch5'); // BASS
    expect(label()).toBe('CH5 BASS OCT 0');
    press('func');
    tap('oct+');
    expect(label()).toBe('CH5 BASS OCT+1');
    expect(texts.get('oct+')).toBe('SND ▲<small>OCT+1</small>');
    tap('oct-');
    tap('oct-');
    expect(label()).toBe('CH5 BASS OCT-1');
    release('func');
    expect(texts.get('oct+')).toBe('OCT ▲');
    tap('ch1'); // KICK: an OCTAVE too
    expect(label()).toBe('CH1 KICK OCT 0');
  });
});

describe('ARP key', () => {
  it('tap = on / off for the selected track; FUNC + ARP = its knobs; MODE starts OFF', () => {
    const { app, tap, press, release, sent, emit } = makeApp();
    tap('ch1');
    tap('arp');
    expect(app.project.channels[0].arp?.on).toBe(true);
    expect(sent.some((m) => m.type === 'setArp' && m.id === 'on' && m.value === 1)).toBe(true);
    expect(app.project.channels[0].arp?.mode).toBe(0);
    press('func');
    tap('arp');
    release('func');
    expect(app.arpOpen).toBe(true);
    const t = (app as unknown as { targets: ({ label: string } | null)[] }).targets;
    expect(t[0]?.label).toBe('ARP MODE');
    emit({ type: 'knob', id: 'k1', value: 1 / 6 }); // UP
    expect(app.project.channels[0].arp?.mode).toBe(1);
    tap('arp'); // in the view: only back, still on
    expect(app.arpOpen).toBe(false);
    expect(app.project.channels[0].arp?.on).toBe(true);
    tap('arp');
    expect(app.project.channels[0].arp?.on).toBe(false);
    const back = fromStored(JSON.parse(JSON.stringify(toStored(app.project))))!;
    expect(back.channels[0].arp).toEqual({ on: false, mode: 1, rate: 3, oct: 0 });
  });

  it('FUNC + ARP lets go of FUNC (latched or held): the ARP knobs show, not an empty page', () => {
    const { app, tap, press } = makeApp();
    const t = () => (app as unknown as { targets: ({ label: string } | null)[] }).targets;
    tap('func'); // latched
    tap('arp');
    expect(app.arpOpen).toBe(true);
    expect((app as unknown as { func: boolean }).func).toBe(false);
    expect(t()[0]?.label).toBe('ARP MODE');
    press('func'); // held again: still the ARP knobs
    expect(t()[0]?.label).toBe('ARP MODE');
  });
});

describe('ROLL held, BAR, STEPS, the TIME SIG ×', () => {
  it('PLAY on a drum: ROLL held repeats (holdRoll on / off); a quick tap still sets every note rolling', () => {
    const { app, press, release, tap, sent } = makeApp();
    tap('mode:play');
    tap('ch1');
    press('slide');
    expect(sent.some((m) => m.type === 'holdRoll' && m.on)).toBe(true);
    release('slide'); // quick: a tap
    expect(sent.some((m) => m.type === 'holdRoll' && !m.on)).toBe(true);
    expect((app as unknown as { forceSlide: boolean[] }).forceSlide[0]).toBe(true);
  });

  it('STEPS mode: steps switch on / off, ◀ ▶ = through the bars, track buttons = the bars (BAR only moves)', () => {
    const { app, tap, press, release, texts } = makeApp();
    tap('mode:record');
    tap('ch1');
    const pat = () => app.project.channels[0].patterns[0];
    press('steppage');
    tap('cur+');
    release('steppage');
    expect(pat().length).toBe(16); // BAR never adds a bar
    tap('len'); // STEPS mode
    tap('ch3'); // bars 2 and 3 added
    expect(pat().length).toBe(48);
    tap('cur+'); // to bar 2
    app.updateFrame(0);
    expect(texts.get('steppage')).toContain('2/3');
    tap('step3');
    expect(pat().steps[18].flip).toBe(true); // bar 2's step 3 switched
    pat().steps[33].active = true; // a hit in bar 3
    tap('ch2'); // bar 2 out: bar 3 moves up
    expect(pat().length).toBe(32);
    expect(pat().steps[17].active).toBe(true);
    expect(pat().steps[18].flip).toBeUndefined();
    tap('ch8'); // up to 8 bars: 128 steps
    expect(pat().length).toBe(128);
    tap('ch2');
    tap('ch1');
    tap('ch1');
    tap('ch1');
    tap('ch1');
    tap('ch1');
    tap('ch1');
    expect(pat().length).toBe(16); // one bar stays
    expect(app.project.channels[0].patterns[0]).toBe(pat());
  });

  it('a step the time signature leaves out shows ×', () => {
    const { app, tap, texts } = makeApp();
    tap('mode:record');
    tap('ch1');
    app.project.meter = 1; // a time signature with dark steps
    app.updateFrame(0);
    expect([...Array(16).keys()].some((i) => texts.get(`step${i + 1}`) === '×')).toBe(true);
  });

  it('a PAD track turned BASS keeps each chord\'s lowest note; mixer locks stay, sound locks go', () => {
    const { app } = makeApp();
    const pad = app.project.channels[5];
    Object.assign(pad.patterns[0].steps[0], { active: true, note: 64, extra: [60, 67], extraGate: [1, 1], locks: { cutoff: 900, 'm:5:volume': 0.5 } });
    (app as unknown as { setTrackType(ch: number, k: string): void }).setTrackType(5, 'bass');
    const st = pad.patterns[0].steps[0];
    expect(st.note).toBe(60);
    expect(st.extra).toBeUndefined();
    expect(st.locks).toEqual({ 'm:5:volume': 0.5 });
  });
});

describe('song transitions: GLIDE CURVE, JAM AUTO-FILL, SONG DESIGN clip knobs', () => {
  const targets = (app: App) => (app as unknown as { targets: ({ label: string; get(): number; spec: { options?: readonly string[] } } | null)[] }).targets;
  const lastOf = (sent: MainToWorklet[], type: string) => [...sent].reverse().find((m) => m.type === type);

  it('DESIGN > PROJECT: CURVE / AUTO-FILL on modules 5 / 6, FILL per track on FUNC; the engine hears them', () => {
    const { app, tap, emit, sent, press, release } = makeApp();
    tap('mode:design');
    tap('dpage2');
    expect(targets(app).slice(4, 6).map((t) => t?.label)).toEqual(['CURVE', 'AUTO-FILL']);
    expect(targets(app)[5]!.spec.options![targets(app)[5]!.get()]).toBe('4 STEPS');
    expect(lastOf(sent, 'setAutoFill')).toEqual({ type: 'setAutoFill', steps: 4, tracks: [true, true, true, true, false, false, false, false] });
    emit({ type: 'knob', id: 'k5', value: 1 / 3 }); // LATE
    expect(app.project.settings?.glideCurve).toBe(1);
    expect(lastOf(sent, 'setGlideCurve')).toEqual({ type: 'setGlideCurve', curve: 1 });
    emit({ type: 'knob', id: 'k6', value: 0 }); // OFF
    expect((lastOf(sent, 'setAutoFill') as { steps: number }).steps).toBe(0);
    press('func');
    expect(targets(app).slice(0, 8).map((t) => t?.label)).toEqual(['FILL 1', 'FILL 2', 'FILL 3', 'FILL 4', 'FILL 5', 'FILL 6', 'FILL 7', 'FILL 8']);
    emit({ type: 'knob', id: 'k5', value: 1 }); // BASS on
    release('func');
    expect(app.project.fillTracks?.[4]).toBe(1);
    expect((lastOf(sent, 'setAutoFill') as { tracks: boolean[] }).tracks[4]).toBe(true);
    // Stored and read back.
    const back = fromStored(JSON.parse(JSON.stringify(toStored(app.project))))!;
    expect(back.fillTracks).toEqual(app.project.fillTracks);
    expect(back.settings).toEqual(app.project.settings);
  });

  it('MENU: PROJECT SETTINGS > AUTO-FILL has STEPS and a line per track; GLOBAL has the defaults', () => {
    const { app, tap } = makeApp();
    const page = () => { const st = (app as unknown as { menu: { stack: { page: string }[] } }).menu.stack; return st[st.length - 1].page; };
    tap('menu');
    tap('step2'); // PROJECT SETTINGS
    tap('cur+');
    expect(page()).toBe('project');
    tap('step8'); // AUTO-FILL
    tap('cur+');
    expect(page()).toBe('fill');
    tap('step2'); // TRACK 1
    tap('cur+'); // OFF
    tap('play'); // saved
    expect(app.project.fillTracks?.[0]).toBe(0);
    expect(deviceSettings.autoFill).toBe(4);
    expect(deviceSettings.glideCurve).toBe(0);
  });

  it('SONG DESIGN: the cursor clip\'s GLIDE START / END and FILL / FILL LEN; START never after END; stored in the song rows', () => {
    const { app, tap, emit } = makeApp();
    tap('menu');
    tap('cur+'); // MODE: SONG
    tap('play');
    tap('mode:design');
    tap('ch1');
    tap('patA'); // bar 1
    tap('patB'); // bar 2
    tap('cur-'); // back on B
    const ts = targets(app);
    expect([ts[0]?.label, ts[8]?.label, ts[1]?.label, ts[9]?.label, ts[7]?.label]).toEqual(['GLIDE START', 'GLIDE END', 'FILL', 'FILL LEN', 'CURVE']);
    expect(ts[0]!.spec.options![ts[0]!.get()]).toBe('-16 ST');
    expect(ts[8]!.spec.options![ts[8]!.get()]).toBe('0 ST');
    const n = GLIDE_STEPS.length - 1;
    emit({ type: 'knob', id: 'k1', value: GLIDE_STEPS.indexOf(8) / n }); // START +8: END follows
    const row = app.project.song.rows.find((r) => r.patterns[0] === 1)!;
    expect(row.entry?.[0]).toEqual({ glideStart: 8, glideEnd: 8 });
    emit({ type: 'knob', id: 'k9', value: GLIDE_STEPS.indexOf(-4) / n }); // END -4: START follows
    expect(app.project.song.rows.find((r) => r.patterns[0] === 1)!.entry?.[0]).toEqual({ glideStart: -4, glideEnd: -4 });
    emit({ type: 'knob', id: 'k2', value: 3 / 4 }); // FILL C
    emit({ type: 'knob', id: 'k10', value: FILL_STEPS.indexOf(8) / (FILL_STEPS.length - 1) });
    expect(app.project.song.rows.find((r) => r.patterns[0] === 1)!.entry?.[0]).toEqual({ glideStart: -4, glideEnd: -4, fill: 2, fillLen: 8 });
    const back = fromStored(JSON.parse(JSON.stringify(toStored(app.project))))!;
    expect(back.song).toEqual(app.project.song);
    // An empty bar: no clip knobs (CURVE stays).
    for (let i = 0; i < 4; i++) tap('cur+'); // bar 6, past the song
    expect(targets(app)[0]).toBeNull();
    expect(targets(app)[7]?.label).toBe('CURVE');
  });
});
