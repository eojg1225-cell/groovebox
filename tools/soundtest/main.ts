/**
 * Sound test interface (not part of GrooveAccess): plays the current project with the BASS or
 * PLUCK sound driven by a TIMBRE and an INT knob, under a choice of rules for how TIMBRE moves
 * between its five designed sounds. Uses the real engine; nothing here changes the app.
 */
import workletUrl from './worklet.ts?worker&url';
import stored from './project.json';
import { fromStored } from '../../src/engine/projectFile';
import type { MainToWorklet } from '../../src/engine/protocol';
import type { Project, SoundKind } from '../../src/engine/project';
import { toNorm, toValue, type ParamSpec } from '../../src/engine/params';
import { INSTRUMENTS, presetSound } from '../../src/instruments/registry';
import { CONVERGE, MACROS, macroSound, snapRatio, type Anchor, type Excite } from '../../src/instruments/macros';
import { createDefaultProject } from '../../src/engine/defaultProject';
import { PAD_B_ANCHORS, PAD_B_EXCITE, PAD_C_ANCHORS, PAD_C_EXCITE, gentle, padE, snapHalves, withRatios, PAD_A_ANCHORS, PAD_A_EXCITE } from './padCandidate';
import { CHORD_NAMES } from '../../src/engine/chords';

type Kind = 'bass' | 'pluck' | 'pad';
/**
 * PAD engines (padCandidate.ts): A = the 3 CARRIER FM pad before v32, B = the BASS engine, C / D =
 * 2 STACKS, C with A's ratios (stepping as TIMBRE moves), D with one set of matched ratios,
 * E = C reworked (soft -> bell-like, whole / half ratio steps), F = the PAD in the app now (v32).
 */
