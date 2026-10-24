// The App (UI controller) driven through its ControlSurface events, with a stand-in panel.
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/ui/App';
import { createDefaultProject } from '../src/engine/defaultProject';
import { stepNotes } from '../src/engine/project';
import { projectStore } from '../src/storage/projects';
import type { ControlEvent } from '../src/controls/ControlSurface';
import type { Panel } from '../src/ui/Panel';
import type { MainToWorklet } from '../src/engine/protocol';

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
  const status = (steps: number[]) => ({ type: 'status' as const, peakL: 0, peakR: 0, frame: 0, playing: true, steps, patterns: new Array<number>(8).fill(0), barPhase: 0, barSteps: 16, songRow: -1, songBar: 0 });

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
