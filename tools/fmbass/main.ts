/**
 * FM bass ratio test (not part of GrooveAccess): a dance bass line on the real engine with the
 * BASS FM modulator at 3 : 2 or 2 : 3 (same settings otherwise), and today's FM CLANG.
 */
import workletUrl from './worklet.ts?worker&url';
import { createDefaultProject } from '../../src/engine/defaultProject';
import { emptyPattern } from '../../src/engine/project';
import type { MainToWorklet } from '../../src/engine/protocol';
import { formatValue, toNorm, toValue, type ParamSpec } from '../../src/engine/params';
import { INSTRUMENTS, presetSound } from '../../src/instruments/registry';

const BASS = 4;
const OCTAVE_ZERO = 4;
const spec = (id: string) => INSTRUMENTS.bass.params.find((p) => p.id === id) as ParamSpec;
const FM_CLANG = INSTRUMENTS.bass.presets.findIndex((p) => p.name === 'FM CLANG');

type Cand = 'a' | 'b' | 'c';
const RATIO: Record<Exclude<Cand, 'c'>, number> = { a: 1.5, b: 2 / 3 };

/** The shared FM bass both ratios play (a woody DX-style bass; FM level and envelope set below). */
const BASE: Record<string, number> = {
  shape: 0, sub: 0.15, reso: 0.1, fattack: 0.0005, fdecay: 0.16, drive: 1.4, glide: 0.03,
  attack: 0.002, sustain: 0.4, release: 0.06, detune: 0, unison: 0,
};
const state = { cand: 'a' as Cand, fm: 0.6, fenv: 0.5, cutoff: 2600, decay: 0.45, octave: 0, drums: true };

/** A minor, offbeat-driven: the "and"s with pushes and an octave jump. */
const LINE: [number, number][] = [[2, 33], [3, 33], [6, 33], [7, 45], [10, 33], [11, 36], [13, 31], [14, 33]];

function project() {
  const p = createDefaultProject();
  p.bpm = 126;
  p.channels.forEach((c, i) => {
    c.patterns = c.patterns.map(() => emptyPattern(c.instrument === 'kick' || c.instrument === 'hat' ? 36 : 33));
    c.mute = ![0, 2, BASS].includes(i);
  });
  for (const s of [0, 4, 8, 12]) p.channels[0].patterns[0].steps[s].active = true;
  for (const s of [2, 6, 10, 14]) p.channels[2].patterns[0].steps[s].active = true;
  const bass = p.channels[BASS];
  bass.volume = 0.8;
  for (const [s, note] of LINE) Object.assign(bass.patterns[0].steps[s], { active: true, note });
  bass.sounds.bass = sound();
  return p;
}

/** The bass sound for the chosen candidate. */
function sound(): Record<string, number> {
  const s = presetSound('bass', FM_CLANG);
  if (state.cand === 'c') return { ...s, octave: OCTAVE_ZERO };
  return {
    ...s, ...BASE, fmratio: RATIO[state.cand], fm: state.fm, fenv: state.fenv, cutoff: state.cutoff,
    decay: state.decay, octave: OCTAVE_ZERO + state.octave,
  };
}

// ------------------------------------------------------------------ audio

let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let playing = false;
const send = (msg: MainToWorklet) => node?.port.postMessage(msg);

async function start(): Promise<void> {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(ctx, 'fmbass-engine', { numberOfInputs: 0, outputChannelCount: [2] });
    node.connect(ctx.destination);
  }
  await ctx.resume();
  send({ type: 'loadProject', project: project() });
  drums();
  send({ type: 'transport', playing: true });
}

function applySound(): void {
  const s = sound();
  for (const id in s) send({ type: 'setSound', channel: BASS, id, value: s[id] });
}

function drums(): void {
  for (const ch of [0, 2]) send({ type: 'setMix', channel: ch, id: 'mute', value: state.drums ? 0 : 1 });
}

// ------------------------------------------------------------------ UI

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const playBtn = $('play');

async function togglePlay(): Promise<void> {
  if (playing) {
    send({ type: 'transport', playing: false });
    playing = false;
  } else {
    await start();
    playing = true;
  }
  playBtn.textContent = playing ? 'Stop' : 'Play';
  playBtn.setAttribute('aria-pressed', String(playing));
}

function choose(c: Cand): void {
  state.cand = c;
  for (const x of ['a', 'b', 'c'] as const) $(`c-${x}`).setAttribute('aria-checked', String(x === c));
  $('controls').classList.toggle('off', c === 'c');
  applySound();
}

/** A fader on a real parameter (its own curve), showing the value as the app would. */
function fader(id: 'fm' | 'fenv' | 'cutoff' | 'decay'): void {
  const input = $<HTMLInputElement>(id);
  const out = $(`${id}-v`);
  const p = spec(id);
  const show = () => { out.textContent = formatValue(p, state[id]); };
  input.value = String(toNorm(p, state[id]));
  show();
  input.addEventListener('input', () => {
    state[id] = toValue(p, Number(input.value));
    show();
    applySound();
  });
}
(['fm', 'fenv', 'cutoff', 'decay'] as const).forEach(fader);

function octave(o: number): void {
  state.octave = o;
  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.oct) === o)));
  applySound();
}
document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.addEventListener('click', () => octave(Number(b.dataset.oct))));
octave(0);

for (const c of ['a', 'b', 'c'] as const) $(`c-${c}`).addEventListener('click', () => choose(c));
$<HTMLInputElement>('drums').addEventListener('change', (e) => { state.drums = (e.target as HTMLInputElement).checked; drums(); });
playBtn.addEventListener('click', () => { void togglePlay().catch((err) => { $('err').textContent = `Audio could not start: ${err?.message ?? err}`; }); });
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.code !== 'Space') return;
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  if (e.code === 'Digit1') choose('a');
  if (e.code === 'Digit2') choose('b');
  if (e.code === 'Digit3') choose('c');
});
choose('a');