type Engine = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
const ENGINES: Engine[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const PAD_C_STEPPED = withRatios(PAD_C_ANCHORS, PAD_A_ANCHORS);
/** F with Gentle INT: the app's ratio steps (modulators whole / half, stack 2's carrier all). */
const padSnapId = { id: '' };
function padSnap(r: number): number {
  return padSnapId.id === 'ratio2' ? snapRatio(r) : snapHalves(r);
}
/** E: C reordered soft -> bell-like, ratios in whole / half steps (padCandidate.ts). */
const PAD_E = padE(PAD_C_STEPPED);
type Mode = 'morph' | 'all' | 'xfade' | 'zones' | 'snap';

export const MODES: { id: Mode; name: string; text: string }[] = [
  { id: 'morph', name: 'Morph (now)', text: 'Every setting glides from one sound to the next. Envelopes and width (detune, unison) stay the track’s own, whatever TIMBRE is.' },
  { id: 'all', name: 'Morph everything (before 17 Oct)', text: 'Every setting glides, and each sound brings its own envelope and width too: a plucky SOLID, a long thick GROWL.' },
  { id: 'xfade', name: 'Crossfade', text: 'The two neighbouring sounds play at once and TIMBRE fades between them, so each stays exactly itself. In between you hear both layered.' },
  { id: 'zones', name: 'Hold, then morph', text: 'Each sound holds for most of its stretch of the knob and only morphs in a short zone between sounds.' },
  { id: 'snap', name: 'Snap', text: 'TIMBRE picks one of the five sounds. No in-between.' },
];

/** The envelope and width each sound had before they became the track's own (git history). */
const OWN: Record<'bass' | 'pluck', Record<string, number>[]> = {
  bass: [
    { decay: 0.7, sustain: 0.8, detune: 0 },
    { decay: 0.5, sustain: 0.45, detune: 0.15 },
    { decay: 0.35, sustain: 0.6, detune: 0 },
    { decay: 1, sustain: 0.9, detune: 0.75 },
    { decay: 0.5, sustain: 0.25, detune: 0 },
  ],
  pluck: [
    { attack: 0.001, decay: 0.35, decay2: 0.25, sustain: 0, release: 0.25, detune: 0.1, unison: 0 },
    { attack: 0.001, decay: 0.4, decay2: 0.3, sustain: 0, release: 0.3, detune: 0.2, unison: 0 },
    { attack: 0.001, decay: 0.4, decay2: 0.35, sustain: 0.05, release: 0.25, detune: 0.35, unison: 0.5 },
    { attack: 0.001, decay: 0.35, decay2: 0.3, sustain: 0.03, release: 0.22, detune: 0.25, unison: 0.2 },
    { attack: 0.0005, decay: 0.25, decay2: 0.18, sustain: 0, release: 0.12, detune: 0.1, unison: 0 },
  ],
};
/** INT used to move width as well. */
const OWN_EXCITE: Record<'bass' | 'pluck', Excite[]> = {
  bass: [{ id: 'detune', floor: 0.05, high: 1.3 }],
  pluck: [{ id: 'unison', floor: 0, high: 1.1 }, { id: 'detune', floor: 0.05, high: 1.1 }],
};
const RATIO_IDS = new Set(['fmratio', 'ratio2', 'ratio3']);

/** macroSound with the sounds' own envelopes and width added (the "Morph everything" rule). */
function morphAll(kind: 'bass' | 'pluck', timbre: number, intensity: number, specs: readonly ParamSpec[]): Record<string, number> {
  const anchors = MACROS[kind].anchors.map((a, i) => {
    const own = { ...OWN[kind][i] };
    own.attack2 ??= own.attack; own.decay2 ??= own.decay; own.sustain2 = own.sustain; own.release2 ??= own.release;
    for (const k of Object.keys(own)) if (own[k] === undefined) delete own[k];
    return { name: a.name, values: { ...a.values, ...own } };
  });
  return blend(anchors, [...MACROS[kind].excite, ...OWN_EXCITE[kind]], timbre, intensity, specs);
}

/** TIMBRE / INT over any list of sounds, by the same rules as macroSound. */
function blend(list: readonly Anchor[], excite: readonly Excite[], timbre: number, intensity: number, specs: readonly ParamSpec[], snap = snapRatio): Record<string, number> {
  const anchors = list.map((a) => a.values);
  const t = Math.min(1, Math.max(0, timbre)) * (anchors.length - 1);
  const i0 = Math.min(anchors.length - 2, Math.floor(t));
  const f = t - i0;
  const out: Record<string, number> = {};
  for (const id of new Set([...Object.keys(anchors[i0]), ...Object.keys(anchors[i0 + 1])])) {
    const spec = specs.find((p) => p.id === id);
    if (!spec) continue;
    const a = anchors[i0][id] ?? anchors[i0 + 1][id];
    const b = anchors[i0 + 1][id] ?? anchors[i0][id];
    out[id] = toValue(spec, toNorm(spec, a) + (toNorm(spec, b) - toNorm(spec, a)) * f);
    if (RATIO_IDS.has(id)) { padSnapId.id = id; out[id] = snap(out[id]); }
  }
  const x = Math.min(1, Math.max(0, intensity));
  for (const e of excite) {
    const spec = specs.find((p) => p.id === e.id);
    if (!spec || out[e.id] === undefined) continue;
    if (x < 0.5) {
      if (e.floor === undefined) continue;
      const n = toNorm(spec, out[e.id]);
      out[e.id] = toValue(spec, n + (toNorm(spec, e.floor) - n) * CONVERGE * (1 - 2 * x));
    } else if (e.knee !== undefined && e.top !== undefined) {
      const tt = 2 * x - 1;
      const a = toNorm(spec, out[e.id]);
      const k = Math.max(a, toNorm(spec, e.knee));
      out[e.id] = toValue(spec, tt <= 0.5 ? a + (k - a) * tt * 2 : k + (Math.max(k, toNorm(spec, e.top)) - k) * (tt - 0.5) * 2);
    } else if (e.high !== undefined) {
      out[e.id] = Math.min(spec.max, Math.max(spec.min, out[e.id] * Math.pow(e.high, 2 * x - 1)));
    }
  }
  return out;
}

/** The PAD for engine A-D at a TIMBRE / INT position (GENTLE INT: lower top end). */
function padSound(engine: Engine, timbre: number, intensity: number): Record<string, number> {
  const specs = INSTRUMENTS.pad.params;
  const base = presetSound('pad', 0);
  const ex = (e: readonly Excite[]) => (state.gentle ? gentle(e) : e);
  if (engine === 'F' && !state.gentle) return { ...base, ...macroSound('pad', timbre, intensity, specs), algo: 2, timbre, intensity };
  const sound = engine === 'A'
    ? { ...base, ...blend(PAD_A_ANCHORS, ex(PAD_A_EXCITE), timbre, intensity, specs), algo: 1 }
    : engine === 'F'
      ? { ...base, ...blend(MACROS.pad.anchors, ex(MACROS.pad.excite), timbre, intensity, specs, padSnap), algo: 2 }
    : engine === 'B'
      ? { ...base, ...blend(PAD_B_ANCHORS, ex(PAD_B_EXCITE), timbre, intensity, specs), algo: 0 }
      : engine === 'E'
        ? { ...base, ...blend(PAD_E, ex(PAD_C_EXCITE), timbre, intensity, specs, snapHalves), algo: 2 }
        : { ...base, ...blend(engine === 'C' ? PAD_C_STEPPED : PAD_C_ANCHORS, ex(PAD_C_EXCITE), timbre, intensity, specs), algo: 2 };
  return { ...sound, timbre, intensity };
}

const ZONE = 0.3; // share of each stretch between two sounds where "Hold, then morph" moves

/** The sound(s) for the knobs: one sound and its level, or two for the crossfade. */
function voices(kind: Kind, mode: Mode, timbre: number, intensity: number): { sound: Record<string, number>; gain: number }[] {
  if (kind === 'pad') return [{ sound: padSound(state.engine, timbre, intensity), gain: Math.pow(10, state.gain[state.engine] / 20) }];
  const specs = INSTRUMENTS[kind].params;
  const base = presetSound(kind, 0);
  const n = MACROS[kind].anchors.length - 1;
  const at = (t: number) => ({ ...base, ...macroSound(kind, t, intensity, specs), timbre: t, intensity });
  if (mode === 'all') return [{ sound: { ...base, ...morphAll(kind, timbre, intensity, specs), timbre, intensity }, gain: 1 }];
  if (mode === 'snap') return [{ sound: at(Math.round(timbre * n) / n), gain: 1 }];
  if (mode === 'zones') {
    const u = timbre * n;
    const i = Math.min(n - 1, Math.floor(u));
    const f = Math.min(1, Math.max(0, (u - i - (0.5 - ZONE / 2)) / ZONE));
    const s = f * f * (3 - 2 * f);
    return [{ sound: at((i + s) / n), gain: 1 }];
  }
  if (mode === 'xfade') {
    const u = timbre * n;
    const i = Math.min(n - 1, Math.floor(u));
    const f = u - i;
    return [
      { sound: at(i / n), gain: Math.cos((f * Math.PI) / 2) },
      { sound: at((i + 1) / n), gain: Math.sin((f * Math.PI) / 2) },
    ];
  }
  return [{ sound: at(timbre), gain: 1 }];
}

/** The sound name(s) TIMBRE sits on, for the readout. */
function timbreLabel(kind: Kind, mode: Mode, timbre: number): string {
  const names = anchorNames(kind);
  if (kind === 'pad') mode = 'morph';
  const n = names.length - 1;
  const u = timbre * n;
  const i = Math.min(n - 1, Math.floor(u));
  const f = u - i;
  if (mode === 'snap' || f < 0.02) return names[Math.round(u)];
  if (f > 0.98) return names[i + 1];
  return `${names[i]} → ${names[i + 1]} ${Math.round(f * 100)}%`;
}

// ------------------------------------------------------------------ project

const CHANNEL: Record<Kind, number> = { bass: 4, pluck: 7, pad: 5 };

/** The TIMBRE sounds' names (the PAD's A and B lists share them). */
function anchorNames(kind: Kind): string[] {
  if (kind === 'pad' && state.engine === 'E') return PAD_E.map((a) => a.name);
  if (kind === 'pad' && state.engine !== 'F') return PAD_A_ANCHORS.map((a) => a.name);
  return MACROS[kind].anchors.map((a) => a.name);
}
const PAD = 5;

/** PAD: one sustained MIN7 chord on A3 held for a 16-step pattern, then struck again. */
const PAD_NOTE = 57;
const PAD_STEPS = 16;

/** PAD: a fresh default project (its FX routing), only the PAD sounding, no notes in it. */
function padProject(): Project {
  const p = createDefaultProject();
  p.channels.forEach((c, i) => { c.mute = i !== CHANNEL.pad; });
  p.channels[CHANNEL.pad].chord = CHORD_NAMES.indexOf('MIN7');
  return p;
}

function buildProject(kind: Kind, solo: boolean, onlyTest: boolean): Project {
  if (kind === 'pad') return padProject();
  const p = fromStored(stored.project)!;
  const ch = CHANNEL[kind];
  if (kind === 'pluck') {
    // The PLUCK has no notes in this project: it plays the CHORD track's pattern and chord.
    const pad = p.channels[PAD];
    const pl = p.channels[ch];
    pl.patterns[pl.activePattern] = JSON.parse(JSON.stringify(pad.patterns[pad.activePattern]));
    pl.chord = pad.chord;
  }
  p.channels.forEach((c, i) => {
    c.liveOffset = {};
    if (i === ch) { c.mute = false; c.instrument = kind; return; }
    if (solo || onlyTest) c.mute = true;
  });
  p.song.rows = [];
  return p;
}

// ------------------------------------------------------------------ audio

let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let playing = false;
const send = (to: 'A' | 'B' | 'both', msg: MainToWorklet) => node?.port.postMessage({ to, msg });

const state = { kind: 'pad' as Kind, mode: 'morph' as Mode, timbre: 0.25, intensity: 0.5, solo: true, engine: 'A' as Engine, gain: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 } as Record<Engine, number>, gentle: false };

