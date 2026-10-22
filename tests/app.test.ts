// The App (UI controller) driven through its ControlSurface events, with a stand-in panel.
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/ui/App';
import { createDefaultProject } from '../src/engine/defaultProject';
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

describe('PAD step entry: chords one note at a time', () => {
  const padSteps = (app: App) => {
    const c = app.project.channels[5];
    return c.patterns[c.activePattern].steps;
  };

  it('a note tied to step 16, then another on step 1: both play, as one chord', () => {
    const { app, press, release, tap } = makeApp();
    tap('mode:record');
    tap('ch6');
    press('step1'); // A
    for (let i = 0; i < 15; i++) tap('cur+'); // tie it to step 16
    release('step1');
    expect((app as unknown as { cursor: number[] }).cursor[5]).toBe(0); // past the note's end: round to step 1
    press('step5'); // C#
    tap('cur+'); // already the whole loop
    release('step5');
    const s = padSteps(app)[0];
    expect([s.active, s.note, s.extra, s.gate]).toEqual([true, 45, [49], 16]);
  });

  it('the same key again takes its note out; the last one out empties the step; six at most', () => {
    const { app, tap } = makeApp();
    tap('mode:record');
    tap('ch6');
    tap('step1'); // A on step 1, the cursor moves on
    tap('cur-'); // back to step 1
    tap('step5'); // + C#
    tap('cur-');
    tap('step1'); // A out: C# stays
    let s = padSteps(app)[0];
    expect([s.active, s.note, s.extra]).toEqual([true, 49, undefined]);
    expect((app as unknown as { cursor: number[] }).cursor[5]).toBe(0); // taking a note out leaves the cursor where it is
    tap('step5'); // C# out: empty
    s = padSteps(app)[0];
    expect(s.active).toBe(false);
    for (const k of [1, 3, 5, 6, 8, 10, 12]) { tap(`step${k}`); tap('cur-'); }
    s = padSteps(app)[0];
    expect(1 + (s.extra?.length ?? 0)).toBe(6);
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
