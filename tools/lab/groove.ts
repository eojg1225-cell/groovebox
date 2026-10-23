/**
 * The built-in groove: a plain 16-step loop on every track of a fresh project (KICK four on
 * the floor, SNARE on 2 and 4, HAT off-beats, PERC fills, an off-beat BASS, a held PAD
 * chord, a LEAD riff, PLUCK stabs), so any track type can be heard in context.
 */
import { createDefaultProject } from '../../src/engine/defaultProject';
import { setStepDynamic, type Project, type Step } from '../../src/engine/project';

type Hit = [index: number, note?: number, gate?: number, accent?: boolean];

const GROOVE: Hit[][] = [
  [[0], [4], [8], [12]],
  [[4], [12], [15, undefined, 1, false]],
  [[2], [6], [10], [14], [7], [15]],
  [[3, 0], [11, 3], [14, 7]],
  [[2, 0], [6, 0], [7, 12], [10, 0], [14, 3]],
  [[0, 0, 16]],
  [[0, 12, 2], [3, 15, 1], [6, 19, 2], [10, 17, 1], [12, 15, 4]],
  [[2, 0], [6, 3], [10, 0, 1, true], [13, 7]],
];

export function grooveProject(): Project {
  const p = createDefaultProject();
  p.bpm = 128;
  p.channels.forEach((c, ch) => {
    const pat = c.patterns[c.activePattern];
    pat.length = 16;
    for (const [i, note, gate, accent] of GROOVE[ch]) {
      const s: Step = pat.steps[i];
      s.active = true;
      if (note !== undefined) s.note += note;
      if (gate !== undefined) s.gate = gate;
      if (accent) setStepDynamic(s, 'accent');
    }
  });
  return p;
}