async function ensureAudio(): Promise<void> {
  if (node) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(workletUrl);
  node = new AudioWorkletNode(ctx, 'soundtest-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(ctx.destination);
}

function load(): void {
  send('A', { type: 'loadProject', project: buildProject(state.kind, state.solo, false) });
  send('B', { type: 'loadProject', project: buildProject(state.kind, true, true) });
  applySound();
}

function applySound(): void {
  const ch = CHANNEL[state.kind];
  const v = voices(state.kind, state.mode, state.timbre, state.intensity);
  const volume = state.kind === 'pad' ? PAD_VOLUME : 0.8;
  const targets: ('A' | 'B')[] = ['A', 'B'];
  targets.forEach((to, i) => {
    const voice = v[i];
    send(to, { type: 'setMix', channel: ch, id: 'volume', value: voice ? volume * voice.gain : 0 });
    if (!voice) return;
    for (const id in voice.sound) send(to, { type: 'setSound', channel: ch, id, value: voice.sound[id] });
  });
  readout();
}

let padTimer: number | undefined;
let padStart = 0;
const BPM = 128;

/** The PAD's held note: struck at the start of every 16 steps, with a step counter. */
function padNote(on: boolean): void {
  window.clearInterval(padTimer);
  send('A', { type: 'release', channel: CHANNEL.pad, note: PAD_NOTE });
  $('bar').textContent = '';
  if (!on || !ctx) return;
  const step = 60 / BPM / 4;
  padStart = ctx.currentTime;
  let last = -1;
  const tick = () => {
    const n = Math.floor((ctx!.currentTime - padStart) / step);
    const block = Math.floor(n / PAD_STEPS);
    if (block !== last) {
      if (last >= 0) send('A', { type: 'release', channel: CHANNEL.pad, note: PAD_NOTE });
      send('A', { type: 'trigger', channel: CHANNEL.pad, note: PAD_NOTE, velocity: 0.8 });
      last = block;
    }
    $('bar').textContent = `STEP ${(n % PAD_STEPS) + 1} / ${PAD_STEPS}`;
  };
  tick();
  padTimer = window.setInterval(tick, 50);
}

async function togglePlay(): Promise<void> {
  await ensureAudio();
  await ctx!.resume();
  playing = !playing;
  if (playing) load();
  send('both', { type: 'transport', playing });
  if (state.kind === 'pad') padNote(playing);
  playBtn.textContent = playing ? 'Stop' : 'Play';
  playBtn.classList.toggle('on', playing);
}

// ------------------------------------------------------------------ UI

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const playBtn = $<HTMLButtonElement>('play');
const PAD_VOLUME = createDefaultProject().channels[CHANNEL.pad].volume;

function readout(): void {
  $('timbre-val').textContent = timbreLabel(state.kind, state.mode, state.timbre);
  $('int-val').textContent = `${Math.round(state.intensity * 100)}%`;
}

/** A rotary knob: drag up / down, mouse wheel, or arrow keys. */
function knob(id: string, get: () => number, set: (v: number) => void): () => void {
  const el = $(id);
  const arc = el.querySelector('.arc') as SVGPathElement;
  const dot = el.querySelector('.ptr') as SVGLineElement;
  const draw = () => {
    const v = get();
    const a0 = (-135 * Math.PI) / 180;
    const a = a0 + v * (270 * Math.PI) / 180;
    const p = (ang: number, r: number) => [50 + r * Math.sin(ang), 50 - r * Math.cos(ang)];
    const [x0, y0] = p(a0, 40), [x1, y1] = p(a, 40);
    arc.setAttribute('d', v <= 0 ? '' : `M ${x0} ${y0} A 40 40 0 ${v * 270 > 180 ? 1 : 0} 1 ${x1} ${y1}`);
    const [px, py] = p(a, 30);
    dot.setAttribute('x2', String(px));
    dot.setAttribute('y2', String(py));
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  };
  const change = (v: number) => { set(Math.min(1, Math.max(0, v))); draw(); applySound(); };
  let startY = 0, startV = 0;
  el.addEventListener('pointerdown', (e) => {
    startY = e.clientY; startV = get();
    el.setPointerCapture(e.pointerId);
    el.focus();
  });
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    change(startV + (startY - e.clientY) / 220);
  });
  el.addEventListener('wheel', (e) => { e.preventDefault(); change(get() - Math.sign(e.deltaY) * 0.02); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { change(get() + step); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { change(get() - step); e.preventDefault(); }
  });
  draw();
  return draw;
}

