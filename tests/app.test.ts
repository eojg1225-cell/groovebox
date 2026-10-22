// The App (UI controller) driven through its ControlSurface events, with a stand-in panel.
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/ui/App';
import { createDefaultProject } from '../src/engine/defaultProject';
import { stepNotes } from '../src/engine/project';
import type { ControlEvent } from '../src/controls/ControlSurface';
import type { Panel } from '../src/ui/Panel';
import type { MainToWorklet } from '../src/engine/protocol';

/** A panel that swallows every call (the App only needs its events). */
function makeApp() {
  let handler: (e: ControlEvent) => void = () => {};
  const noop = () => {};
  const panel = new Proxy({}, {
    get: (_t, k) => (k === 'subscribe' ? (h: (e: ControlEvent) => void) => { handler = h; return noop; }
      : k === 'root' ? { classList: { toggle: noop } } : noop),
  }) as unknown as Panel;
  const sent: MainToWorklet[] = [];
  const app = new App(createDefaultProject(), panel, (m) => sent.push(m));
  const press = (id: string) => handler({ type: 'button', id, pressed: true });
  const release = (id: string) => handler({ type: 'button', id, pressed: false });
  const tap = (id: string) => { press(id); release(id); };
  return { app, sent, press, release, tap };
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

  it('A tied 1-8, C tied 9-16, then G 1-16: all three stay, each with its own length', () => {
    const { app, press, release, tap } = makeApp();
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
    const { app, tap } = makeApp();
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
    const { app, press, release, tap } = makeApp();
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
    const { app, press, release, tap } = makeApp();
    tap('mode:record');
    tap('ch6');
    for (const k of [1, 3, 5, 8, 10, 12]) { press(`step${k}`); } // six keys together on step 1
    for (const k of [1, 3, 5, 8, 10, 12]) { release(`step${k}`); }
    expect(notesAt(app, 0).map((n) => n.note)).toEqual([45, 47, 49, 52, 54, 56]);
    goTo(app, tap, 0);
    tap('step7'); // 51: nearest is 52
    expect(notesAt(app, 0).map((n) => n.note).sort()).toEqual([45, 47, 49, 51, 54, 56]);
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
