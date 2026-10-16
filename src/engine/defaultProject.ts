import { emptyChannel, NUM_CHANNELS, PROJECT_VERSION, type ChannelState, type Project, type SoundKind } from './project';
import { CHORD_NAMES } from './chords';
import { INSTRUMENTS, presetSound } from '../instruments/registry';

/** Give a channel an instrument kind with one of its presets. */
export function applyPreset(c: ChannelState, kind: SoundKind, index: number): void {
  c.instrument = kind;
  c.sounds[kind] = presetSound(kind, index);
  c.presets[kind] = index;
  c.live = [...INSTRUMENTS[kind].presets[index].live];
}

const presetIndex = (kind: SoundKind, name: string) => INSTRUMENTS[kind].presets.findIndex((p) => p.name === name);

/**
 * A fresh project: six tracks with sounds ready, but every pattern empty.
 */
export function createDefaultProject(): Project {
  const layout: [SoundKind, string][] = [
    ['drum', 'KICK'], ['drum', 'SNARE'], ['drum', 'HAT'], ['drum', 'METAL'], ['synth', 'BASS'], ['synth', 'STAB'],
  ];
  const channels = Array.from({ length: NUM_CHANNELS }, (_, i) => {
    const c = emptyChannel();
    const [kind, name] = layout[i];
    applyPreset(c, kind, presetIndex(kind, name));
    return c;
  });
  // Track 6: a minor-ninth stab in a mid register, ready for jungle chords.
  channels[5].chord = CHORD_NAMES.indexOf('MIN9');
  channels[5].patterns.forEach((p) => p.steps.forEach((s) => (s.note = 48)));
  return { version: PROJECT_VERSION, bpm: 128, swing: 50, master: 0.8, channels };
}
