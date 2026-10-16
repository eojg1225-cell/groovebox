import { emptyChannel, NUM_CHANNELS, PROJECT_VERSION, type ChannelState, type Project, type SoundKind } from './project';
import { CHORD_NAMES } from './chords';
import { INSTRUMENTS, presetSound } from '../instruments/registry';
import { defaultSendInt, defaultSendWet } from '../fx';
import { fromStored } from './projectFile';
import startProject from './startProject.json';

/** Give a channel an instrument kind with one of its presets. */
export function applyPreset(c: ChannelState, kind: SoundKind, index: number): void {
  c.instrument = kind;
  c.sounds[kind] = presetSound(kind, index);
  c.presets[kind] = index;
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
    // Drum steps play at the designed pitch (note 36); pitched steps start on the keyboard's A.
    const base = INSTRUMENTS[kinds[i]].drum ? 36 : INSTRUMENTS[kinds[i]].baseNote;
    c.patterns.forEach((p) => p.steps.forEach((s) => (s.note = base)));
    return c;
  });
  // The pad is ready for jungle chords into the reverb send; the lead into the dub delay.
  channels[4].chord = CHORD_NAMES.indexOf('MIN9');
  channels[4].fxSend = 2;
  channels[5].fxSend = 1;
  return { version: PROJECT_VERSION, bpm: 128, swing: 50, master: 0.8, sendWet: defaultSendWet(), sendInt: defaultSendInt(), lofi: 0, channels };
}

/**
 * The start project: the sequence being worked on during development (kept in
 * startProject.json, in the stored format), with live knobs on VOLUME / CUTOFF.
 * Used when there is no session or saved project.
 */
export function createStartProject(): Project {
  const p = fromStored(startProject) ?? createDefaultProject();
  for (const c of p.channels) c.live = ['mix:volume', 'mix:cutoff'];
  return p;
}
