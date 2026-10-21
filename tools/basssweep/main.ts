/**
 * Bass TIMBRE sweep test (not part of GrooveAccess): the BASS track's TIMBRE / INTENSITY on the
 * real engine, comparing how the FM ratios move between GROWL and FM 2:3 - the app now (the
 * carrier switches halfway) against stepping through 2 : 3 (every step root-locked).
 */
import workletUrl from './worklet.ts?worker&url';
import { createDefaultProject } from '../../src/engine/defaultProject';
import { emptyPattern } from '../../src/engine/project';
import type { MainToWorklet } from '../../src/engine/protocol';
import { INSTRUMENTS, presetSound } from '../../src/instruments/registry';
import { macroSound, timbreName } from '../../src/instruments/macros';

const BASS = 4;
const SPECS = INSTRUMENTS.bass.params;
const NAMES = INSTRUMENTS.bass.presets.map((p) => p.name);
/** TIMBRE where GROWL and FM 2:3 sit (the last two sounds). */
const FROM = (NAMES.length - 2) / (NAMES.length - 1);
const TO = 1;

type Rule = 'now' | 'step';
/** STEPPED: carrier : modulator through the GROWL -> FM 2:3 stretch (lowest partial on the note each time). */
const STEPS: [number, number][] = [[1, 2], [2, 3], [3, 2]];

const state = { rule: 'now' as Rule, timbre: FROM, intensity: 0.5, drums: true };

/** The bass sound at the current TIMBRE / INT under the chosen rule. */
function sound(): Record<string, number> {
  const s: Record<string, number> = { ...presetSound('bass', 0), ...macroSound('bass', state.timbre, state.intensity, SPECS), timbre: state.timbre, intensity: state.intensity };
  if (state.rule === 'step' && state.timbre > FROM) {
    const f = (state.timbre - FROM) / (TO - FROM);
    const [c, m] = STEPS[Math.min(STEPS.length - 1, Math.floor(f * STEPS.length))];
    s.cratio = c;
    s.fmratio = m;
  }
  return s;
}

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

// ------------------------------------------------------------------ audio

let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let playing = false;
const send = (msg: MainToWorklet) => node?.port.postMessage(msg);
/** Last values sent, so a sweep only sends what changed. */
let sent: Record<string, number> = {};

async function start(): Promise<void> {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(ctx, 'basssweep-engine', { numberOfInputs: 0, outputChannelCount: [2] });
    node.connect(ctx.destination);
  }
  await ctx.resume();
  const p = project();
  sent = { ...p.channels[BASS].sounds.bass! };
  send({ type: 'loadProject', project: p });
  drums();
  send({ type: 'transport', playing: true });
}

function applySound(): void {
  const s = sound();
  for (const id in s) {
    if (sent[id] === s[id]) continue;
    sent[id] = s[id];
    send({ type: 'setSound', channel: BASS, id, value: s[id] });
  }
  readout();
}

function drums(): void {
  for (const ch of [0, 2]) send({ type: 'setMix', channel: ch, id: 'mute', value: state.drums ? 0 : 1 });
}

// ------------------------------------------------------------------ UI

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const playBtn = $('play');
const timbreIn = $<HTMLInputElement>('timbre');
const intIn = $<HTMLInputElement>('int');

function readout(): void {
  const s = sound();
  $('timbre-v').textContent = timbreName('bass', state.timbre);
  $('int-v').textContent = `${Math.round(state.intensity * 100)}%`;
  const r = (x: number) => (Math.abs(x - Math.round(x)) < 1e-6 ? String(Math.round(x)) : x.toFixed(2));
  $('ratio').textContent = `carrier : modulator  ${r(s.cratio ?? 1)} : ${r(s.fmratio)}   ·   FM LVL ${s.fm.toFixed(2)}`;
}

async function togglePlay(): Promise<void> {
  if (playing) {
    send({ type: 'transport', playing: false });
    playing = false;
    stopAuto();
  } else {
    await start();
    playing = true;
  }
  playBtn.textContent = playing ? 'Stop' : 'Play';
  playBtn.setAttribute('aria-pressed', String(playing));
}

function rule(r: Rule): void {
  state.rule = r;
  $('r-now').setAttribute('aria-checked', String(r === 'now'));
  $('r-step').setAttribute('aria-checked', String(r === 'step'));
  applySound();
}

function setTimbre(t: number): void {
  state.timbre = Math.min(1, Math.max(0, t));
  timbreIn.value = String(state.timbre);
  applySound();
}

// Auto sweep: GROWL -> FM 2:3 over 8 bars, then back.
const BAR_MS = (60000 / 126) * 4;
let autoFrame = 0;
let autoStart = 0;
function stopAuto(): void {
  cancelAnimationFrame(autoFrame);
  autoFrame = 0;
  $('auto').setAttribute('aria-pressed', 'false');
}
function tick(now: number): void {
  const x = ((now - autoStart) / (8 * BAR_MS)) % 2;
  setTimbre(FROM + (TO - FROM) * (x < 1 ? x : 2 - x));
  autoFrame = requestAnimationFrame(tick);
}
async function toggleAuto(): Promise<void> {
  if (autoFrame) { stopAuto(); return; }
  if (!playing) await togglePlay();
  autoStart = performance.now();
  $('auto').setAttribute('aria-pressed', 'true');
  autoFrame = requestAnimationFrame(tick);
}

$('names').innerHTML = NAMES.map((n, i) => `<button type="button" tabindex="-1" data-i="${i}" style="left:${(i / (NAMES.length - 1)) * 100}%">${n}</button>`).join('');
$('names').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b) { stopAuto(); setTimbre(Number(b.dataset.i) / (NAMES.length - 1)); }
});
timbreIn.addEventListener('input', () => { stopAuto(); setTimbre(Number(timbreIn.value)); });
intIn.addEventListener('input', () => { state.intensity = Number(intIn.value); applySound(); });
$('r-now').addEventListener('click', () => rule('now'));
$('r-step').addEventListener('click', () => rule('step'));
$('auto').addEventListener('click', () => { void toggleAuto().catch((err) => { $('err').textContent = `Audio could not start: ${err?.message ?? err}`; }); });
$<HTMLInputElement>('drums').addEventListener('change', (e) => { state.drums = (e.target as HTMLInputElement).checked; drums(); });
playBtn.addEventListener('click', () => { void togglePlay().catch((err) => { $('err').textContent = `Audio could not start: ${err?.message ?? err}`; }); });
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.code !== 'Space') return;
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  if (e.code === 'Digit1') rule('now');
  if (e.code === 'Digit2') rule('step');
  if (e.code === 'KeyS') $('auto').click();
});
timbreIn.value = String(state.timbre);
intIn.value = String(state.intensity);
rule('now');
