/**
 * Bass TIMBRE sweep test (not part of GrooveAccess): the BASS track's TIMBRE / INTENSITY on the
 * real engine. 1 and 2 = the proposed BASS: GROWL and SOLID swapped (SINE SUB, GROWL, ACID,
 * SOLID, FM 2:3), the FM ratio stepping 1 : 2 -> 2 : 3 -> 3 : 2 in three even stretches of the
 * knob, FM LVL no longer moved by INTENSITY; 1 keeps the first four sounds FM-free, 2 gives them
 * a little FM. 3 = the app now, for reference.
 */
import workletUrl from './worklet.ts?worker&url';
import { createDefaultProject } from '../../src/engine/defaultProject';
import { emptyPattern } from '../../src/engine/project';
import type { MainToWorklet } from '../../src/engine/protocol';
import { INSTRUMENTS, presetSound } from '../../src/instruments/registry';
import { MACROS, macroSound, type Anchor } from '../../src/instruments/macros';

const BASS = 4;
const SPECS = INSTRUMENTS.bass.params;
type Rule = 'one' | 'two' | 'now';
const NOW_ANCHORS = MACROS.bass.anchors;
const byName = (n: string) => NOW_ANCHORS.find((a) => a.name === n) as Anchor;
/** PROPOSED: today's order with GROWL and SOLID swapped. */
const PROPOSED_ORDER = ['SINE SUB', 'GROWL', 'ACID', 'SOLID', 'FM 2:3'];
/**
 * The FM ratio (carrier : modulator) steps across the whole knob in three even stretches, each
 * with its lowest partial on the note.
 */
const LADDER: [number, number][] = [[1, 2], [2, 3], [3, 2]];
const ladderAt = (t: number) => LADDER[Math.min(LADDER.length - 1, Math.floor(t * LADDER.length))];
const PROPOSED_ANCHORS: Anchor[] = PROPOSED_ORDER.map((n, i) => {
  const [c, m] = ladderAt(i / (PROPOSED_ORDER.length - 1));
  return { name: n, values: { ...byName(n).values, cratio: c, fmratio: m } };
});
/** Option 2: a little FM on the first four sounds, so their step of the ladder is heard. */
const LITTLE_FM: Record<string, number> = { 'SINE SUB': 0.12, GROWL: 0.15, ACID: 0.15, SOLID: 0.15 };
const TWO_ANCHORS: Anchor[] = PROPOSED_ANCHORS.map((a) => ({ name: a.name, values: { ...a.values, fm: LITTLE_FM[a.name] ?? a.values.fm } }));
/** INTENSITY without FM LVL (1 and 2): it still shapes the filter, its envelope, drive, reso, width. */
const NOW_EXCITE = MACROS.bass.excite;
const EXCITE_NO_FM = NOW_EXCITE.filter((e) => e.id !== 'fm');
const anchorsFor = (r: Rule) => (r === 'now' ? NOW_ANCHORS : r === 'one' ? PROPOSED_ANCHORS : TWO_ANCHORS);
const namesFor = (r: Rule) => anchorsFor(r).map((a) => a.name);

const state = { rule: 'one' as Rule, timbre: 0, intensity: 0, drums: true };

/** The bass sound at the current TIMBRE / INT under the chosen rule. */
function sound(): Record<string, number> {
  const bass = MACROS.bass as { anchors: readonly Anchor[]; excite: typeof NOW_EXCITE };
  let macro: Record<string, number>;
  if (state.rule === 'now') macro = macroSound('bass', state.timbre, state.intensity, SPECS);
  else {
    // The same TIMBRE / INT rules over the proposed sounds, INT leaving FM LVL alone; the ratio
    // pair (carrier and modulator together) follows the ladder, so it never leaves the note.
    bass.anchors = anchorsFor(state.rule);
    bass.excite = EXCITE_NO_FM;
    try { macro = macroSound('bass', state.timbre, state.intensity, SPECS); } finally { bass.anchors = NOW_ANCHORS; bass.excite = NOW_EXCITE; }
    const [c, m] = ladderAt(state.timbre);
    macro.cratio = c;
    macro.fmratio = m;
  }
  return { ...presetSound('bass', 0), ...macro, timbre: state.timbre, intensity: state.intensity };
}

/** The sound nearest a TIMBRE position under a rule. */
function nameAt(r: Rule, t: number): string {
  const n = namesFor(r);
  return n[Math.round(t * (n.length - 1))];
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
  $('timbre-v').textContent = nameAt(state.rule, state.timbre);
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
  for (const x of ['one', 'two', 'now'] as const) $(`r-${x}`).setAttribute('aria-checked', String(r === x));
  marks();
  applySound();
}

function setTimbre(t: number): void {
  state.timbre = Math.min(1, Math.max(0, t));
  timbreIn.value = String(state.timbre);
  applySound();
}

// Auto sweep: the whole knob over 16 bars, then back.
const BAR_MS = (60000 / 126) * 4;
let autoFrame = 0;
let autoStart = 0;
function stopAuto(): void {
  cancelAnimationFrame(autoFrame);
  autoFrame = 0;
  $('auto').setAttribute('aria-pressed', 'false');
}
function tick(now: number): void {
  const x = ((now - autoStart) / (16 * BAR_MS)) % 2;
  setTimbre(x < 1 ? x : 2 - x);
  autoFrame = requestAnimationFrame(tick);
}
async function toggleAuto(): Promise<void> {
  if (autoFrame) { stopAuto(); return; }
  if (!playing) await togglePlay();
  autoStart = performance.now();
  $('auto').setAttribute('aria-pressed', 'true');
  autoFrame = requestAnimationFrame(tick);
}

/** The sound names under TIMBRE (in the chosen rule's order) with their ratio. */
function marks(): void {
  const list = anchorsFor(state.rule).map((a): [string, number, number] => [a.name, a.values.cratio ?? 1, a.values.fmratio ?? 2]);
  $('names').innerHTML = list.map(([n, c, m], i) => `<button type="button" tabindex="-1" data-i="${i}" style="left:${(i / (list.length - 1)) * 100}%">${n}<small>${c}:${m}</small></button>`).join('');
}
$('names').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b) { stopAuto(); setTimbre(Number(b.dataset.i) / (namesFor(state.rule).length - 1)); }
});
timbreIn.addEventListener('input', () => { stopAuto(); setTimbre(Number(timbreIn.value)); });
intIn.addEventListener('input', () => { state.intensity = Number(intIn.value); applySound(); });
for (const x of ['one', 'two', 'now'] as const) $(`r-${x}`).addEventListener('click', () => rule(x));
$('auto').addEventListener('click', () => { void toggleAuto().catch((err) => { $('err').textContent = `Audio could not start: ${err?.message ?? err}`; }); });
$<HTMLInputElement>('drums').addEventListener('change', (e) => { state.drums = (e.target as HTMLInputElement).checked; drums(); });
playBtn.addEventListener('click', () => { void togglePlay().catch((err) => { $('err').textContent = `Audio could not start: ${err?.message ?? err}`; }); });
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.code !== 'Space') return;
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  if (e.code === 'Digit1') rule('one');
  if (e.code === 'Digit2') rule('two');
  if (e.code === 'Digit3') rule('now');
  if (e.code === 'KeyS') $('auto').click();
});
timbreIn.value = String(state.timbre);
intIn.value = String(state.intensity);
rule('one');
