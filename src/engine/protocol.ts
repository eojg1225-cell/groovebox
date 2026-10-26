/**
 * Message protocol between the main thread (UI) and the audio worklet.
 * Plain data only, so it survives structured cloning and can be documented / ported.
 */
import type { InstrumentKind, PatternSpeed, Project, Song, Step } from './project';
import type { LfoId } from './lfo';

export type MixParam = 'volume' | 'pan' | 'mute' | 'send' | 'dyn' | 'gate' | 'cut' | 'ring';
/** meter: the time signature (index into METERS); playing, it changes at the next bar line. */
export type GlobalParam = 'bpm' | 'swing' | 'master' | 'meter';

export type MainToWorklet =
  /** Replace the whole engine state (startup, session restore). */
  | { type: 'loadProject'; project: Project }
  | { type: 'setStep'; channel: number; pattern: number; index: number; step: Step }
  | { type: 'setPatternLength'; channel: number; pattern: number; length: number }
  /** Half / double / triplet time for one pattern (its steps last 2 / 0.5 / 4/3 master 16ths). */
  | { type: 'setPatternSpeed'; channel: number; pattern: number; speed: PatternSpeed }
  /**
   * Switch pattern; quantised to the end of the channel's loop unless immediate or stopped.
   * Its patch glides in from now until then (coarse settings switch with the pattern); the
   * playing pattern again = a waiting switch is cancelled (the sound glides back).
   */
  | { type: 'selectPattern'; channel: number; pattern: number; immediate: boolean }
  /** Pattern `pattern`'s whole patch; glide = (playing) glide there by the next bar line. */
  | { type: 'setPatch'; channel: number; pattern: number; sound: Record<string, number>; glide: boolean }
  /** RESET with notes: a pattern's (saved) notes replace its steps at the next bar line. */
  | { type: 'swapNotes'; channel: number; pattern: number; length: number; steps: Step[]; speed?: PatternSpeed }
  /** Change a channel's instrument (clears its parameter locks) and set its full sound. */
  | { type: 'setInstrument'; channel: number; kind: InstrumentKind; sound: Record<string, number> }
  /** Chord mode index (0 = off). */
  | { type: 'setChord'; channel: number; chord: number }
  /** NOTES: how many of the chord's tones play (1..MAX_CHORD_NOTES). */
  | { type: 'setNotes'; channel: number; notes: number }
  /**
   * PLAY mode RING / SLIDE / ACCENT / GHOST: every note on the track plays as a RING /
   * SLIDE (ROLL) note, and at this velocity (0 = its own; accent 1, ghost 0.45).
   */
  | { type: 'setForce'; channel: number; ring: boolean; slide: boolean; velocity?: number }
  /** Release a note started with trigger/recordNote (note = the played root). */
  | { type: 'release'; channel: number; note: number }
  /**
   * Instrument parameter in real units, in pattern `pattern`'s patch (absent = the pattern
   * switched to, else the one playing); heard when that pattern plays.
   */
  | { type: 'setSound'; channel: number; id: string; value: number; pattern?: number }
  /** A relative LIVE knob (id = macro or sound param), -1..1 (0 = centred). */
  | { type: 'setOffset'; channel: number; id: string; value: number }
  | { type: 'setMix'; channel: number; id: MixParam; value: number }
  | { type: 'setGlobal'; id: GlobalParam; value: number }
  /**
   * How late the player hears the engine (output latency + touch delay, ms): live-recorded
   * notes and knob moves land where they were heard, not where the engine is.
   */
  | { type: 'setListenLatency'; ms: number }
  /** Route a track to send FX 2 or FX 3 (0 = none). */
  | { type: 'setRouting'; channel: number; send: number }
  /** Pass a track through FX 1, the drum bus, or not. */
  | { type: 'setDrumBus'; channel: number; on: boolean }
  /** An FX bus parameter (bus 0-2 = FX 1-3; BUS_PARAMS id), real units / TYPE index. */
  | { type: 'setBus'; bus: number; id: string; value: number }
  /** LFO setting (rate/shape as option indices, vol / pan 0..1, pitch in semitones, filter in octaves). */
  | { type: 'setLfo'; id: LfoId; value: number }
  /** Put a track on / off the LFO. */
  | { type: 'setLfoTrack'; channel: number; on: boolean }
  /**
   * Start / stop. song = play the song (from row fromRow) instead of the patterns. Patterns:
   * fromStep (a bar line of track fromChannel's pattern, absent = the top) = every track
   * starts where it would be had all played from the top until that track reached that step.
   * countIn = bars of clicks before the music starts (COUNT-IN).
   */
  /**
   * `gen`: the UI's transport count. STOP also goes as the node's `stop` AudioParam (it gets
   * through when an overloaded audio thread holds messages back); a transport message older
   * than a STOP already applied that way is dropped.
   */
  | { type: 'transport'; playing: boolean; song?: boolean; fromRow?: number; fromChannel?: number; fromStep?: number; countIn?: number; gen?: number }
  /** METRONOME: the click on the beats while playing (on), and its level 0..1 (COUNT-IN too). */
  | { type: 'setClick'; on: boolean; level: number }
  /** Replace the song (sent after every song edit; small). */
  | { type: 'setSong'; song: Song }
  /** While the song plays: go to this row at the next bar line. */
  | { type: 'songJump'; row: number }
  /** Audition / play a note on a channel now. */
  /** slideFrom: a held note this one glides from (legato), -1 / absent = a new note. */
  | { type: 'trigger'; channel: number; note: number; velocity: number; slideFrom?: number }
  /**
   * Motion record: play the note now and, if playing, write it into the nearest step of
   * the channel's playing pattern. The worklet answers with "recordedNote".
   */
  | { type: 'recordNote'; channel: number; note: number; velocity: number; accent: boolean; slide?: boolean; chord?: boolean }
  /**
   * Motion record: lock a sound parameter on the step playing now (and hear it now).
   * The worklet answers with "recordedLock".
   */
  | { type: 'recordLock'; channel: number; id: string; value: number }
  /** Round-trip timing probe; the worklet answers with "pong" carrying the same id. */
  | { type: 'ping'; id: number };

