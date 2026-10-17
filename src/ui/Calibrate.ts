/**
 * The calibration card, floating outside the groovebox's controls: the knob being turned
 * (or TEMPO / LO-FI), its value and centre, with SET CENTRE to make the current value the
 * middle of that knob's travel from now on (the range ends stay; the travel bends around
 * it). Saved in this browser and mirrored to the artifact store so the centres can become
 * the defaults.
 */
import type { App } from './App';
import { calibrateOpen, setCalibrateOpen } from '../storage/calibration';

const REFRESH_MS = 150;

export class Calibrate {
  private readonly box: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tab: HTMLElement;
  private timer: number | undefined;
  private lastHtml = '';

  constructor(private readonly app: App) {
    this.box = document.createElement('aside');
    this.box.className = 'calib';
    this.box.innerHTML = `
      <div class="calib-head"><span>KNOB CENTRE</span><button class="calib-close" title="Close">×</button></div>
      <div class="calib-body"></div>`;
    this.body = this.box.querySelector('.calib-body') as HTMLElement;
    this.tab = document.createElement('button');
    this.tab.className = 'calib-tab';
    this.tab.textContent = 'CENTRE';
    document.body.append(this.box, this.tab);

    (this.box.querySelector('.calib-close') as HTMLElement).addEventListener('click', () => this.setOpen(false));
    this.tab.addEventListener('click', () => this.setOpen(true));
    this.body.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null;
      if (!b || this.app.calibKnob < 0) return;
      this.app.setKnobCentre(this.app.calibKnob, b.dataset.act === 'clear');
      this.render();
    });
    // Keep key presses and touches here from reaching the groovebox.
    for (const t of ['pointerdown', 'keydown'] as const) this.box.addEventListener(t, (e) => e.stopPropagation());
    this.setOpen(calibrateOpen());
  }

  private setOpen(open: boolean): void {
    setCalibrateOpen(open);
    this.box.classList.toggle('open', open);
    this.tab.classList.toggle('open', open);
    window.clearInterval(this.timer);
    if (open) {
      this.render();
      this.timer = window.setInterval(() => this.render(), REFRESH_MS);
    }
  }

  private render(): void {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const i = this.app.calibKnob;
    const r = i >= 0 ? this.app.calibrationRows()[i] : undefined;
    let html: string;
    if (!r || r.label === '-') {
      html = '<div class="calib-hint">Turn a knob, then save where it sounds right as the middle of its travel.</div>';
    } else if (!r.settable) {
      html = `<div class="calib-name">${esc(r.label)}<small>${esc(r.where)}</small></div><div class="calib-val">${esc(r.value)}</div>
        <div class="calib-hint">No centre for this one (a relative live knob or a choice).</div>`;
    } else {
      html = `<div class="calib-name">${esc(r.label)}<small>${esc(r.where)}</small></div>
        <div class="calib-val">${esc(r.value)}<small>${r.centre !== null ? `centre ${esc(r.centre)}` : 'no centre set'}</small></div>
        <div class="calib-btns"><button data-act="set">SAVE AS CENTRE</button>${r.centre !== null ? '<button data-act="clear" title="Back to the plain curve">CLEAR</button>' : ''}</div>`;
    }
    if (html === this.lastHtml) return;
    this.lastHtml = html;
    this.body.innerHTML = html;
  }
}
