import { emptyChannel, NUM_CHANNELS, PROJECT_VERSION, type ChannelState, type InstrumentKind, type Project, type SoundKind } from './project';
import { CHORD_NAMES, MAX_CHORD_NOTES } from './chords';
import { INSTRUMENTS, presetSound } from '../instruments/registry';
import { defaultBuses } from '../fx/buses';
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

/** Where each type starts along its TIMBRE. */
const START_SOUND: Record<SoundKind, string> = {
  kick: 'PUNCH', snare: 'TIGHT', hat: 'HAT', perc: 'LOW TOM', bass: 'SOLID', pad: 'WARM', lead: 'ODD 2:3', pluck: 'GLASS PLUCK',
};

/**
 * A track becomes `kind` (or OFF): the type's starting sound, live knobs and CHORD (PAD:
 * MIN9). Notes, mix and routing are left alone.
 */
export function trackDefaults(c: ChannelState, kind: InstrumentKind): void {
  c.chord = defaultChord(kind);
  c.notes = MAX_CHORD_NOTES;
  if (kind === 'none') {
    c.instrument = 'none';
    return;
  }
  applyPreset(c, kind, Math.max(0, INSTRUMENTS[kind].presets.findIndex((p) => p.name === START_SOUND[kind])));
  liveDefaults(c);
}

/** A type's starting CHORD: PAD MIN9, the rest OFF. */
export function defaultChord(kind: InstrumentKind): number {
  return kind === 'pad' ? CHORD_NAMES.indexOf('MIN9') : 0;
}

/** A type's VOLUME in a new project: the sustained synths' trimmed output sits with the drums at half. */
export function defaultVolume(kind: SoundKind): number {
  return kind === 'pad' || kind === 'lead' || kind === 'pluck' ? 0.5 : 0.8;
}

/** A fresh project: eight tracks with sounds ready, every pattern empty, nothing routed. */
export function createDefaultProject(): Project {
  // 4 = toms / percussion (pitched from the sequencer), 8 = a sync pluck with an arp.
  const kinds: SoundKind[] = ['kick', 'snare', 'hat', 'perc', 'bass', 'pad', 'lead', 'pluck'];
  const channels = Array.from({ length: NUM_CHANNELS }, (_, i) => {
    const c = emptyChannel();
    trackDefaults(c, kinds[i]);
    // Drum steps play at the designed pitch (note 36); pitched steps start on the keyboard's A.
    const base = INSTRUMENTS[kinds[i]].drum ? 36 : INSTRUMENTS[kinds[i]].baseNote;
    c.patterns.forEach((p) => p.steps.forEach((s) => (s.note = base)));
    return c;
  });
  // Routing: the drums through FX 1 (transparent until its effects are turned up), PAD to
  // FX 2, LEAD to FX 3; BASS and PLUCK carry their own effects. No track on the LFO.
  const of = (kind: SoundKind) => channels.find((c) => c.instrument === kind) as ChannelState;
  for (const c of channels) if (INSTRUMENTS[c.instrument as SoundKind].drum) c.fx1 = true;
  of('pad').fxSend = 2;
  of('lead').fxSend = 3;
  for (const c of channels) c.volume = defaultVolume(c.instrument as SoundKind);
  return {
    version: PROJECT_VERSION, bpm: 128, swing: 50, master: 0.8,
    buses: defaultBuses(), lfo: defaultLfo(), song: { rows: [] }, meter: 0, channels,
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
