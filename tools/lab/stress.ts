/**
 * The stress groove for the maths A / B: every track on the sound that leans hardest on the
 * approximated maths (sines, tanh, powers), with the effects that do too, so the exact (A)
 * and fast (B) engines can be compared on everything at once.
 *  KICK  PSY DOOF, INT 100: the 7-octave sweep (2^x every sample), DRIVE (tanh).
 *  SNARE INDUSTRIAL, INT 85: FM metal (sines), DRIVE, CRUSH (sensitive to the last bit).
 *  HAT   RIDE: the bell's eight sine partials and its FM metal, 16ths.
 *  PERC  COWBELL, INT 90, DRIVE.
 *  BASS  FM 2:3, INT 90: the FM pair (sines), DRIVE.
 *  PAD   ETHEREAL: sine waves, UNISON, high FEEDBACK (FM feedback: small differences grow).
 *  LEAD  ODD 2:3: FEEDBACK and CAR FB, DRIVE, on the LFO (its cosine: pitch and filter).
 *  PLUCK RAGE DONK: DRIVE 12, its onboard delay (tanh in the feedback).
 *  FX 1  COMP, PHASER (sine-swept, 2^x), TAPE delay (tanh, wow).
 *  FX 2  CHORUS, TAPE delay, SHIMMER verb (sine-windowed).
 *  FX 3  FUZZ (tanh), DUB TAPE at FDBK 0.95, SPRING verb (tanh).
 */
import { createDefaultProject } from '../../src/engine/defaultProject';
import { setStepDynamic, type Project, type SoundKind, type Step } from '../../src/engine/project';
import { MACROS, anchorPosition, macroSound } from '../../src/instruments/macros';
import { INSTRUMENTS, presetSound } from '../../src/instruments/registry';

type Hit = [index: number, note?: number, gate?: number, accent?: boolean, slide?: boolean];

interface TrackSetup { anchor: string; intensity: number; extra: Record<string, number>; hits: Hit[] }

const TRACKS: Record<SoundKind, TrackSetup> = {
  kick: { anchor: 'PSY DOOF', intensity: 1, extra: { drive: 6 }, hits: [[0], [4], [8], [12]] },
  snare: { anchor: 'INDUSTRIAL', intensity: 0.85, extra: {}, hits: [[4], [12], [14, undefined, 1, false]] },
  hat: { anchor: 'RIDE', intensity: 0.6, extra: {}, hits: Array.from({ length: 16 }, (_, i): Hit => [i, undefined, undefined, i % 4 === 2]) },
  perc: { anchor: 'COWBELL', intensity: 0.9, extra: { drive: 3 }, hits: [[3, 0], [7, 0], [11, 0], [15, 7]] },
  bass: { anchor: 'FM 2:3', intensity: 0.9, extra: { drive: 3 }, hits: [[0, 0, 2], [2, 0], [3, 12, 1, false, true], [4, 0], [7, 3], [10, 0, 2], [14, 7]] },
  pad: { anchor: 'ETHEREAL', intensity: 0.7, extra: { feedback: 0.9, unison: 1, shape: 0 }, hits: [[0, 0, 16]] },
  lead: { anchor: 'ODD 2:3', intensity: 0.8, extra: { feedback: 0.8, cfeedback: 0.6, drive: 3 }, hits: [[0, 12, 2], [3, 15, 1], [6, 19, 2], [10, 17, 1], [12, 15, 4]] },
  pluck: { anchor: 'RAGE DONK', intensity: 0.7, extra: { dmix: 0.5, verb: 0.5, dfdbk: 0.7 }, hits: [[2, 0], [6, 3], [10, 0, 1, true], [13, 7]] },
};

/** The stress project, and the per-track settings that stay on top of TIMBRE / INT. */
export function stressProject(): { project: Project; extra: Partial<Record<SoundKind, Record<string, number>>> } {
  const p = createDefaultProject();
  p.bpm = 132;
  const extra: Partial<Record<SoundKind, Record<string, number>>> = {};
  for (const c of p.channels) {
    if (c.instrument === 'none') continue;
    const kind = c.instrument;
    const t = TRACKS[kind];
    const i = MACROS[kind].anchors.findIndex((a) => a.name === t.anchor);
    const timbre = anchorPosition(kind, i);
    c.sounds[kind] = { ...presetSound(kind, i), ...macroSound(kind, timbre, t.intensity, INSTRUMENTS[kind].params), timbre, intensity: t.intensity, ...t.extra };
    c.trims[kind] = {};
    extra[kind] = t.extra;
    const pat = c.patterns[c.activePattern];
    pat.length = 16;
    for (const [idx, note, gate, accent, slide] of t.hits) {
      const s: Step = pat.steps[idx];
      s.active = true;
      if (note !== undefined) s.note += note;
      if (gate !== undefined) s.gate = gate;
      if (accent) setStepDynamic(s, 'accent');
      if (slide) s.slide = true;
    }
    if (kind === 'lead') c.lfoOn = true;
  }
  const bus = (k: number, values: Record<string, number>) => Object.assign(p.buses[k], values);
  bus(0, { cmp_ratio: 4, cmp_thresh: -20, mod_vol: 0.4, mod_type: 1, mod_depth: 0.8, dly_vol: 0.25, dly_type: 0, dly_fdbk: 0.6 });
  bus(1, { mod_vol: 0.3, mod_type: 0, dly_vol: 0.2, dly_type: 2, vrb_vol: 0.4, vrb_type: 2 });
  bus(2, { drv_vol: 0.6, drv_type: 1, drv_drive: 0.8, dly_vol: 0.4, dly_type: 1, dly_fdbk: 0.95, vrb_vol: 0.3, vrb_type: 2 });
  Object.assign(p.lfo, { pitch: 0.15, filter: 0.4 });
  return { project: p, extra };
}
