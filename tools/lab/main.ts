/**
 * Sound lab (not part of GrooveAccess): one track's sound driven only by TIMBRE and INT on
 * the real engine, A (the app as it is) against the candidates in candidates.ts. Plays the
 * project snapshot (project.json, a copy of the app's artifact db `projects/current`) or a
 * built-in groove. Nothing here changes the app.
 */
import workletUrl from './worklet.ts?worker&url';
import stored from './project.json';
import { fromStored } from '../../src/engine/projectFile';
import { patchOf, type Project, type SoundKind } from '../../src/engine/project';
import { formatValue } from '../../src/engine/params';
import { INSTRUMENTS, SOUND_KINDS } from '../../src/instruments/registry';
import { CANDIDATES } from './candidates';
import { anchorNames, candidateIds, labSound, type Candidate } from './sound';
import { grooveProject } from './groove';
import { loudness } from './loudness';

type Source = 'project' | 'groove';
type Sweep = 'off' | 'timbre' | 'int';

const state = {
  kind: 'kick' as SoundKind,
  source: 'project' as Source,
  solo: false,
  /** Every hit on the test track rings (drums: open; the RING step flag, as PLAY's RING). */
  ring: false,
  cand: 0, // 0 = A
  timbre: 0.5,
  intensity: 0.5,
  match: true,
  sweep: 'off' as Sweep,
  bars: 8,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const LETTERS = 'ABCDE';
const candidates = (kind: SoundKind): (Candidate | null)[] => [null, ...(CANDIDATES[kind] ?? [])];
const current = () => candidates(state.kind)[state.cand] ?? null;
const snapshot = (): Project | null => fromStored((stored as { project: unknown }).project);

// ------------------------------------------------------------------ the project

interface Built { project: Project; ch: number; base: Record<string, number>; volume: number; groove: boolean }
let built: Built | null = null;

/** The project to play, with the test track found, its locks and live offsets cleared. */
function build(): Built {
  let p = state.source === 'project' ? snapshot() : null;
  let ch = p ? p.channels.findIndex((c) => c.instrument === state.kind) : -1;
  const groove = ch < 0;
  if (groove) {
    p = grooveProject();
    ch = p.channels.findIndex((c) => c.instrument === state.kind);
  }
  const project = p!;
  const c = project.channels[ch];
  for (const pat of c.patterns) for (const s of pat.steps) delete s.locks;
  c.liveOffset = {};
  project.song.rows = [];
  project.channels.forEach((o, i) => { o.mute = i === ch ? false : state.solo || o.mute; });
  return { project, ch, base: { ...patchOf(c, c.activePattern).sound }, volume: c.volume, groove };
}

// ------------------------------------------------------------------ audio

let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let playing = false;
let sent: Record<string, number> = {};
let volumeSent = -1;
const post = (msg: unknown) => node?.port.postMessage(msg);

async function ensureAudio(): Promise<void> {
  if (node) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(workletUrl);
  node = new AudioWorkletNode(ctx, 'lab-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(ctx.destination);
  node.port.onmessage = () => { if (playing) { load(); post({ type: 'transport', playing: true }); } };
}

/** (Re)build the project for the current track type and source; send it when audio runs. */
function load(): void {
  built = build();
  sent = {};
  volumeSent = -1;
  post({ type: 'loadProject', project: built.project });
  post({ type: 'setForce', channel: built.ch, ring: state.ring, slide: false });
  applySound();
}

function soundOf(c: Candidate | null): Record<string, number> {
  return labSound(state.kind, c, state.timbre, state.intensity, built!.base);
}

/** Send what changed, then the level and the readouts. */
function applySound(): void {
  if (!built) return;
  const sound = soundOf(current());
  if (node) {
    for (const id in sound) {
      if (sent[id] === sound[id]) continue;
      sent[id] = sound[id];
      post({ type: 'setSound', channel: built.ch, id, value: sound[id] });
    }
  }
  scheduleLevel();
  sendVolume();
  readout();
  table(sound);
}

// ------------------------------------------------------------------ level match

/** dB the current candidate plays louder than A (null = A or not measured yet). */
let levelDiff: number | null = null;
let levelTimer: number | undefined;
let levelBusy = false;

function scheduleLevel(): void {
  if (state.cand === 0) { levelDiff = null; window.clearTimeout(levelTimer); levelText(); return; }
  if (levelBusy) return;
  levelBusy = true;
  levelTimer = window.setTimeout(() => {
    levelBusy = false;
    if (!built || state.cand === 0) return;
    levelDiff = loudness(state.kind, soundOf(current())) - loudness(state.kind, soundOf(null));
    sendVolume();
    levelText();
  }, state.sweep === 'off' ? 150 : 600);
}

function sendVolume(): void {
  if (!built || !node) return;
  const v = built.volume * (state.match && levelDiff !== null ? Math.pow(10, -levelDiff / 20) : 1);
  if (Math.abs(v - volumeSent) < 1e-4) return;
  volumeSent = v;
  post({ type: 'setMix', channel: built.ch, id: 'volume', value: v });
}

function levelText(): void {
  const d = levelDiff;
  $('level').textContent = state.cand === 0 || d === null ? 'A is the reference.'
    : `${LETTERS[state.cand]} is ${Math.abs(d) < 0.05 ? 'as loud as' : `${Math.abs(d).toFixed(1)} dB ${d > 0 ? 'louder than' : 'quieter than'}`} A here${state.match ? ', turned to match' : ''}.`;
}

// ------------------------------------------------------------------ transport + sweep

let sweepStart = 0;
let sweepTimer: number | undefined;

async function togglePlay(): Promise<void> {
  await ensureAudio();
  await ctx!.resume();
  playing = !playing;
  if (playing) { load(); sweepStart = ctx!.currentTime; }
  post({ type: 'transport', playing });
  $('play').textContent = playing ? 'Stop' : 'Play';
  $('play').classList.toggle('on', playing);
  runSweep();
}

function runSweep(): void {
  window.clearInterval(sweepTimer);
  $('sweep-pos').textContent = '';
  if (!playing || state.sweep === 'off') return;
  sweepTimer = window.setInterval(() => {
    if (!ctx || !built) return;
    const bar = 240 / built.project.bpm;
    const u = (ctx.currentTime - sweepStart) / (state.bars * bar);
    const up = Math.floor(u) % 2 === 0;
    const v = up ? u % 1 : 1 - (u % 1);
    if (state.sweep === 'timbre') { state.timbre = v; drawTimbre(); } else { state.intensity = v; drawInt(); }
    $('sweep-pos').textContent = `${up ? '▲' : '▼'} bar ${Math.floor((u % 1) * state.bars) + 1} of ${state.bars}`;
    applySound();
  }, 40);
}

// ------------------------------------------------------------------ UI

function readout(): void {
  const names = anchorNames(state.kind, current());
  const n = names.length - 1;
  const u = state.timbre * n;
  const i = Math.min(n - 1, Math.floor(u));
  const f = u - i;
  $('timbre-val').textContent = f < 0.02 ? names[i] : f > 0.98 ? names[i + 1] : `${names[i]} → ${names[i + 1]} ${Math.round(f * 100)}%`;
  $('int-val').textContent = `${Math.round(state.intensity * 100)}%`;
  document.querySelectorAll<HTMLButtonElement>('#names button').forEach((b, k) => b.classList.toggle('on', Math.abs(u - k) < 0.02));
  document.querySelectorAll<HTMLButtonElement>('#int-marks button').forEach((b) => b.classList.toggle('on', Math.abs(Number(b.dataset.v) - state.intensity) < 0.01));
}

/** Where a parameter's knob is on the SOUND page (module, row; FUNC layer), or none. */
function knobAt(kind: SoundKind, id: string): string {
  const at = (layout: readonly (string | null)[]) => {
    const k = layout.indexOf(id);
    return k < 0 ? '' : `${(k % 8) + 1} ${k < 8 ? 'top' : 'bottom'}`;
  };
  const page = at(INSTRUMENTS[kind].layout);
  if (page) return page;
  const func = at(INSTRUMENTS[kind].funcLayout);
  return func ? `FUNC ${func}` : 'no knob';
}

let lastTable = '';
function table(sound: Record<string, number>): void {
  const kind = state.kind;
  const c = current();
  const specs = INSTRUMENTS[kind].params;
  const ids = new Set([...candidateIds(kind, null), ...candidateIds(kind, c)]);
  const a = c ? soundOf(null) : sound;
  const rows = specs.filter((p) => ids.has(p.id)).map((p) => {
    const va = formatValue(p, a[p.id]);
    const vc = c ? formatValue(p, sound[p.id]) : '';
    return `<tr><td>${p.name}</td><td class="knob-id">${knobAt(kind, p.id)}</td><td>${va}</td>${c ? `<td class="${vc !== va ? 'diff' : ''}">${vc}</td>` : ''}</tr>`;
  });
  const html = `<thead><tr><th>Setting</th><th class="knob-id">Knob</th><th>A</th>${c ? `<th>${LETTERS[state.cand]}</th>` : ''}</tr></thead><tbody>${rows.join('')}</tbody>`;
  if (html !== lastTable) { $('table').innerHTML = html; lastTable = html; }
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
const drawInt = knob('int', () => state.intensity, (v) => { state.intensity = v; });

function drawNames(): void {
  $('names').innerHTML = anchorNames(state.kind, current()).map((n, i) => `<button type="button" data-i="${i}">${n}</button>`).join('');
}
$('names').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  state.timbre = Number(b.dataset.i) / (anchorNames(state.kind, current()).length - 1);
  drawTimbre();
  applySound();
});
$('int-marks').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  state.intensity = Number(b.dataset.v);
  drawInt();
  applySound();
});