const drawTimbre = knob('timbre', () => state.timbre, (v) => { state.timbre = v; });
knob('int', () => state.intensity, (v) => { state.intensity = v; });

// Snap marks under TIMBRE: where the five sounds sit.
function marks(): void {
  const names = anchorNames(state.kind);
  document.body.classList.toggle('pad', state.kind === 'pad');
  $('names').innerHTML = names.map((n, i) => `<button type="button" data-i="${i}">${n}</button>`).join('');
}
$('names').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  state.timbre = Number(b.dataset.i) / (MACROS[state.kind].anchors.length - 1);
  drawTimbre();
  applySound();
});

$('modes').innerHTML = MODES.map((m) => `
  <label class="mode" for="m-${m.id}">
    <input type="radio" name="mode" id="m-${m.id}" value="${m.id}" ${m.id === state.mode ? 'checked' : ''}>
    <span><b>${m.name}</b>${m.text}</span>
  </label>`).join('');
$('modes').addEventListener('change', (e) => {
  state.mode = (e.target as HTMLInputElement).value as Mode;
  applySound();
});
/** A-D: which PAD engine plays (instant, the chord keeps playing). */
function setEngine(e: Engine): void {
  // E has its own order of sounds: its names show under TIMBRE.
  const order = (x: Engine) => (x === 'E' || x === 'F' ? 'new' : 'old');
  if (order(e) !== order(state.engine)) { state.engine = e; marks(); }
  state.engine = e;
  for (const x of ENGINES) {
    const b = $(`e-${x}`);
    b.classList.toggle('on', x === e);
    b.setAttribute('aria-pressed', String(x === e));
  }
  const g = state.gain[e];
  $<HTMLInputElement>('gain').value = String(g);
  $('gain-name').textContent = `${e} level`;
  $('gain-val').textContent = `${g > 0 ? '+' : ''}${g} dB`;
  applySound();
}
for (const x of ENGINES) $(`e-${x}`).addEventListener('click', () => setEngine(x));
$<HTMLInputElement>('gain').addEventListener('input', (e) => {
  state.gain[state.engine] = Number((e.target as HTMLInputElement).value);
  setEngine(state.engine);
});
$<HTMLInputElement>('gentle').addEventListener('change', (e) => {
  state.gentle = (e.target as HTMLInputElement).checked;
  applySound();
});
for (const k of ['bass', 'pluck', 'pad'] as const) {
  $(`k-${k}`).addEventListener('change', () => {
    if (playing && state.kind === 'pad') padNote(false);
    state.kind = k;
    marks();
    if (playing) { load(); if (k === 'pad') padNote(true); } else readout();
  });
}
$<HTMLInputElement>('solo').addEventListener('change', (e) => {
  state.solo = (e.target as HTMLInputElement).checked;
  if (playing) load();
});
playBtn.addEventListener('click', () => { void togglePlay().catch((err) => { $('err').textContent = `Audio could not start: ${err.message ?? err}`; }); });
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); playBtn.click(); }
  const key = e.code.slice(3) as Engine;
  if (state.kind === 'pad' && e.code.startsWith('Key') && ENGINES.includes(key)) setEngine(key);
});
$('bpm').textContent = `${Math.round((stored.project as { bpm: number }).bpm)} BPM`;
$('bpm-pad').textContent = `${BPM} BPM`;
marks();
setEngine('F');

export type { SoundKind };
