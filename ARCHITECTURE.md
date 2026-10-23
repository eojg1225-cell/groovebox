# Architecture

How the code is put together. For what the app does (controls, modes, sounds), see the
**Current state** section of `CLAUDE.md`; for how it got here, `docs/HISTORY.md`.

```
src/engine       Pure engine: project model (project.ts), stored format + load migrations (projectFile.ts),
                 params, smoothing, protocol, chords, LFO, Engine (sequencer, mixer, buses, master). No DOM/Web Audio.
src/instruments  Instrument interface, registry (8 track types, their pages, live knobs), Drum (layered),
                 Synth (up to 6 voices, FM algorithms), macros (TIMBRE / INTENSITY), trims, driveComp, DSP. No DOM/Web Audio.
src/fx           buses.ts (FX 1-3: units, TYPE lists, knob specs, layout, defaults), FxBus (one bus),
                 units.ts (MOD, DELAY, VERB, DIST), Compressor, TrackCut (per-track MID CUT), Limiter,
                 Delay + Reverb (PLUCK's onboard delay / room). No DOM/Web Audio.
src/worklet      processor.ts: AudioWorkletProcessor hosting Engine (audio thread)
                 host.ts: main-thread AudioContext + AudioWorkletNode bridge (the only Web Audio code)
src/controls     ControlSurface event interface (knob / encoder / button, values normalised 0..1)
src/ui           App (controller), Panel (on-screen ControlSurface), Knob, PixelScreen (256x128 canvas,
                 3x5 font), views (screen view-models -> drawing), orientation
src/storage      projects.ts (64 slots, ProjectStore), slotSync.ts (slots <-> claude.ai artifact db),
                 cloud.ts (working project mirror), saved.ts (reads old USER patches)
tests            Vitest: the engine offline in Node, project storage / sync, the App via button events
tools/lab        The sound lab: A/B page for TIMBRE / INT candidates (not part of the app)
```

The "no DOM / no Web Audio" rule for engine, instruments and fx is enforced: `tsconfig.engine.json`
type-checks those folders with only the ES lib, and `npm run build` runs it. `npm run unused` (knip)
fails on unused files or exports.

## Data flow

```
Panel (pointer / keyboard) --ControlEvent--> App --project edit + MainToWorklet--> AudioHost.send()
     --postMessage--> processor.ts --> Engine.handleMessage() ... Engine.process() each 128-frame block
processor.ts --status @30 Hz / pong / recorded*--> AudioHost --> App --> views --> PixelScreen (requestAnimationFrame)
```

`App` owns the project (the UI-side source of truth). Every edit changes the project and sends the
matching message; `loadProject` replaces the engine's state wholesale (startup, load, engine restart).
The UI computes sounds (TIMBRE / INTENSITY + trims) and sends plain parameter values: the engine never
sees macros, only relative live-knob offsets.

## Message protocol (`src/engine/protocol.ts`)