function drawCandidates(): void {
  $('cands').innerHTML = candidates(state.kind).map((c, i) => `
    <button type="button" class="cand${i === state.cand ? ' on' : ''}" data-i="${i}" aria-pressed="${i === state.cand}">
      <b>${LETTERS[i]}</b><strong>${c ? c.name.replace(/^[A-Z]: /, '') : 'THE APP NOW'}</strong>
      <span>${c ? c.note : 'TIMBRE and INT as they are in GrooveAccess today.'}</span>
    </button>`).join('');
  if (candidates(state.kind).length === 1) $('cands').insertAdjacentHTML('beforeend', '<p class="meta">No candidates for this track type yet: add them in tools/lab/candidates.ts.</p>');
}
function setCandidate(i: number): void {
  if (i >= candidates(state.kind).length) return;
  state.cand = i;
  drawCandidates();
  drawNames();
  applySound();
}
$('cands').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b) setCandidate(Number(b.dataset.i));
});

function drawKinds(): void {
  $('kinds').innerHTML = SOUND_KINDS.map((k) => `
    <button type="button" data-k="${k}" class="${k === state.kind ? 'on' : ''}" aria-pressed="${k === state.kind}" title="${(CANDIDATES[k]?.length ?? 0)} candidate(s)">
      ${INSTRUMENTS[k].name}${CANDIDATES[k]?.length ? '<span class="dot" aria-hidden="true"></span>' : ''}
    </button>`).join('');
}
/** A new track type starts where the track's own TIMBRE / INT are. */
function setKind(k: SoundKind): void {
  state.kind = k;
  state.cand = 0;
  built = build();
  state.timbre = built.base.timbre ?? 0.5;
  state.intensity = built.base.intensity ?? 0.5;
  drawKinds(); drawCandidates(); drawNames(); drawTimbre(); drawInt(); meta();
  if (node) load(); else applySound();
}
$('kinds').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b) setKind(b.dataset.k as SoundKind);
});

