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

/**
 * PAD candidate C: 2 STACKS (Synth algo 2), two modulator -> carrier pairs. Stack 1 = carrier
 * 1 under a modulator at FM RATIO 1 (1:1, saw-like as it rises); stack 2 = a carrier an octave
 * up under a modulator at RATIO 3 = 4 (odd sidebands around it: a bell). The ratios are the
 * same in every sound, so TIMBRE never steps.
 */
export const PAD_C_ANCHORS: Anchor[] = [
  { name: 'GLASS', values: { cfeedback: 0, shape: 0, fm: 0.55, fmratio: 1, ratio2: 2, ratio3: 4, feedback: 0.1, carriers: 0.6, cutoff: 8000, reso: 0.1, fattack: 0.0005, fenv: 0.25, fdecay: 0.8, drive: 1 } },
  { name: 'TINE', values: { cfeedback: 0, shape: 0, fm: 0.62, fmratio: 1, ratio2: 2, ratio3: 4, feedback: 0.15, carriers: 0.45, cutoff: 6000, reso: 0.1, fattack: 0.0005, fenv: 0.7, fdecay: 0.5, drive: 1.1 } },
  { name: 'WARM', values: { cfeedback: 0, shape: 1.5, fm: 0.4, fmratio: 1, ratio2: 2, ratio3: 4, feedback: 0.35, carriers: 0.25, cutoff: 1000, reso: 0.15, fattack: 0.0005, fenv: 0.1, fdecay: 1, drive: 1.1 } },
  { name: 'STRINGS', values: { cfeedback: 0, shape: 2, fm: 0.45, fmratio: 1, ratio2: 2, ratio3: 4, feedback: 0.45, carriers: 0.35, cutoff: 2600, reso: 0.1, fattack: 0.3, fenv: 0.15, fdecay: 1.5, drive: 1.1 } },
  { name: 'ETHEREAL', values: { cfeedback: 0, shape: 0.5, fm: 0.6, fmratio: 1, ratio2: 2, ratio3: 4, feedback: 0.2, carriers: 0.7, cutoff: 9000, reso: 0.1, fattack: 0.0005, fenv: 0.3, fdecay: 1.5, drive: 1 } },
];

/**
 * C's INT: today's PAD rules (FM / feedback / carriers biting in the top quarter), with FM
 * topping out at level 92 instead of 99 (index ~7 instead of 13).
 */
export const PAD_C_EXCITE: Excite[] = [
  { id: 'fm', floor: 0, knee: 0.6, top: 0.92 }, { id: 'feedback', floor: 0, knee: 0.6, top: 1 }, { id: 'carriers', floor: 0, knee: 0.6, top: 1 },
  { id: 'fenv', floor: 0, high: 1.3 }, { id: 'reso', floor: 0.05, high: 1.2 },
  { id: 'cutoff', floor: 400, high: 1.4 }, { id: 'drive', floor: 1, high: 1.5 },
  { id: 'cfeedback', floor: 0, knee: 0.25, top: 1 },
];

/**
 * GENTLE INT: the same rules with the top end lowered (below the middle is unchanged). FM
 * tops out at level ~78 (index ~1.9) instead of 99 (13), feedback and carrier feedback stop
 * well short of fizz, and cutoff / drive / envelope rise less.
 */
export function gentle(excite: readonly Excite[]): Excite[] {
  const tops: Record<string, number> = { fm: 0.78, feedback: 0.6, carriers: 0.8, cfeedback: 0.35 };
  const highs: Record<string, number> = { cutoff: 1.15, drive: 1.15, fenv: 1.1, reso: 1.05, detune: 1.15, unison: 1.1 };
  return excite.map((e) => {
    const g = { ...e };
    if (g.top !== undefined && tops[g.id] !== undefined) {
      g.top = tops[g.id];
      if (g.knee !== undefined) g.knee = Math.min(g.knee, g.top);
    }
    if (g.high !== undefined) g.high = g.id === 'fm' ? 1.12 : highs[g.id] ?? g.high;
    return g;
  });
}

