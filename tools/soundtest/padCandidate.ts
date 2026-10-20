/**
 * PAD candidate for the A/B test: the BASS engine (algo 0: SHAPE's wave crossfaded with one
 * FM pair, then the filter) with five pad sounds. Every sound shares FM RATIO 4 (odd
 * sidebands 1, 3, 5, 7 ...), so TIMBRE only moves continuous settings and never steps.
 */
import type { Anchor, Excite } from '../../src/instruments/macros';

export const PAD_B_ANCHORS: Anchor[] = [
  { name: 'GLASS', values: { shape: 0, fm: 0.6, fmratio: 4, detune: 0.2, unison: 0, cutoff: 8000, reso: 0.1, fattack: 0.0005, fenv: 0.25, fdecay: 0.8, drive: 1 } },
  { name: 'TINE', values: { shape: 0.3, fm: 0.5, fmratio: 4, detune: 0.15, unison: 0, cutoff: 5000, reso: 0.1, fattack: 0.0005, fenv: 0.8, fdecay: 0.5, drive: 1.1 } },
  { name: 'WARM', values: { shape: 2, fm: 0.1, fmratio: 4, detune: 0.3, unison: 0.3, cutoff: 900, reso: 0.15, fattack: 0.0005, fenv: 0.15, fdecay: 1, drive: 1.2 } },
  { name: 'STRINGS', values: { shape: 2, fm: 0.05, fmratio: 4, detune: 0.5, unison: 1, cutoff: 2400, reso: 0.1, fattack: 0.3, fenv: 0.2, fdecay: 1.5, drive: 1.1 } },
  { name: 'ETHEREAL', values: { shape: 3, fm: 0.45, fmratio: 4, detune: 0.35, unison: 0.6, cutoff: 7000, reso: 0.2, fattack: 0.0005, fenv: 0.3, fdecay: 1.5, drive: 1 } },
];

export const PAD_B_EXCITE: Excite[] = [
  { id: 'fm', floor: 0, high: 1.4 }, { id: 'fenv', floor: 0, high: 1.3 }, { id: 'reso', floor: 0.05, high: 1.2 },
  { id: 'cutoff', floor: 400, high: 1.4 }, { id: 'drive', floor: 1, high: 1.5 },
  { id: 'detune', floor: 0.05, high: 1.3 }, { id: 'unison', floor: 0, high: 1.2 },
];