function meta(): void {
  if (!built) return;
  const where = built.groove
    ? (state.source === 'project' ? `Your project has no ${INSTRUMENTS[state.kind].name} track: playing the built-in groove.` : 'Built-in groove')
    : `Track ${built.ch + 1}, pattern ${'ABCD'[built.project.channels[built.ch].activePattern]}`;
  $('meta').textContent = `${where} · ${Math.round(built.project.bpm * 10) / 10} BPM`;
}

function rebuild(): void {
  if (node) load(); else built = build();
  if (playing) post({ type: 'transport', playing: true });
  meta();
}

document.querySelectorAll<HTMLInputElement>('input[name="src"]').forEach((r) => r.addEventListener('change', () => {
  state.source = r.value as Source;
  rebuild();
}));
$('ring').addEventListener('click', () => {
  state.ring = !state.ring;
  $('ring').classList.toggle('on', state.ring);
  $('ring').setAttribute('aria-pressed', String(state.ring));
  if (built) post({ type: 'setForce', channel: built.ch, ring: state.ring, slide: false });
});
$<HTMLInputElement>('solo').addEventListener('change', (e) => {
  state.solo = (e.target as HTMLInputElement).checked;
  rebuild();
});
$<HTMLInputElement>('match').addEventListener('change', (e) => {
  state.match = (e.target as HTMLInputElement).checked;
  sendVolume();
  levelText();
});
document.querySelectorAll<HTMLInputElement>('input[name="sweep"]').forEach((r) => r.addEventListener('change', () => {
  state.sweep = r.value as Sweep;
  if (ctx) sweepStart = ctx.currentTime;
  runSweep();
}));
$<HTMLSelectElement>('bars').addEventListener('change', (e) => {
  state.bars = Number((e.target as HTMLSelectElement).value);
});
$('play').addEventListener('click', () => {
  void togglePlay().catch((err: Error) => { $('err').textContent = `Audio could not start: ${err.message ?? err}. Tap Play again.`; });
});
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); return; }
  if (e.key === 'r' || e.key === 'R') { $('ring').click(); return; }
  const i = LETTERS.indexOf(e.key.toUpperCase());
  if (i >= 0 && !e.metaKey && !e.ctrlKey && !e.altKey) setCandidate(i);
});

const savedAt = (stored as { savedAt?: number }).savedAt;
$('foot').textContent = `Your project is the copy taken ${savedAt ? new Date(savedAt).toLocaleString() : 'when the lab was built'}; the lab is rebuilt with a fresh copy each time new candidates go in. The test track plays without its knob locks and live knob offsets; its other settings (envelopes, mix) are as in the project. Drag a knob up or down, scroll on it, or use the arrow keys; tap a name to jump to it. Space plays and stops; R rings every hit.`;
// Open on the track type with candidates to try (KICK when there are none).
setKind(SOUND_KINDS.find((k) => CANDIDATES[k]?.length) ?? 'kick');