/**
 * C with A's ratios: the same sounds, but each takes today's PAD ratios (FM RATIO = stack 1's
 * modulator, RATIO 2 = stack 2's carrier, RATIO 3 = stack 2's modulator), so the ratios step
 * through related ratios as TIMBRE moves (1 -> 4/3 -> 3/2 -> 2 ...), as on A.
 */
export function withRatios(list: readonly Anchor[], from: readonly Anchor[]): Anchor[] {
  return list.map((a) => {
    const src = from.find((f) => f.name === a.name)!.values;
    return { name: a.name, values: { ...a.values, fmratio: src.fmratio, ratio2: src.ratio2, ratio3: src.ratio3 } };
  });
}

/**
 * PAD candidate E: C reworked. Soft -> bell-like (WARM, STRINGS, TINE, GLASS, ETHEREAL), so
 * turning TIMBRE right moves from the plain pads to the bells; WARM gets plain 1:1:1
 * ratios (A's 0.5 was a sub carrier there, a buzzing modulator here); the others keep A's.
 * Its ratios step through whole and half steps only (E_RATIO_STEPS): no thirds or quarters,
 * so every stop on the way is harmonic or an octave down, never out of tune with a chord.
 */
const E_RATIO_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8];

export function snapHalves(r: number): number {
  let best = E_RATIO_STEPS[0];
  for (const s of E_RATIO_STEPS) if (Math.abs(Math.log(s / r)) < Math.abs(Math.log(best / r))) best = s;
  return best;
}

export function padE(cStepped: readonly Anchor[]): Anchor[] {
  const by = (n: string) => cStepped.find((a) => a.name === n)!;
  const warm = by('WARM');
  return [
    { name: 'WARM', values: { ...warm.values, fmratio: 1, ratio2: 1, ratio3: 1 } },
    by('STRINGS'), by('TINE'), by('GLASS'), by('ETHEREAL'),
  ];
}

/** A: the PAD before v32 (3 CARRIER engine), kept here for comparison. */
export const PAD_A_ANCHORS: Anchor[] = [
  { name: 'GLASS', values: { cfeedback: 0, fattack: 0.0005, shape: 0, fm: 0.72, fmratio: 2, ratio2: 2, ratio3: 3, feedback: 0.1, carriers: 0.4, cutoff: 7000, reso: 0.1, fenv: 0.3, fdecay: 0.8, drive: 1 } },
  { name: 'TINE', values: { cfeedback: 0, fattack: 0.0005, shape: 0, fm: 0.78, fmratio: 1, ratio2: 1, ratio3: 4, feedback: 0.2, carriers: 0.3, cutoff: 6000, reso: 0.1, fenv: 0.6, fdecay: 0.6, drive: 1.1 } },
  { name: 'WARM', values: { cfeedback: 0, fattack: 0.0005, shape: 2, fm: 0.45, fmratio: 1, ratio2: 1, ratio3: 0.5, feedback: 0.3, carriers: 0.45, cutoff: 900, reso: 0.15, fenv: 0.1, fdecay: 1, drive: 1 } },
  { name: 'STRINGS', values: { cfeedback: 0, fattack: 0.0005, shape: 2, fm: 0.5, fmratio: 1, ratio2: 1.5, ratio3: 2, feedback: 0.35, carriers: 0.35, cutoff: 2600, reso: 0.1, fenv: 0.15, fdecay: 1, drive: 1.2 } },
  { name: 'ETHEREAL', values: { cfeedback: 0, shape: 0, fm: 0.7, fmratio: 7, ratio2: 3, ratio3: 5, feedback: 0.25, carriers: 0.6, cutoff: 9000, reso: 0.1, fattack: 0.0005, fenv: 0.25, fdecay: 1.2, drive: 1 } },
];

export const PAD_A_EXCITE: Excite[] = [
  { id: 'fm', floor: 0, knee: 0.6, top: 1 }, { id: 'feedback', floor: 0, knee: 0.6, top: 1 }, { id: 'carriers', floor: 0, knee: 0.6, top: 1 },
  { id: 'fenv', floor: 0, high: 1.3 }, { id: 'reso', floor: 0.05, high: 1.2 },
  { id: 'cutoff', floor: 400, high: 1.4 }, { id: 'drive', floor: 1, high: 1.5 },
  { id: 'cfeedback', floor: 0, knee: 0.25, top: 1 },
];
