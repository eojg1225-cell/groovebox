import { emptyChannel, NUM_CHANNELS, PROJECT_VERSION, type ChannelState, type Project, type SoundKind } from './project';
import { CHORD_NAMES } from './chords';
import { INSTRUMENTS, presetSound } from '../instruments/registry';
import { defaultDrumBus, defaultSendComp, defaultSendInt, defaultSendWet } from '../fx';
import { fromStored } from './projectFile';
import { defaultLfo } from './lfo';
import startProject from './startProject.json';

/** Give a channel an instrument kind with one of its presets. */
export function applyPreset(c: ChannelState, kind: SoundKind, index: number): void {
  c.instrument = kind;
  c.sounds[kind] = presetSound(kind, index);
  c.trims[kind] = {};
  c.presets[kind] = index;
}

/** A track's type's default live knobs (LIVE 1 / 2, and 3 / 4 with FUNC). */
export function liveDefaults(c: ChannelState): void {
  if (c.instrument === 'none') return;
  c.live = [...INSTRUMENTS[c.instrument].live];
  c.liveFunc = [...INSTRUMENTS[c.instrument].liveFunc];
  c.liveOffset = {};
}

/** Where each track starts along its TIMBRE. */
const START_PRESETS = ['PUNCH', 'TIGHT', 'HAT', 'LOW TOM', 'SOLID', 'WARM', 'ODD 2:3', 'GLASS PLUCK'];

/** A fresh project: eight tracks with sounds ready, every pattern empty, nothing routed. */
export function createDefaultProject(): Project {
  // 4 = toms / percussion (pitched from the sequencer), 8 = a sync pluck with an arp.
  const kinds: SoundKind[] = ['kick', 'snare', 'hat', 'perc', 'bass', 'pad', 'lead', 'pluck'];
  const channels = Array.from({ length: NUM_CHANNELS }, (_, i) => {
    const c = emptyChannel();
    applyPreset(c, kinds[i], Math.max(0, INSTRUMENTS[kinds[i]].presets.findIndex((p) => p.name === START_PRESETS[i])));
    liveDefaults(c);
    // Drum steps play at the designed pitch (note 36); pitched steps start on the keyboard's A.
    const base = INSTRUMENTS[kinds[i]].drum ? 36 : INSTRUMENTS[kinds[i]].baseNote;
    c.patterns.forEach((p) => p.steps.forEach((s) => (s.note = base)));
    return c;
  });
  // Nothing routed: no track on FX 1-3 or the LFO (PLUCK's onboard delay / room start dry),
  // so a new project is just the sound engines, dry - clean to record track by track.
  const of = (kind: SoundKind) => channels.find((c) => c.instrument === kind) as ChannelState;
  of('pad').chord = CHORD_NAMES.indexOf('MIN9');
  // The sustained synths' trimmed output: half VOLUME sits with the drums.
  for (const kind of ['pad', 'lead', 'pluck'] as const) of(kind).volume = 0.5;
  return {
    version: PROJECT_VERSION, bpm: 128, swing: 50, master: 0.8,
    fx1: defaultDrumBus(), lfo: defaultLfo(), song: { rows: [] }, meter: 0, sendWet: defaultSendWet(), sendInt: defaultSendInt(), sendComp: defaultSendComp(), channels,
  };
}

/**
 * The start project: the sequence being worked on during development (kept in
 * startProject.json, in the stored format), with each type's default live knobs.
 * Used when there is no session or saved project.
 */
export function createStartProject(): Project {
  const p = fromStored(startProject) ?? createDefaultProject();
  for (const c of p.channels) liveDefaults(c);
  return p;
}
