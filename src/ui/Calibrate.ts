/**
 * The calibration window, outside the groovebox: for each knob on show (and the master
 * TEMPO / LO-FI) its current value, with SET CENTRE to make that value the middle of the
 * knob's travel from now on (the range ends stay; the travel bends around it). Saved in
 * this browser and mirrored to the artifact store so the centres can become the defaults.
 */
import type { App } from './App';
import type { Panel } from './Panel';
import { calibrateOpen, setCalibrateOpen } from '../storage/calibration';

const WIDTH = 300;
const REFRESH_MS = 250;

export class Calibrate {
  private readonly box: HTMLElement;
  private readonly list: HTMLElement;
  private readonly tab: HTMLElement;
  private open = calibrateOpen();
  private timer: number | undefined;
  private lastHtml = '';

  constructor(private readonly app: App, private readonly panel: Panel) {
    this.box = document.createElement('aside');
    this.box.className = 'calib';
    this.box.innerHTML = `
      <div class="calib-head">
        <div class="calib-title">KNOB CENTRES</div>
        <button class="calib-close" title="Close">×</button>
      </div>
      <p class="calib-help">Turn a knob until it sounds right, then <b>SET CENTRE</b>: that value sits at the middle of the knob from now on (its range stays the same). Switch tracks, pages or FX to reach other knobs. Relative live knobs are always centred on the sound as set, and choices have no centre.</p>
      <div class="calib-list"></div>
      <div class="calib-foot"><button class="calib-copy">COPY ALL CENTRES</button><span class="calib-note"></span></div>`;
    this.list = this.box.querySelector('.calib-list') as HTMLElement;
    this.tab = document.createElement('button');
    this.tab.className = 'calib-tab';
    this.tab.textContent = 'KNOB CENTRES';
    document.body.append(this.box, this.tab);

    (this.box.querySelector('.calib-close') as HTMLElement).addEventListener('click', () => this.setOpen(false));
    this.tab.addEventListener('click', () => this.setOpen(true));
    this.list.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-i]') as HTMLElement | null;
      if (!b) return;
      this.app.setKnobCentre(Number(b.dataset.i), b.dataset.clear === '1');
      this.render();
    });
    (this.box.querySelector('.calib-copy') as HTMLElement).addEventListener('click', () => {
      const note = this.box.querySelector('.calib-note') as HTMLElement;
      navigator.clipboard?.writeText(this.app.centresJson()).then(
        () => { note.textContent = 'Copied'; },
        () => { note.textContent = 'Copy blocked'; },
      );
    });
    // Keep key presses and touches here from reaching the groovebox.
    for (const t of ['pointerdown', 'keydown'] as const) this.box.addEventListener(t, (e) => e.stopPropagation());
    this.setOpen(this.open);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    setCalibrateOpen(open);
    this.box.classList.toggle('open', open);
    this.tab.classList.toggle('open', open);
    this.panel.reserveRight(open ? WIDTH : 0);
    window.clearInterval(this.timer);
    if (open) {
      this.render();
      this.timer = window.setInterval(() => this.render(), REFRESH_MS);
    }
  }

  private render(): void {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = this.app.calibrationRows().map((r, i) => `
      <div class="calib-row${r.settable ? '' : ' off'}">
        <div class="calib-name"><span>${esc(r.label)}</span><small>${esc(r.where)}</small></div>
        <div class="calib-val">${esc(r.value)}${r.centre !== null ? `<small>centre ${esc(r.centre)}</small>` : ''}</div>
        ${r.settable ? `<button data-i="${i}">SET CENTRE</button>${r.centre !== null ? `<button data-i="${i}" data-clear="1" title="Back to the plain curve">×</button>` : ''}` : ''}
      </div>`).join('');
    if (html === this.lastHtml) return;
    this.lastHtml = html;
    this.list.innerHTML = html;
  }
}
