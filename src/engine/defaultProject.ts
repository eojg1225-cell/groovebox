import { emptyChannel, NUM_CHANNELS, PROJECT_VERSION, type ChannelState, type Project, type SoundKind } from './project';
import { CHORD_NAMES } from './chords';
import { INSTRUMENTS, presetSound } from '../instruments/registry';
import { defaultFx } from '../fx';

/** Give a channel an instrument kind with one of its presets. */
export function applyPreset(c: ChannelState, kind: SoundKind, index: number): void {
  c.instrument = kind;
  c.sounds[kind] = presetSound(kind, index);
  c.presets[kind] = index;
  c.live = [...INSTRUMENTS[kind].presets[index].live];
}

/**
 * A fresh project: six tracks with sounds ready (kick, snare, hat, bass, pad, lead),
 * every pattern empty.
 */
export function createDefaultProject(): Project {
  const kinds: SoundKind[] = ['kick', 'snare', 'hat', 'bass', 'pad', 'lead'];
  const channels = Array.from({ length: NUM_CHANNELS }, (_, i) => {
    const c = emptyChannel();
    applyPreset(c, kinds[i], 0);
    const base = INSTRUMENTS[kinds[i]].baseNote;
    c.patterns.forEach((p) => p.steps.forEach((s) => (s.note = base)));
    return c;
  });
  // The pad is ready for jungle chords; a touch of dub delay on the pad and lead.
  channels[4].chord = CHORD_NAMES.indexOf('MIN9');
  channels[4].sends[0] = 0.25;
  channels[5].sends[0] = 0.3;
  return { version: PROJECT_VERSION, bpm: 128, swing: 50, master: 0.8, fx: defaultFx(), channels };
}