export type WorkletToMain =
  | { type: 'ready'; sampleRate: number }
  /** The engine's output went non-finite: the worklet started a fresh engine (resend state). */
  | { type: 'engineReset' }
  /**
   * ~30 Hz. steps[ch] is the step index last played (-1 when stopped);
   * patterns[ch] is the pattern currently playing.
   */
  | {
      type: 'status';
      peakL: number;
      peakR: number;
      frame: number;
      playing: boolean;
      steps: number[];
      patterns: number[];
      /** Position in the bar (of the time signature), 0..1 (0 when stopped). */
      barPhase: number;
      /** The bar playing, in 16th steps (the time signature). */
      barSteps: number;
      /** Song playback: the row playing and the bar within it (-1 / 0 when not in song mode). */
      songRow: number;
      songBar: number;
      /** DSP load: time spent in process() / the audio's own time (1 = the audio thread is out of time). */
      load: number;
      /** COUNT-IN: beats still to go before the music starts (0 = none). */
      countIn: number;
    }
  | { type: 'pong'; id: number }
  | {
      type: 'recordedNote';
      channel: number; pattern: number; index: number;
      note: number; velocity: number; accent: boolean;
      /** Length in steps; a second message updates it when the key is released. */
      gate: number;
      /** Played legato from the previous held note. */
      slide: boolean;
      /** A new note on the step (it replaces what was there, chord notes too). */
      start?: boolean;
    }
  | { type: 'recordedLock'; channel: number; pattern: number; index: number; id: string; value: number }
  /**
   * PAD: a note played with the one being recorded went onto its step (Step.extra), one step
   * long; sent again with its own length (gate) when its key is released.
   */
  | { type: 'recordedChord'; channel: number; pattern: number; index: number; note: number; gate: number };

export const STATUS_HZ = 30;