Main -> worklet:
| type | fields | meaning |
|---|---|---|
| `loadProject` | `project` | Replace all engine state |
| `setStep` | `channel`, `pattern`, `index`, `step` | Write one step (incl. its locks) |
| `setPatternLength` | `channel`, `pattern`, `length` | 1-64 steps |
| `setPatternSpeed` | `channel`, `pattern`, `speed` | normal / double / half / triplet |
| `selectPattern` | `channel`, `pattern`, `immediate` | Switch pattern at the next bar line where the loop starts (or now, if `immediate` / stopped); its patch glides in until then (coarse params at the switch); the playing pattern again cancels (glides back) |
| `setPatch` | `channel`, `pattern`, `sound`, `glide` | A pattern's whole patch (COPY, RESET); `glide` = glide there by the next bar line |
| `swapNotes` | `channel`, `pattern`, `length`, `steps`, `speed?` | RESET with notes: the saved notes replace the pattern's at the next bar line |
| `setInstrument` | `channel`, `kind`, `sound` | Change a track's type (clears its locks) and set its full sound |
| `setChord` | `channel`, `chord` | Chord index (0 = off) |
| `setNotes` | `channel`, `notes` | NOTES: how many of the chord's tones play |
| `setForce` | `channel`, `ring`, `slide`, `velocity?` | PLAY's RING / SLIDE (ROLL) / ACCENT / GHOST on every note of the track |
| `release` | `channel`, `note` | Release a live note (the played root); ends a live-recorded note's length |
| `setSound` | `channel`, `id`, `value`, `pattern?` | Instrument parameter (real units) in that pattern's patch |
| `setOffset` | `channel`, `id`, `value` | A relative live knob (macro or sound param, -1..1, 0 = centred); the engine sums each knob's push per param (`liveTargets` / `liveContribution` in the registry) on top of the base or locked value |
| `setMix` | `channel`, `id` (`volume` `pan` `mute` `send` `dyn` `gate` `cut`), `value` | Track mixer (`gate` = TRIM, `cut` = MID CUT, `dyn` = ACC/GHOST) |
| `setGlobal` | `id` (`bpm` `swing` `master` `meter`), `value` | Project-wide settings; `meter` changes at the next bar line |
| `setListenLatency` | `ms` | How late the player hears the engine: live recording lands where heard |
| `setRouting` | `channel`, `send` | Send FX 2 / FX 3 (0 = none) |
| `setDrumBus` | `channel`, `on` | Through FX 1, the drum bus |
| `setBus` | `bus` (0-2 = FX 1-3), `id`, `value` | An FX bus parameter (`BUS_PARAMS[bus]` id; real units, TYPE as an index) |
| `setLfo` | `id` (an `LfoState` key), `value` | The shared LFO |
| `setLfoTrack` | `channel`, `on` | A track on / off the LFO |
| `transport` | `playing`, `song?`, `fromRow?` | Start (from step 1) / stop; `song` = play the song from row `fromRow` |
| `setSong` | `song` | Replace the song rows |
| `songJump` | `row` | While the song plays: go to this row at the next bar line |
| `trigger` | `channel`, `note`, `velocity`, `slideFrom?` | Play a note now (`slideFrom` = legato from a held note) |
| `recordNote` | `channel`, `note`, `velocity`, `accent`, `slide?`, `chord?` | Live recording: play now, write to the nearest step (answers `recordedNote` / `recordedChord`) |
| `recordLock` | `channel`, `id`, `value` | Live recording: lock a sound param on the step playing now (answers `recordedLock`) |
| `ping` | `id` | Round-trip probe |

