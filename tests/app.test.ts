// The App (UI controller) driven through its ControlSurface events, with a stand-in panel.
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/ui/App';
import { createDefaultProject } from '../src/engine/defaultProject';
import { stepNotes } from '../src/engine/project';
import { fromStored, toStored } from '../src/engine/projectFile';
import { projectStore } from '../src/storage/projects';
import type { ControlEvent } from '../src/controls/ControlSurface';
import type { Panel } from '../src/ui/Panel';
import type { MainToWorklet } from '../src/engine/protocol';
import { deviceSettings } from '../src/storage/settings';
import { changes, restore, snapshot } from '../src/ui/history';
import { initPatterns } from '../src/engine/project';
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
  it('KICK / SNARE / HAT top live knobs ride FX 1: MOD, DELAY, FILTER', () => {
    const { app, sent, tap, emit } = makeApp();
    tap('mode:play');
    emit({ type: 'knob', id: 'k1', value: 1 });
    emit({ type: 'knob', id: 'k2', value: 0.5 });
    emit({ type: 'knob', id: 'k3', value: 0 });
    expect(app.project.buses[0].mod_vol).toBe(1);
    expect(app.project.buses[0].dly_vol).toBe(0.5);
    expect(app.project.buses[0].flt).toBe(0);
    expect(sent).toContainEqual({ type: 'setBus', bus: 0, id: 'flt', value: 0 });
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

describe('arrow keys', () => {
  it('OCT ▼ / ▲ read the same in SONG: ROW ▼ = the next row down', () => {
    const { app, tap, texts } = makeApp();
    tap('menu');
    tap('cur+'); // MODE: SONG
    tap('play'); // saved, the menu closes
    tap('ring'); // INSERT: a second row
    const row = () => (app as unknown as { songRow: number }).songRow;
    app.updateFrame(0);
    expect(texts.get('oct-')).toBe('ROW ▼');
    expect(texts.get('oct+')).toBe('ROW ▲');
    tap('oct+');
    expect(row()).toBe(0);
    tap('oct-');
    expect(row()).toBe(1);
    tap('mode:play'); // SONG PLAY: the keys are the usual ones again
    app.updateFrame(0);
    expect(texts.get('oct-')).toBe('OCT ▼');
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
    tap('step1'); // TRACKS
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
    tap('play'); // saved: SONG, the menu closes (the top page); SONG opens on RECORD (the grid)
    expect(app.song).toBe(true);
    expect(app.mode).toBe('record');
    expect(app.menu).toBeNull();
    expect(app.playing).toBe(false); // PLAY in the menu is SAVE, not the transport
    app.updateFrame(0);
    expect(texts.get('menu')).toBe('MENU<small>SONG</small>');
    tap('menu');
    tap('cur-'); // JAM
    tap('play');
    expect(app.song).toBe(false);
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
    tap('step1'); // TRACKS
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
    tap('step5'); // TOUCH SETTINGS
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

  it('CANCEL leaves the SAVE / LOAD screen; elsewhere the button is UNDO (REDO with FUNC) and leaves views alone', () => {
    const { app, tap, texts } = makeApp();
    const priv = app as unknown as { fxView: number };
    tap('saveproject');
    expect(texts.get('cancel')).toBe('CANCEL');
    tap('cancel');
    expect(app.projMenu).toBeNull();
    expect(texts.get('cancel')).toBe('UNDO');
    tap('func'); // latched
    expect(texts.get('cancel')).toBe('REDO');
    tap('func');
    tap('fx2');
    tap('cancel');
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

describe('SONG grid: rows, track selection, A-D', () => {
  const song = () => {
    const r = makeApp();
    r.tap('menu');
    r.tap('cur+'); // MODE: SONG
    r.tap('play'); // saved
    return r;
  };
  const rows = (app: App) => app.project.song.rows.map((row) => row.patterns.join(','));
  const cursor = (app: App) => (app as unknown as { songRow: number }).songRow;

  it('ROW ▼ past the last row adds an empty one; left empty upward it goes again', () => {
    const { app, tap } = song();
    expect(app.project.song.rows.length).toBe(1);
    tap('oct-');
    expect(app.project.song.rows.length).toBe(2);
    expect(cursor(app)).toBe(1);
    expect(app.project.song.rows[1].patterns.every((p) => p === -1)).toBe(true);
    tap('oct+');
    expect(app.project.song.rows.length).toBe(1);
    tap('oct-');
    tap('patB'); // filled: it stays
    tap('oct+');
    expect(app.project.song.rows.length).toBe(2);
  });

  it('A-D: the pattern on the selected tracks, the rest blank; nothing selected = every track', () => {
    const { app, tap } = song();
    tap('patC');
    expect(rows(app)[0]).toBe('2,2,2,2,2,2,2,2');
    tap('ch1');
    tap('ch5');
    tap('patA');
    expect(rows(app)[0]).toBe('0,-1,-1,-1,0,-1,-1,-1');
    tap('ch5'); // deselected
    tap('patD');
    expect(rows(app)[0]).toBe('3,-1,-1,-1,-1,-1,-1,-1');
    tap('ch1');
    tap('patB');
    expect(rows(app)[0]).toBe('1,1,1,1,1,1,1,1');
  });
});

describe('A-D', () => {
  it('FUNC + A-D is plain A-D (every track); hold a channel for one track', () => {
    const { app, tap, press, release } = makeApp();
    press('func');
    tap('patB');
    release('func');
    expect(app.project.channels.map((c) => c.activePattern).join('')).toBe('11111111');
    press('ch3');
    tap('patC');
    release('ch3');
    expect(app.project.channels.map((c) => c.activePattern).join('')).toBe('11211111');
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

  it('a held track keeps its own settings and the FX knobs its live knobs move (PLAY: KICK LIVE 1 = FX1:MOD)', () => {
    const { app, tap, press, release, emit } = makeApp();
    tap('mode:play');
    tap('ch1');
    emit({ type: 'knob', id: 'k1', value: 0.9 }); // FX1:MOD
    emit({ type: 'knob', id: 'k9', value: 0.9 }); // DECAY
    emit({ type: 'knob', id: 'k2', value: 0.1 }); // SNARE LIVE 1 = FX1:DELAY
    const mod = app.project.buses[0].mod_vol;
    press('ch1');
    tap('reset');
    release('ch1');
    glide(app);
    expect(app.project.buses[0].mod_vol).toBe(mod);
    expect(app.project.channels[0].liveOffset['macro:decay']).toBeGreaterThan(0);
    expect(app.project.buses[0].dly_vol).toBe(createDefaultProject().buses[0].dly_vol); // SNARE's: reset
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
    emit({ type: 'knob', id: 'k1', value: 0.9 }); // KICK FX1:MOD
    emit({ type: 'knob', id: 'k10', value: 0.9 }); // SNARE DECAY
    tap('mode:design');
    tap('dpage1'); // MIX
    emit({ type: 'knob', id: 'k1', value: 0.2 }); // KICK VOLUME
    emit({ type: 'knob', id: 'k2', value: 0.2 }); // SNARE VOLUME
    tap('fx2');
    emit({ type: 'knob', id: 'k1', value: 0.7 });
    tap('fx2');
    const snare = app.project.channels[1].volume;
    const fx2 = JSON.stringify(app.project.buses[1]);
    press('ch1');
    tap('reset');
    release('ch1');
    glide(app);
    const fresh = createDefaultProject();
    expect(app.project.channels[0].volume).toBe(fresh.channels[0].volume);
    expect(app.project.buses[0].mod_vol).toBe(fresh.buses[0].mod_vol);
    expect(app.project.channels[1].volume).toBe(snare);
    expect(app.project.channels[1].liveOffset['macro:decay']).toBeGreaterThan(0);
    expect(JSON.stringify(app.project.buses[1])).toBe(fx2);
  });

  it('a project setting overrides GLOBAL; DEFAULT follows it; it is saved with the project', () => {
    const { app, tap, sent } = makeApp();
    deviceSettings.countIn = 2;
    tap('menu');
    tap('step2'); // PROJECT SETTINGS
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

describe('SONG over RECORD / PLAY / DESIGN', () => {
  const song = () => {
    const r = makeApp();
    r.tap('menu');
    r.tap('cur+'); // MODE: SONG
    r.tap('play');
    return r;
  };
  const lastTransport = (sent: MainToWorklet[]) => sent.filter((m) => m.type === 'transport').pop() as Extract<MainToWorklet, { type: 'transport' }>;

  it('RECORD is the grid; PLAY and DESIGN play the song with their usual pages', () => {
    const { app, tap, sent } = song();
    expect(app.songGrid).toBe(true);
    tap('mode:design');
    expect(app.songGrid).toBe(false);
    tap('play');
    expect(lastTransport(sent)).toMatchObject({ playing: true, song: true, fromRow: 0, fromBar: 0 });
    tap('play');
    tap('mode:play');
    tap('play');
    expect(lastTransport(sent)).toMatchObject({ playing: true, song: true });
  });

  it('BAR + ◀ ▶ in the grid picks the bar of the cursor row to start from; another row starts from its first', () => {
    const { app, tap, press, release, sent } = song();
    press('steppage');
    tap('cur+');
    tap('cur+');
    release('steppage');
    expect((app as unknown as { songPage: number }).songPage).toBe(0); // BAR held for ◀ ▶: no page turn
    tap('play');
    expect(lastTransport(sent)).toMatchObject({ fromRow: 0, fromBar: 2 });
    tap('play');
    tap('oct-'); // a new row
    tap('patA');
    tap('play');
    expect(lastTransport(sent)).toMatchObject({ fromRow: 1, fromBar: 0 });
    tap('play');
    tap('func');
    tap('play'); // FUNC + PLAY: the top
    expect(lastTransport(sent)).toMatchObject({ fromRow: 0, fromBar: 0 });
  });

  it('STOP keeps the row and bar playing, so PLAY carries on there', () => {
    const { app, tap, sent } = song();
    tap('oct-');
    tap('patB');
    tap('oct+');
    tap('play');
    app.setStatus({ type: 'status', peakL: 0, peakR: 0, frame: 0, playing: true, steps: new Array<number>(8).fill(0), patterns: new Array<number>(8).fill(0), barPhase: 0, barSteps: 16, songRow: 1, songBar: 2, load: 0, countIn: 0 });
    tap('play');
    tap('play');
    expect(lastTransport(sent)).toMatchObject({ fromRow: 1, fromBar: 2 });
  });
});

describe('SONG DESIGN step entry', () => {
  const songDesign = () => {
    const r = makeApp();
    r.tap('menu');
    r.tap('cur+'); // MODE: SONG
    r.tap('play');
    r.tap('mode:design');
    return r;
  };
  const targets = (app: App) => (app as unknown as { targets: ({ label: string; get(): number; staged?: boolean; auto?: { key: string } } | null)[] }).targets;

  it('SONG DESIGN pages are LIVE / SOUND / MIX; a channel tap opens SOUND', () => {
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

describe('COPY BAR', () => {
  const kick = (app: App) => app.project.channels[0].patterns[app.project.channels[0].activePattern];

  it('COPY + BAR on the bar shown, ▶ past the end grows the pattern, COPY pastes all 16 steps (switched-off ones too)', () => {
    const { app, tap, press, release } = makeApp();
    tap('mode:record');
    tap('ch1');
    const pat = kick(app);
    pat.steps[0].active = true;
    pat.steps[4].accent = true;
    pat.steps[4].active = true;
    pat.steps[13].flip = true; // switched off (STEPS)
    press('copy');
    tap('steppage'); // COPY BAR from bar 1
    release('copy');
    tap('cur+'); // to bar 2: the pattern grows
    expect(pat.length).toBe(32);
    press('copy'); // paste
    release('copy');
    expect(pat.steps[16].active).toBe(true);
    expect(pat.steps[20].accent).toBe(true);
    expect(pat.steps[29].flip).toBe(true);
    expect((app as unknown as { copyBar: unknown }).copyBar).toBeNull();
  });

  it('an empty step overwrites an active one; going back or CANCEL takes an added bar away again', () => {
    const { app, tap, press, release } = makeApp();
    tap('mode:record');
    tap('ch1');
    const pat = kick(app);
    pat.length = 32;
    pat.steps[16].active = true; // bar 2 has a hit; bar 1 is empty
    press('copy');
    tap('steppage');
    release('copy');
    tap('cur+'); // bar 2
    tap('cur+'); // bar 3: added
    expect(pat.length).toBe(48);
    tap('cur-'); // back to bar 2: bar 3 goes again
    expect(pat.length).toBe(32);
    press('copy');
    release('copy');
    expect(pat.steps[16].active).toBe(false);
    press('copy');
    tap('steppage');
    release('copy');
    tap('cur+');
    tap('cur+');
    tap('cancel');
    expect(pat.length).toBe(32);
  });

  it('the strip shows the target bar as steps on a keyboard track too', () => {
    const { app, tap, press, release, flags } = makeApp();
    tap('mode:record');
    tap('ch5'); // BASS
    const pat = app.project.channels[4].patterns[0];
    pat.length = 32;
    pat.steps[18].active = true;
    press('copy');
    tap('steppage');
    release('copy');
    tap('cur+');
    app.updateFrame(0);
    expect(flags.get('step3')?.has('lit')).toBe(true);
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
    press('copy');
    tap('ch5');
    release('copy');
    expect(bass.patterns[0].steps[0]).toMatchObject({ active: true, note: 50 });
    expect(bass.patterns[0].steps[0].extra).toBeUndefined();
    expect(JSON.stringify(bass.sounds.bass)).toBe(bassSound);
    const kick = app.project.channels[0];
    kick.patterns[0].steps[2].active = true;
    tap('ch1');
    press('copy');
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
    tap('cancel'); // the knob turn
    expect(t.get()).toBe(was);
    expect(lastFlash(app)).toBe(`UNDO: ${t.label}`);
    expect(app.project.channels[0].volume).toBe(before);
    tap('cancel'); // the CLEAR (both steps)
    expect(lastFlash(app)).toBe('UNDO: CLEAR KICK A');
    expect(kick(app).steps[0].active).toBe(true);
    expect(kick(app).steps[4].active).toBe(true);
    expect(sent.some((m) => m.type === 'setStep' && m.index === 0 && m.step.active)).toBe(true);
    tap('cancel'); // step 5
    expect(kick(app).steps[4].active).toBe(false);
    expect(kick(app).steps[0].active).toBe(true);
    press('func');
    tap('cancel'); // REDO step 5
    release('func');
    expect(kick(app).steps[4].active).toBe(true);
    expect(lastFlash(app)).toBe('REDO: NOTES KICK A');
    tap('cancel');
    tap('cancel');
    tap('cancel');
    expect(lastFlash(app)).toBe('NOTHING TO UNDO');
    expect(kick(app).steps[0].active).toBe(false);
  });

  it('a new edit drops the REDO steps; a pattern switch and MUTE stay as they are', () => {
    const { app, tap } = makeApp();
    tap('mode:record');
    tap('ch1');
    tap('step1');
    tap('cancel');
    tap('step2');
    tap('func');
    tap('cancel'); // FUNC latched: REDO, nothing there
    tap('func');
    expect(lastFlash(app)).toBe('NOTHING TO REDO');
    tap('step3'); // on pattern A
    tap('mute1');
    tap('patB');
    tap('cancel'); // undoes step 3 on A, stays on B, still muted
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
    tap('cancel');
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
    tap('cancel');
    expect(lastFlash(app)).toBe('UNDO: RECORDING');
    expect(c.patterns[0].steps[2].active).toBe(false);
    expect(c.patterns[0].steps[6].active).toBe(false);
  });
});
