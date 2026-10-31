/**
 * Colour tuner (test builds only, `VITE_COLOUR_TUNER=1`): hue / saturation / lightness
 * sliders per track type over the panel, heard nowhere, seen at once. Kept on the device
 * (localStorage); KEEP marks a combination, RESET goes back to it, DEFAULTS to the built-in
 * one; the hex list can be copied out to set `TRACK_COLOURS` for real.
 */
import type { SoundKind } from '../engine/project';
import { TRACK_COLOURS } from './colours';

const KINDS: SoundKind[] = ['kick', 'snare', 'hat', 'perc', 'bass', 'pad', 'lead', 'pluck'];
const STORE = 'groovebox.colours';
/** The combination RESET goes back to (KEEP sets it). */
const KEPT = 'groovebox.colours.kept';

function toHsl(hex: string): [number, number, number] {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(...c), min = Math.min(...c), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, Math.round(l * 100)];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === c[0] ? ((c[1] - c[2]) / d + 6) % 6 : max === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

function toHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function mountColourTuner(redraw: () => void): void {
  const defaults = { ...TRACK_COLOURS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, string>;
    for (const k of KINDS) if (/^#[0-9a-f]{6}$/.test(saved[k] ?? '')) TRACK_COLOURS[k] = saved[k];
  } catch { /* none kept */ }

  const css = document.createElement('style');
  css.textContent = `
#tuner-btn { position: fixed; top: 6px; left: 6px; z-index: 1000; font: 600 12px system-ui; padding: 6px 10px;
  background: #2b333b; color: #e9eef2; border: 1px solid #4a5560; border-radius: 4px; }
#tuner { position: fixed; top: 40px; left: 6px; z-index: 1000; width: 300px; max-height: calc(100vh - 50px); overflow-y: auto;
  background: rgba(17,20,23,0.94); border: 1px solid #4a5560; border-radius: 6px; padding: 10px; font: 12px system-ui; color: #c9d3dc;
  touch-action: pan-y; }
#tuner[hidden] { display: none; }
#tuner .tuner-row { margin-bottom: 10px; }
#tuner .head { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 4px; }
#tuner .sw { width: 28px; height: 16px; border-radius: 3px; }
#tuner label { display: grid; grid-template-columns: 14px 1fr 34px; align-items: center; gap: 6px; }
#tuner input[type=range] { width: 100%; touch-action: none; }
#tuner textarea { width: 100%; height: 120px; background: #0b0e10; color: #e9eef2; border: 1px solid #4a5560; font: 11px monospace; }
#tuner button { margin: 4px 4px 0 0; background: #2b333b; color: #e9eef2; border: 1px solid #4a5560; border-radius: 4px; padding: 4px 8px; }`;
  document.head.append(css);

  const btn = document.createElement('button');
  btn.id = 'tuner-btn';
  btn.textContent = 'COLOURS';
  const box = document.createElement('div');
  box.id = 'tuner';
  box.hidden = true;
  btn.addEventListener('click', () => { box.hidden = !box.hidden; });
  // Keep the panel's own pointer handling (and touch defaults) out of the tuner.
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'keydown'] as const) {
    box.addEventListener(ev, (e) => e.stopPropagation());
    btn.addEventListener(ev, (e) => e.stopPropagation());
  }

  const out = document.createElement('textarea');
  out.readOnly = true;
  const list = () => KINDS.map((k) => `${k.toUpperCase().padEnd(6)} ${TRACK_COLOURS[k]}`).join('\n');
  const swatches = new Map<SoundKind, HTMLElement>();
  const sliders = new Map<SoundKind, HTMLInputElement[]>();
  const apply = () => {
    for (const k of KINDS) swatches.get(k)!.style.background = TRACK_COLOURS[k];
    out.value = list();
    try { localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(KINDS.map((k) => [k, TRACK_COLOURS[k]])))); } catch { /* not kept */ }
    redraw();
  };
  const setSliders = (k: SoundKind) => {
    toHsl(TRACK_COLOURS[k]).forEach((v, i) => {
      const input = sliders.get(k)![i];
      input.value = String(v);
      (input.nextElementSibling as HTMLElement).textContent = String(v);
    });
  };

  for (const k of KINDS) {
    const row = document.createElement('div');
    row.className = 'tuner-row';
    const head = document.createElement('div');
    head.className = 'head';
    const sw = document.createElement('span');
    sw.className = 'sw';
    swatches.set(k, sw);
    head.append(sw, k.toUpperCase());
    row.append(head);
    const inputs: HTMLInputElement[] = [];
    (['H', 'S', 'L'] as const).forEach((name, i) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = i === 0 ? '359' : '100';
      const val = document.createElement('span');
      input.addEventListener('input', () => {
        const [h, s, l] = inputs.map((x) => Number(x.value));
        val.textContent = input.value;
        TRACK_COLOURS[k] = toHex(h, s, l);
        apply();
      });
      label.append(name, input, val);
      row.append(label);
      inputs.push(input);
    });
    sliders.set(k, inputs);
    box.append(row);
  }

  const copy = document.createElement('button');
  copy.textContent = 'COPY LIST';
  copy.addEventListener('click', () => { out.select(); void navigator.clipboard?.writeText(out.value).catch(() => {}); });
  // KEEP = this combination is the one RESET goes back to (kept on the device too).
  const load = (colours: Partial<Record<string, string>>) => {
    for (const k of KINDS) TRACK_COLOURS[k] = colours[k] ?? defaults[k];
    KINDS.forEach(setSliders);
    apply();
  };
  let kept: Record<string, string> = { ...TRACK_COLOURS };
  try { kept = { ...kept, ...(JSON.parse(localStorage.getItem(KEPT) ?? '{}') as Record<string, string>) }; } catch { /* none */ }
  const keep = document.createElement('button');
  keep.textContent = 'KEEP';
  keep.addEventListener('click', () => {
    kept = Object.fromEntries(KINDS.map((k) => [k, TRACK_COLOURS[k]]));
    try { localStorage.setItem(KEPT, JSON.stringify(kept)); } catch { /* not kept */ }
    keep.textContent = 'KEPT';
    setTimeout(() => { keep.textContent = 'KEEP'; }, 1000);
  });
  const reset = document.createElement('button');
  reset.textContent = 'RESET';
  reset.addEventListener('click', () => load(kept));
  const defs = document.createElement('button');
  defs.textContent = 'DEFAULTS';
  defs.addEventListener('click', () => load(defaults));
  box.append(out, copy, keep, reset, defs);
  document.body.append(btn, box);
  KINDS.forEach(setSliders);
  apply();
}