Worklet -> main:
| type | fields | meaning |
|---|---|---|
| `ready` | `sampleRate` | Processor constructed |
| `status` | `peakL`, `peakR`, `frame`, `playing`, `steps[8]`, `patterns[8]`, `barPhase`, `barSteps`, `songRow`, `songBar` | ~30 Hz: meters, playhead and playing pattern per track, position in the bar (`barSteps` = the time signature's bar in 16ths) |
| `pong` | `id` | Answer to `ping` |
| `engineReset` | — | The output went non-finite: the block was muted and a fresh engine started (at most once a second); main resends `loadProject` + `transport` and shows ENGINE RESTARTED. (The host re-fetches the worklet file with `cache: 'reload'` before loading it, since its name is stable across builds.) |
| `recordedNote` | `channel`, `pattern`, `index`, `note`, `velocity`, `accent`, `gate`, `slide`, `start?` | A live-recorded note was written (sent again with its length on release; `start` = it replaced the step's notes) |
| `recordedChord` | `channel`, `pattern`, `index`, `note`, `gate` | PAD / PLUCK: a note played with the recorded one joined its step (`Step.extra`, one step long; sent again with its own length on release) |
| `recordedLock` | `channel`, `pattern`, `index`, `id`, `value` | A recorded lock was written |

The worklet decides where recorded events land because only it knows the exact play position. A note
recorded just before a step is written to that step and its trigger there is skipped once, so it
doesn't sound twice.

No SharedArrayBuffer (static hosting can't set COOP/COEP headers); everything is `postMessage`.

## Project model and storage

The types in `src/engine/project.ts` (`Project`, `ChannelState`, `Pattern`, `Step`, `Patch`, `Song`)
are the reference, with a doc comment on every field; they are not repeated here. Key points:
- `PROJECT_VERSION` is the stored format's version (43 now).
- A pattern being edited keeps its patch in the channel's `sounds` / `trims` / `presets`; the other
  patterns keep theirs in `Pattern.patch`. Read and write through `patchOf` / `setPatchOf` / `editPattern`.
- `sounds` hold resulting values; `trims` hold the SOUND page offsets on top of TIMBRE / INTENSITY
  (`instruments/trims.ts`), so a TIMBRE change keeps them.
- `buses[3]`: each FX bus's settings by `BUS_PARAMS` id (TYPE stored as an index into that bus's list).

Every save and load goes through `src/engine/projectFile.ts`: a compact stored format (only steps with
notes) and a forgiving reader (missing or out-of-range values take defaults, unknown parameters are
dropped, notes are never lost). It reads formats from `OLDEST_EXACT` (40) on exactly; a later format
change adds its migration there, named after the version. An older save still loads its notes, mix and
FX, its sounds as stored (`isOldFormat`; LOAD warns). The v1-v39 migrations were retired in October
2026 (`docs/HISTORY.md`).

`storage/projects.ts` keeps 64 slots behind the `ProjectStore` interface (localStorage now; a native
store in the Capacitor app later): per slot id a saved copy `groovebox.proj.<id>` and a working copy
`groovebox.work.<id>`, the index `groovebox.projects`, the open id `groovebox.open`.

**Cloud slots:** `storage/slotSync.ts` (claude.ai Artifact only, via `claude.use('db')`): collection
`slots`, one document per slot (`slot-01` … `slot-64`) holding `{id, name, savedAt, project}` (stored
format) or a delete marker `{id, deleted: true, deletedAt}`. `planSync(local, cloud, base)` is the pure
merge (unit-tested); `groovebox.sync` keeps each slot's id at the last sync so a replace or delete made
on this device is told apart from one made elsewhere. The working project's single mirror
(`projects/current`) is `cloud.ts`.

## Sequencer

A master 16th-note clock (swing lengthens even steps and shortens odd ones; swing pairs restart each
bar) drives all tracks. Each track keeps its own position and loops at its pattern length (polymeter).
`Engine.process` splits each block at step boundaries (and renders in chunks of up to 64 frames) so
notes start on the exact sample. `Engine.stepChannel` runs a track's step: double time twice per master
step (the second via the sub-step timers `subAt` / `subLeft` / `subPos`), half time on even master steps,
triplet time three steps per beat.

**Time signature and STEPS:** `METERS` give each 16-step bar four groups and how many steps of each
group play; `stepPlays(meter, speed, index, flip)` = the meter's steps, minus the 4th of each group in
triplet time, inverted where `Step.flip` is set. The engine keeps `stepOn` per step slot and walks only
playing steps (`nextOn`, `walkOn` for live recording), so dark steps take no time. Bars are
`meterLength(meter)` master 16ths from `barOrigin`; a TIME SIG change while playing waits for the bar
line (`pendingMeter`). Pattern switches land on bar lines: where the track's loop starts, or for a track
whose loop drifts against the bar (`offGrid`) at the next one, restarting it. Whole-bar LFO rates scale
with the bar.

**Parameter locks:** each step can lock sound parameters (`Step.locks`, kept in a NaN-filled typed
array, `LOCK_SLOTS` per step). A lock is applied just before its step triggers; a parameter locked on
the previous step but not this one reverts to the pattern's own value.

**Pattern patches:** `patchValue` per pattern. `selectPattern` glides from the current patch to the
next pattern's between the prime and the switch (`startGlide` / `stepPatchGlides` per block; coarse
params switch at the landing); song rows glide over the old row's last bar (`glideToRow`).

**Dynamics:** ghost / normal / accent = velocity 0.45 / 0.8 / 1.0, scaled per track by ACC/GHOST
(`dynVelocity`). Each track's output passes a 12 dB low-pass whose cutoff is set per hit from the
velocity (`hitToneCutoff`), so softer hits are also darker; it glides to a new hit's cutoff over 3 ms.

**Notes, gates, chords:** the engine expands each note through the track's chord and NOTES
(`chords.ts`), tagging voices with the root so they release together; PAD and PLUCK steps can also carry their
own notes (`Step.extra`). A sequenced note releases when the step `gate` steps later starts; its last
step is held for the track's TRIM (`gateAt`, sample-accurate). Live notes release on `release`.
PAD / PLUCK notes (`registry.playsChords`; no RING / SLIDE / ARP) are held each by its own length (`Step.gate` / `Step.extraGate`) in a per-track list (`holdNote` / `holdSteps` / `holdAt`, each its own voice group), so later notes don't cut them. RING holds a note until the next hit or REST on the track (drums: long decay; the next hit chokes it).
SLIDE holds the note at full sustain and glides into the next. Drum ROLL runs (`startRollRun`) spread
hits evenly from the first ROLL step's start to the last's end at the sound's ROLL RATE, velocity
ramping across the run.

## Instruments

`src/instruments/registry.ts` maps a track type (`kick` `snare` `hat` `perc` `bass` `pad` `lead`
`pluck`) to its class, `ParamSpec[]`, SOUND page `layout` and FUNC `funcLayout` (16 slots each),
default live knobs, output `gain` and presets. Each channel preallocates one instance of every type.
`ParamSpec.options` marks discrete choices (stored as an index) and `coarse` marks settings that only
switch (never glide, never on a relative live knob).

- **Drum** (`Drum.ts`): layers TONE / body (oscillator + exponential pitch sweep), CLICK (filtered
  transient), METAL (six inharmonic oscillators: square bank, ring-mod pairs or FM, blended with noise),
  summed into tanh DRIVE, CRUSH (sample-rate reduction on a fractional clock + bit reduction) and OUT
  GAIN. Each type uses two elements (`DrumVoice.balance`); PERC adds the metal tuned between them
  (`relative`). The played note retunes the pitched layers. RING adds the type's fixed extension
  (`ringExtra`). A retrigger fades the old hit's last output over 3 ms.
- **Synth** (`Synth.ts`): up to 6 voices (oldest stolen; `voices` limits it, LEAD 3; `voice: 1` = mono
  BASS), two polyBLEP oscillators with SHAPE (sine -> triangle -> saw -> square), detune, unison, sine
  sub, per-voice SVF low-pass with its own envelope, an FM envelope (`fmattack` / `fmdecay`: the FM
  index of every algorithm swings with it), ADSR per oscillator (`envlink` = one for both: BASS,
  PLUCK), DRIVE / CRUSH / OUT GAIN. `algo` 0 (BASS, PLUCK): an FM pair (BASS: root-locked ratio
  ladder via `cratio` / `fmratio`). `algo` 1 (LEAD): a sine modulator with DX7-style feedback
  phase-modulating three carriers (1 / RATIO 2 / RATIO 3; `dx7Index` level curve). `algo` 2 (PAD): two
  stacks (carrier 1 under FM RATIO + FEEDBACK; a carrier at RATIO 2 under RATIO 3, mixed in by CARRIERS, which INTENSITY sets; no CRUSH), DC blocker at 8 Hz.
  PLUCK runs an onboard delay + room (`Instrument.post`); BASS ducks from KICK hits
  (`Instrument.duck`). The engine's ARP (`arp` / `arprate` / `arpoct`) is still there, but no type
  lists those params now.

**Macros** (`macros.ts`): each type defines five anchor sounds and an INTENSITY excite list.
`macroSound(kind, timbre, intensity)` blends the two neighbouring anchors on each parameter's own curve
(log for frequencies / times), snaps FM ratios (`RATIO_SNAP`, `RATIO_LADDER`), then applies INTENSITY
(below 0.5 towards each excite param's floor, above x high, some through a knee). The UI adds the trims
(`trims.ts`) and sends the result as `setSound`.

**Live knobs:** registry `LIVE_MACROS` (several params per knob) or single params; relative, applied
in the engine (`setOffset`), clamped at each parameter's limits.

## Buses and master

Three `FxBus`es (defined in `fx/buses.ts`). Each is four units of two knob modules; an effect unit has
VOLUME (its return level, smoothed; at 0 it fades for 0.15 s and is then skipped, starting clean when
turned up) over TYPE (a change fades the unit out for 15 ms, switches mode, resets and fades back in)
and two controls. The effects (`fx/units.ts`) write their wet signal into a scratch buffer; the bus
scales and sums them:
- **FX 1** (an insert): tracks with `fx1` are summed into it instead of the mix; they go through
  `Compressor` (series, RATIO 1:1 = off) and on to the mix, and MOD (FLANGER, PHASER), DELAY (TAPE,
  SWEEP, REVERSE) and VERB (ROOM, PLATE, EARLY) return alongside at their VOLUMEs.
- **FX 2 / FX 3** (sends): a track feeds at most one, post-fader, by its send level; only the returns
  reach the mix, through TONE: LOW CUT / HI CUT (12 dB SVFs) and ducking (FX 2 PUMP: every KICK hit,
  `FxBus.kick` from `Engine.kickHit`; FX 3 DUCK: a peak follower on the bus input).
- Units: `ModFx` (CHORUS, ENSEMBLE, FLANGER, PHASER; RATE in Hz), `DelayFx` (STEREO, PING-PONG, TAPE,
  DUB TAPE, SWEEP, REVERSE, SLAPBACK; RATE = `FX_DELAY_TIMES`, tempo-synced, FEEDBACK up to 1.1 into
  tanh), `VerbFx` (Freeverb combs stretched by SIZE (fractional while moving, whole samples at rest):
  ROOM, HALL, PLATE (diffused input); EARLY (a tap line), SHIMMER (octave-up feedback), SPRING
  (dispersion loop)), `DriveFx` (TUBE, FUZZ, BIT).
- A send with nothing in or out for 5 s is skipped altogether.

Each track has its own MID CUT (`TrackCut`: 18 dB peaking cut at the sound's MID FREQ, after the
instrument's DRIVE and onboard FX).

The master runs MASTER (x sqrt2 to undo the centre pan law) and the `Limiter` (look-ahead peak limiter,
-1 dBFS ceiling, 1.5 ms look-ahead = `Engine.latency`, 80 ms release; clean below the ceiling).

**LFO** (`lfo.ts`): one LFO shared by the tracks with `lfoOn`, on a clock in 16th steps (reset on PLAY),
phase-locked to the song; per chunk it fills a buffer of values per member track (rate, shape + MORPH,
PHASE + SPREAD per track, RETRIG from the track's last note, SMOOTH, FADE IN). VOL, PAN and SEND MOD
act per sample; PITCH, FILTER and FM MOD call `Instrument.setPitchMod` / `setFilterMod` / `setFmMod`
once per chunk.

## UI

`Panel` (a ControlSurface) emits button ids `mode:record|play|design|song`, `ch1..8`, `mute1..8`,
`solo1..8`, `dpage0..2`, `fx1..4` (4 = LFO), `save`, `saveproject`, `reset`, `patA..D`, the function
row (`ring`, `slide`, `dyn:accent`, `dyn:ghost`, `len`, `steppage`, `clear`, `copy`, `oct-`, `oct+`,
`cur-`, `cur+`, `rest`), `step1..16`, `play`, `func`; knobs `k1..k16` (k1-k8 top row, k9-k16 bottom;
module n = k(n) over k(n+8)) and master knobs `mtempo`, `mmaster`. Knobs send absolute values (0-127,
270°); `ControlEvent` also has `encoder` (relative detents) for hardware, which the mouse wheel uses.

`App` maps events onto the project and the engine: each knob resolves to a `KnobTarget` for the current
mode / page / bus (`computeTargets`), and it builds the screen view-models (`views.ts`: live view,
design view, song view, project menu). `PixelScreen` records each frame's drawing and only redraws when
it changed, with text from cached glyph canvases. On portrait screens `Panel.fit` rotates the panel 90°
and `orientation.ts` keeps knob drags in panel coordinates. Audio starts on the first touch / click / key
(browsers require a gesture); until then the footer says TOUCH FOR SOUND.

## Parameters

Each instrument / effect exposes `ParamSpec[]` (`id`, `name`, `min`, `max`, `defaultValue`, `unit`,
`curve`: linear / exp / square / power). Controls emit normalised 0..1; `toValue` / `toNorm` convert.
Engine-side changes go through one-pole `Smoother`s.

## Audio-thread rules

No allocation in `process()` or per block, no logging, no blocking, denormal-prone state snapped to
zero, status object reused. The worklet is bundled by Vite (`?worker&url`, IIFE) into one
self-contained script. A non-finite output mutes the block and restarts the engine (`engineReset`).

## Deployment

`.github/workflows/deploy.yml` runs tests, `npm run unused` and the build, and publishes `dist/` to the
`gh-pages` branch (GitHub Pages is not switched on for the repo, so that site is not live). Vite uses
`base: './'` so the build works from any sub-path. The app people use is the claude.ai Artifact. `npm run build:artifact` builds the single-file
claude.ai Artifact (`dist-artifact/`). `public/sw.js` is a network-first service worker (installable,
offline fallback).
